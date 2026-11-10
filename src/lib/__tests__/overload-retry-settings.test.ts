import { beforeEach, expect, test, vi } from "vitest"

beforeEach(() => {
  localStorage.clear()
  // A fresh module per test also resets the cached value and the listener set.
  vi.resetModules()
})

/** The settings window is a separate webview: Apply lands here only as a storage event. */
function applyElsewhere(value: string | null) {
  if (value === null) localStorage.removeItem("chat.overload-retry-count")
  else localStorage.setItem("chat.overload-retry-count", value)
  window.dispatchEvent(
    new StorageEvent("storage", { key: "chat.overload-retry-count", newValue: value })
  )
}

test("an Apply in the settings window reaches a running chat without a reload", async () => {
  const mod = await import("../overload-retry-settings")
  const seen: number[] = []
  mod.subscribeOverloadRetryCount(() => seen.push(mod.overloadRetryCount()))
  applyElsewhere("9")
  expect(mod.overloadRetryCount()).toBe(9)
  expect(seen).toEqual([9])
})

test("an unrelated key does not republish the retry count", async () => {
  const mod = await import("../overload-retry-settings")
  const listener = vi.fn()
  mod.subscribeOverloadRetryCount(listener)
  window.dispatchEvent(new StorageEvent("storage", { key: "chat.something-else", newValue: "1" }))
  expect(listener).not.toHaveBeenCalled()
  expect(mod.overloadRetryCount()).toBe(mod.DEFAULT_OVERLOAD_RETRY_COUNT)
})

test("clearing the stored value falls back to the default", async () => {
  const mod = await import("../overload-retry-settings")
  mod.setOverloadRetryCount(9)
  applyElsewhere(null)
  expect(mod.overloadRetryCount()).toBe(mod.DEFAULT_OVERLOAD_RETRY_COUNT)
})
