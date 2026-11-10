import { beforeEach, expect, test, vi } from "vitest"

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(() => Promise.resolve())
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))

beforeEach(() => {
  localStorage.clear()
  invokeMock.mockClear()
  vi.resetModules()
})

function applyElsewhere(value: string | null) {
  if (value === null) localStorage.removeItem("chat.overload-notice-enabled")
  else localStorage.setItem("chat.overload-notice-enabled", value)
  window.dispatchEvent(new StorageEvent("storage", { key: "chat.overload-notice-enabled", newValue: value }))
}

test("the setting is enabled by default, so notices remain visible", async () => {
  const mod = await import("../overload-retry-settings")
  expect(mod.overloadNoticeEnabled()).toBe(true)
  expect(invokeMock).toHaveBeenCalledWith("set_overload_mute", { mute: false })
})

test("a settings-window change reaches a running chat without reload", async () => {
  const mod = await import("../overload-retry-settings")
  const seen: boolean[] = []
  mod.subscribeOverloadNoticeEnabled(() => seen.push(mod.overloadNoticeEnabled()))
  applyElsewhere("false")
  expect(mod.overloadNoticeEnabled()).toBe(false)
  expect(seen).toEqual([false])
})

test("an unrelated key does not republish the switch", async () => {
  const mod = await import("../overload-retry-settings")
  const listener = vi.fn()
  mod.subscribeOverloadNoticeEnabled(listener)
  window.dispatchEvent(new StorageEvent("storage", { key: "chat.something-else", newValue: "1" }))
  expect(listener).not.toHaveBeenCalled()
  expect(mod.overloadNoticeEnabled()).toBe(true)
})

test("turning the reminder off mutes overloads in the bridge", async () => {
  const mod = await import("../overload-retry-settings")
  mod.setOverloadNoticeEnabled(false)
  expect(invokeMock).toHaveBeenLastCalledWith("set_overload_mute", { mute: true })
  mod.setOverloadNoticeEnabled(true)
  expect(invokeMock).toHaveBeenLastCalledWith("set_overload_mute", { mute: false })
})
