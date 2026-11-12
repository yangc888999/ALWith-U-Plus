import { beforeEach, expect, test, vi } from "vitest"

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(null) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))

const key = "chat.overload-429-reminder-enabled"

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  invoke.mockClear()
})

test("enabling disabled alerts enables silent native retries and disabling restores alerts", async () => {
  const settings = await import("../overload-429-settings")
  expect(settings.overload429ReminderDisabled()).toBe(false)
  expect(invoke).toHaveBeenLastCalledWith("set_overload_429_mute", { mute: false })
  const listener = vi.fn()
  const stop = settings.subscribeOverload429ReminderDisabled(listener)
  settings.setOverload429ReminderDisabled(true)
  expect(settings.overload429ReminderDisabled()).toBe(true)
  expect(localStorage.getItem(key)).toBe("false")
  expect(invoke).toHaveBeenLastCalledWith("set_overload_429_mute", { mute: true })
  expect(listener).toHaveBeenCalledTimes(1)
  settings.setOverload429ReminderDisabled(false)
  expect(localStorage.getItem(key)).toBe("true")
  expect(invoke).toHaveBeenLastCalledWith("set_overload_429_mute", { mute: false })
  stop()
})

test.each([ ["true", false], ["false", true] ] as const)("preserves stored reminder preference %s", async (stored, disabled) => {
  localStorage.setItem(key, stored)
  const settings = await import("../overload-429-settings")
  expect(settings.overload429ReminderDisabled()).toBe(disabled)
  expect(invoke).toHaveBeenLastCalledWith("set_overload_429_mute", { mute: disabled })
})

test("another window's change updates the native retry switch immediately", async () => {
  const settings = await import("../overload-429-settings")
  const listener = vi.fn()
  const stop = settings.subscribeOverload429ReminderDisabled(listener)
  localStorage.setItem(key, "false")
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: "false" }))
  expect(settings.overload429ReminderDisabled()).toBe(true)
  expect(invoke).toHaveBeenLastCalledWith("set_overload_429_mute", { mute: true })
  expect(listener).toHaveBeenCalledTimes(1)
  stop()
})
