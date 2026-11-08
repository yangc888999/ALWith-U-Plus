import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { TrailingBoard } from "../../components/trailing-board"

const open = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock("@/lib/chat-window", () => ({ openChatWindow: vi.fn() }))
vi.mock("@/lib/background-errors", () => ({ reportBackgroundError: vi.fn() }))
vi.mock("@/bindings", () => ({
  commands: {
    openAppById: open,
    chromeExtensionInstalled: () => Promise.resolve(false),
    chromeBridgeInstalled: () => Promise.resolve(false),
    setChromeBridgeEnabled: () => Promise.resolve(null)
  }
}))
vi.mock("../use-running-apps", () => ({
  useRunningApps: () => [{ name: "Google Chrome", bundle_id: "com.google.Chrome", icon: null }]
}))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }))
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }))
vi.mock("@tauri-apps/api/window", async () => {
  // 生产代码用窗口级 API（`getCurrentWindow`）：子 webview 有焦点时 `getCurrentWebviewWindow()`
  // 会抛 "current webview is not a WebviewWindow"。测试里两者指向同一个假窗口。
  const webviewWindow = await import("@tauri-apps/api/webviewWindow")
  return { ...webviewWindow, getCurrentWindow: () => webviewWindow.getCurrentWebviewWindow() }
})

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getAll: () => Promise.resolve([]) },
  getCurrentWebviewWindow: () => ({ onFocusChanged: () => Promise.resolve(() => {}) })
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test("Chrome card opens the browser while its corner badge opens the bridge guide", async () => {
  render(<TrailingBoard />)
  fireEvent.click(screen.getByRole("button", { name: "Google Chrome" }))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ bundleId: "com.google.Chrome" }))
  expect(screen.queryByRole("switch")).not.toBeInTheDocument()
  open.mockClear()
  fireEvent.click(screen.getByRole("button", { name: "chromeBridge.enableBridge" }))
  expect(await screen.findByRole("switch", { name: "chromeBridge.enableBridge" })).toBeVisible()
  expect(screen.getByText("chromeBridge.extOff")).toBeVisible()
  expect(screen.getByText("chromeBridge.bridgeOff")).toBeVisible()
  expect(open).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "chromeBridge.bringToFront" }))
  await waitFor(() => expect(open).toHaveBeenCalledWith({ bundleId: "com.google.Chrome" }))
})
