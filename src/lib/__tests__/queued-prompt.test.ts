import { expect, test } from "vitest"

import {
  beginQueuedPrompt,
  cancelQueuedPrompt,
  clearQueuedPrompts,
  deleteQueuedPrompt,
  editQueuedPrompt,
  endQueuedPrompt,
  jumpQueuedPrompt,
  moveQueuedPrompt,
  pauseQueuedPrompts,
  resumeQueuedPrompts,
  queuedPromptCount,
  queuedPromptHead,
  queuedPromptItems,
  queuedPromptPaused,
  queuedPromptRevision,
  setQueuedPromptDispatching,
  subscribeQueuedPrompts
} from "../queued-prompt"

test("queued entries are counted per session and expose their rows in send order", () => {
  const a = beginQueuedPrompt("s1", "first")
  const b = beginQueuedPrompt("s1", "second")
  beginQueuedPrompt("s2", null)

  expect(queuedPromptCount("s1")).toBe(2)
  expect(queuedPromptItems("s1").map((item) => item.text)).toEqual(["first", "second"])
  expect(queuedPromptHead("s1", a)).toBe(true)
  expect(queuedPromptHead("s1", b)).toBe(false)
  expect(queuedPromptCount("s2")).toBe(1)
  expect(queuedPromptItems("s2")[0]?.text).toBeNull()

  // Sending the oldest drops only that entry; the newer one keeps waiting.
  endQueuedPrompt("s1", a)
  expect(queuedPromptCount("s1")).toBe(1)
  expect(queuedPromptItems("s1").map((item) => item.text)).toEqual(["second"])
  expect(queuedPromptHead("s1", b)).toBe(true)

  cancelQueuedPrompt("s1")
  cancelQueuedPrompt("s2")
  expect(queuedPromptCount("s1")).toBe(0)
  expect(queuedPromptItems("s1")).toEqual([])
})

test("cancelling marks every waiting message so the dispatch loop gives up", () => {
  const first = beginQueuedPrompt("s3", "one")
  const second = beginQueuedPrompt("s3", "two")
  cancelQueuedPrompt("s3")
  expect(first.cancelled).toBe(true)
  expect(second.cancelled).toBe(true)
  // Ending an entry that was already cleared stays a no-op.
  endQueuedPrompt("s3", first)
  expect(queuedPromptCount("s3")).toBe(0)
})

test("one row can be moved back for editing without touching the rest of the queue", () => {
  const first = beginQueuedPrompt("s5", "first")
  const second = beginQueuedPrompt("s5", "second")
  cancelQueuedPrompt("s5", first.id)
  expect(first.cancelled).toBe(true)
  expect(second.cancelled).toBe(false)
  expect(queuedPromptItems("s5").map((item) => item.id)).toEqual([second.id])
  expect(queuedPromptHead("s5", second)).toBe(true)
  cancelQueuedPrompt("s5")
})

test("deleting one row marks it removed and leaves no visible entry", () => {
  const first = beginQueuedPrompt("s6", "first")
  const second = beginQueuedPrompt("s6", "second")
  deleteQueuedPrompt("s6", first.id)
  expect(first.removed).toBe(true)
  expect(second.removed).toBe(false)
  expect(queuedPromptItems("s6").map((item) => item.id)).toEqual([second.id])
  deleteQueuedPrompt("s6", second.id)
  expect(queuedPromptCount("s6")).toBe(0)
})

test("moving a row changes which message dispatches first", () => {
  const first = beginQueuedPrompt("s7", "first")
  const second = beginQueuedPrompt("s7", "second")
  const third = beginQueuedPrompt("s7", "third")
  moveQueuedPrompt("s7", third.id, first.id)
  expect(queuedPromptItems("s7").map((item) => item.text)).toEqual(["third", "first", "second"])
  expect(queuedPromptHead("s7", third)).toBe(true)
  expect(queuedPromptHead("s7", first)).toBe(false)
  expect(queuedPromptHead("s7", second)).toBe(false)
  cancelQueuedPrompt("s7")
})

test("a row can be edited in place without losing its position or image", () => {
  const first = beginQueuedPrompt("s8", "first", {
    body: "first\nsecond line",
    image: "data:image/png;base64,thumb",
    imageCount: 2
  })
  beginQueuedPrompt("s8", "another")
  expect(editQueuedPrompt("s8", first.id, "first edited\nsecond line")).toBe(true)
  expect(first.body).toBe("first edited\nsecond line")
  expect(first.text).toBe("first edited")
  expect(first.imageCount).toBe(2)
  expect(queuedPromptItems("s8")[0]).toMatchObject({
    id: first.id,
    text: "first edited",
    body: "first edited\nsecond line",
    image: "data:image/png;base64,thumb",
    imageCount: 2
  })
  expect(queuedPromptHead("s8", first)).toBe(true)
  cancelQueuedPrompt("s8")
})

test("jumping sends one row immediately, while a refused jump moves it to the head", async () => {
  const sent = beginQueuedPrompt("s9", "send now", { jump: async () => "sent" })
  const queued = beginQueuedPrompt("s9", "keep queued", { jump: async () => "queued" })
  await expect(jumpQueuedPrompt("s9", sent.id)).resolves.toBe("sent")
  expect(sent.removed).toBe(true)
  expect(queuedPromptItems("s9").map((item) => item.id)).toEqual([queued.id])
  const third = beginQueuedPrompt("s9", "third", { jump: async () => "queued" })
  await expect(jumpQueuedPrompt("s9", third.id)).resolves.toBe("queued")
  expect(queuedPromptItems("s9").map((item) => item.id)).toEqual([third.id, queued.id])
  expect(third.jumping).toBe(false)
  cancelQueuedPrompt("s9")
})

