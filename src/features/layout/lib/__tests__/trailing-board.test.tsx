import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { TrailingBoard } from "../../components/trailing-board"
import { CanvasContext } from "../canvas-context"

const open = vi.hoisted(() => vi.fn(() => Promise.resolve()))
/** Mutable per-test running-app list: the empty-state case needs zero cards. */
const running = vi.hoisted(() => ({
  apps: [{ name: "Google Chrome", bundle_id: "com.google.Chrome", icon: null }] as Array<{
    name: string
    bundle_id: string
    icon: string | null
  }>
}))
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
  useRunningApps: () => running.apps
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
beforeEach(() => {
  running.apps = [{ name: "Google Chrome", bundle_id: "com.google.Chrome", icon: null }]
})
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

/** The apps screen used to be a bare card list on a black pane with no way back to the chat. */
function canvasValue(navigate: (region: "chat" | "preview" | "trailing") => void) {
  return {
    viewportWidth: 1200,
    budget: 952,
    selected: 2,
    trailingActive: true,
    split: false,
    moving: false,
    setWorkspace: () => {},
    navigate,
    setDividerDragging: () => {}
  }
}

test("the apps screen shows a title and a description, with no stray back-to-chat control", () => {
  const navigate = vi.fn()
  render(
    <CanvasContext.Provider value={canvasValue(navigate)}>
      <TrailingBoard />
    </CanvasContext.Provider>
  )
  expect(screen.getByRole("heading", { name: "canvas.appsTitle" })).toBeVisible()
  expect(screen.getByText("canvas.appsDescription")).toBeVisible()
  expect(screen.queryByText("canvas.appsEmpty")).not.toBeInTheDocument()
  // The rail and the canvas dots are the way back; a button floating in the header read as a
  // stray control over the screen (2026-11-19), so it must stay gone.
  expect(screen.queryByRole("button", { name: "canvas.backToChat" })).not.toBeInTheDocument()
  expect(navigate).not.toHaveBeenCalled()
})

test("an empty apps screen explains itself instead of rendering a blank pane", async () => {
  running.apps = []
  render(
    <CanvasContext.Provider value={canvasValue(() => {})}>
      <TrailingBoard />
    </CanvasContext.Provider>
  )
  expect(await screen.findByText("canvas.appsEmpty")).toBeVisible()
  // The header survives the empty list: the pane still explains where the reader is.
  expect(screen.getByRole("heading", { name: "canvas.appsTitle" })).toBeVisible()
  expect(screen.getByText("canvas.appsDescription")).toBeVisible()
})
