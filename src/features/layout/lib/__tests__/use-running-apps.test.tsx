import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { useRunningApps } from "../use-running-apps"

const mocks = vi.hoisted(() => ({
  browser: vi.fn(() => Promise.resolve("Google Chrome")),
  read: vi.fn(),
  running: vi.fn(),
  error: vi.fn(),
  focus: null as null | (() => void)
}))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }))
vi.mock("@tauri-apps/api/window", async () => {
  // 生产代码用窗口级 API（`getCurrentWindow`）：子 webview 有焦点时 `getCurrentWebviewWindow()`
  // 会抛 "current webview is not a WebviewWindow"。测试里两者指向同一个假窗口。
  const webviewWindow = await import("@tauri-apps/api/webviewWindow")
  return { ...webviewWindow, getCurrentWindow: () => webviewWindow.getCurrentWebviewWindow() }
})

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onFocusChanged: (callback: () => void) => {
      mocks.focus = callback
      return Promise.resolve(() => {})
    }
  })
}))
vi.mock("@/bindings", () => ({
  commands: {
    defaultBrowser: mocks.browser,
    readAppsInfo: mocks.read,
    isAppRunning: mocks.running
  }
}))
vi.mock("@/lib/background-errors", () => ({ reportBackgroundError: mocks.error }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const chrome = { name: "Google Chrome", bundle_id: "com.google.Chrome", icon: "data:image/png;base64,test" }
const lark = { name: "Lark", bundle_id: "com.lark", icon: null }

test("shows only running applications in browser-first order and retains native icons", async () => {
  mocks.read.mockImplementation(({ names }: { names: string[] }) =>
    Promise.resolve(names[0] === "Google Chrome" ? [chrome] : [lark])
  )
  mocks.running.mockImplementation(({ bundleId }: { bundleId: string }) =>
    Promise.resolve(bundleId === chrome.bundle_id)
  )
  const { result } = renderHook(() => useRunningApps(true))
  await waitFor(() => expect(result.current).toEqual([chrome]))
  mocks.running.mockResolvedValue(true)
  act(() => mocks.focus?.())
  await waitFor(() => expect(result.current).toEqual([chrome, lark]))
  mocks.running.mockResolvedValue(false)
  act(() => mocks.focus?.())
  await waitFor(() => expect(result.current).toEqual([]))
})

test("deduplicates browser and communication candidates by native identity", async () => {
  mocks.read.mockResolvedValue([chrome])
  mocks.running.mockResolvedValue(true)
  const { result } = renderHook(() => useRunningApps(true))
  await waitFor(() => expect(result.current).toEqual([chrome]))
  expect(mocks.running).toHaveBeenCalledTimes(1)
})