test("a jump that finishes after queue mutations never restores a stale list", async () => {
  let finish: ((result: "queued") => void) | undefined
  const jumping = beginQueuedPrompt("s10", "jump", {
    jump: () => new Promise((resolve) => { finish = resolve })
  })
  const old = beginQueuedPrompt("s10", "old")
  const pending = jumpQueuedPrompt("s10", jumping.id)
  deleteQueuedPrompt("s10", old.id)
  const fresh = beginQueuedPrompt("s10", "fresh")
  finish?.("queued")
  await pending
  expect(queuedPromptItems("s10").map((item) => item.id)).toEqual([jumping.id, fresh.id])
  cancelQueuedPrompt("s10")
})

test("cancelling the queue while a jump is in flight does not resurrect its rows", async () => {
  let finish: ((result: "queued") => void) | undefined
  const jumping = beginQueuedPrompt("s11", "jump", {
    jump: () => new Promise((resolve) => { finish = resolve })
  })
  const pending = jumpQueuedPrompt("s11", jumping.id)
  cancelQueuedPrompt("s11")
  finish?.("queued")
  await pending
  expect(queuedPromptCount("s11")).toBe(0)
})

test("pausing keeps every row, new rows inherit the pause, and resuming clears it", () => {
  const first = beginQueuedPrompt("s12", "first")
  const second = beginQueuedPrompt("s12", "second")
  pauseQueuedPrompts("s12", "stop")
  expect(queuedPromptPaused("s12")).toBe(true)
  expect(queuedPromptItems("s12").every((item) => item.paused && item.pauseReason === "stop")).toBe(true)
  const third = beginQueuedPrompt("s12", "third")
  expect(third.paused).toBe(true)
  expect(third.pauseReason).toBe("stop")
  expect(queuedPromptCount("s12")).toBe(3)
  resumeQueuedPrompts("s12")
  expect(queuedPromptPaused("s12")).toBe(false)
  expect(queuedPromptItems("s12").every((item) => !item.paused && item.pauseReason === null)).toBe(true)
  expect(first.paused).toBe(false)
  expect(second.paused).toBe(false)
  clearQueuedPrompts("s12")
  expect(queuedPromptCount("s12")).toBe(0)
})

test("a failed jump releases the row controls and keeps the message queued", async () => {
  const item = beginQueuedPrompt("s14", "retry me", {
    jump: async () => {
      throw new Error("steerActiveTurn 超时（15000ms）")
    }
  })
  await expect(jumpQueuedPrompt("s14", item.id)).rejects.toThrow("超时")
  expect(item.jumping).toBe(false)
  expect(queuedPromptItems("s14").map((row) => row.id)).toEqual([item.id])
  cancelQueuedPrompt("s14")
})

test("only one jump can be in flight for a session", async () => {
  let finish: ((result: "sent") => void) | undefined
  let secondJumps = 0
  const first = beginQueuedPrompt("s15", "first", {
    jump: () => new Promise((resolve) => { finish = resolve })
  })
  const second = beginQueuedPrompt("s15", "second", {
    jump: async () => {
      secondJumps += 1
      return "queued"
    }
  })
  const pending = jumpQueuedPrompt("s15", first.id)
  await expect(jumpQueuedPrompt("s15", second.id)).resolves.toBe("queued")
  expect(secondJumps).toBe(0)
  finish?.("sent")
  await pending
  expect(queuedPromptItems("s15").map((item) => item.id)).toEqual([second.id])
  cancelQueuedPrompt("s15")
})

test("a dispatching row is locked and cannot be cleared mid-flight", () => {
  const first = beginQueuedPrompt("s16", "first")
  const second = beginQueuedPrompt("s16", "second")
  setQueuedPromptDispatching("s16", first.id, true)
  expect(queuedPromptItems("s16")[0]?.dispatching).toBe(true)
  expect(editQueuedPrompt("s16", first.id, "changed")).toBe(false)
  deleteQueuedPrompt("s16", first.id)
  moveQueuedPrompt("s16", second.id, first.id)
  clearQueuedPrompts("s16")
  expect(queuedPromptItems("s16").map((item) => item.id)).toEqual([first.id, second.id])
  setQueuedPromptDispatching("s16", first.id, false)
  expect(queuedPromptItems("s16")[0]?.dispatching).toBe(false)
  cancelQueuedPrompt("s16")
})

test("edit, delete and reorder are locked while a row is jumping", async () => {
  let finish: ((result: "queued") => void) | undefined
  const first = beginQueuedPrompt("s13", "first", {
    jump: () => new Promise((resolve) => { finish = resolve })
  })
  const second = beginQueuedPrompt("s13", "second")
  const pending = jumpQueuedPrompt("s13", first.id)
  expect(editQueuedPrompt("s13", first.id, "edited")).toBe(false)
  deleteQueuedPrompt("s13", first.id)
  moveQueuedPrompt("s13", second.id, first.id)
  expect(queuedPromptItems("s13").map((item) => item.id)).toEqual([first.id, second.id])
  finish?.("queued")
  await pending
  cancelQueuedPrompt("s13")
})

test("listeners and revisions hear about every change, and unsubscribe cleanly", () => {
  let calls = 0
  const stop = subscribeQueuedPrompts(() => {
    calls += 1
  })
  const before = queuedPromptRevision("s4")
  const entry = beginQueuedPrompt("s4", "hello")
  expect(queuedPromptRevision("s4")).toBeGreaterThan(before)
  endQueuedPrompt("s4", entry)
  stop()
  beginQueuedPrompt("s4", "ignored")
  expect(calls).toBe(2)
  cancelQueuedPrompt("s4")
})
