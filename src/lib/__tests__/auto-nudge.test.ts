import { beforeEach, expect, test, vi } from "vitest"

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

function applyElsewhere(value: string | null) {
  if (value === null) localStorage.removeItem("chat.auto-nudge-enabled")
  else localStorage.setItem("chat.auto-nudge-enabled", value)
  window.dispatchEvent(new StorageEvent("storage", { key: "chat.auto-nudge-enabled", newValue: value }))
}

test("nudging a silent turn is on by default", async () => {
  const mod = await import("../auto-nudge")
  expect(mod.autoNudgeEnabled()).toBe(true)
  // Purely a renderer preference: nothing is written anywhere until the reader turns it off.
  expect(localStorage.getItem("chat.auto-nudge-enabled")).toBeNull()
})

test("turning it off persists to the documented key and notifies subscribers", async () => {
  const mod = await import("../auto-nudge")
  const listener = vi.fn()
  mod.subscribeAutoNudge(listener)
  mod.setAutoNudgeEnabled(false)
  expect(mod.autoNudgeEnabled()).toBe(false)
  expect(localStorage.getItem("chat.auto-nudge-enabled")).toBe("false")
  expect(listener).toHaveBeenCalledTimes(1)

  const unsubscribed = vi.fn()
  const off = mod.subscribeAutoNudge(unsubscribed)
  off()
  mod.setAutoNudgeEnabled(true)
  expect(unsubscribed).not.toHaveBeenCalled()
})

test("a change made in the settings window reaches a running chat", async () => {
  const mod = await import("../auto-nudge")
  const seen: boolean[] = []
  mod.subscribeAutoNudge(() => seen.push(mod.autoNudgeEnabled()))
  applyElsewhere("false")
  expect(mod.autoNudgeEnabled()).toBe(false)
  expect(seen).toEqual([false])
})

test("an unrelated storage event does not republish the switch", async () => {
  const mod = await import("../auto-nudge")
  const listener = vi.fn()
  mod.subscribeAutoNudge(listener)
  window.dispatchEvent(new StorageEvent("storage", { key: "chat.overload-notice-enabled", newValue: "false" }))
  expect(listener).not.toHaveBeenCalled()
  expect(mod.autoNudgeEnabled()).toBe(true)
})
