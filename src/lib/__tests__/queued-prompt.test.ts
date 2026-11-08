import { expect, test } from "vitest"

import {
  beginQueuedPrompt,
  cancelQueuedPrompt,
  endQueuedPrompt,
  queuedPromptCount,
  queuedPromptText,
  subscribeQueuedPrompts
} from "../queued-prompt"

test("queued entries are counted per session and expose the oldest message", () => {
  const a = beginQueuedPrompt("s1", "first")
  beginQueuedPrompt("s1", "second")
  beginQueuedPrompt("s2", null)

  expect(queuedPromptCount("s1")).toBe(2)
  expect(queuedPromptText("s1")).toBe("first")
  expect(queuedPromptCount("s2")).toBe(1)
  expect(queuedPromptText("s2")).toBeNull()

  // Sending the oldest drops only that entry; the newer one keeps waiting.
  endQueuedPrompt("s1", a)
  expect(queuedPromptCount("s1")).toBe(1)
  expect(queuedPromptText("s1")).toBe("second")

  cancelQueuedPrompt("s1")
  cancelQueuedPrompt("s2")
  expect(queuedPromptCount("s1")).toBe(0)
  expect(queuedPromptText("s1")).toBeNull()
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

test("listeners hear about every change, and unsubscribe cleanly", () => {
  let calls = 0
  const stop = subscribeQueuedPrompts(() => {
    calls += 1
  })
  const entry = beginQueuedPrompt("s4", "hello")
  endQueuedPrompt("s4", entry)
  stop()
  beginQueuedPrompt("s4", "ignored")
  expect(calls).toBe(2)
  cancelQueuedPrompt("s4")
})
