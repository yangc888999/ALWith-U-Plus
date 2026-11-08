import type { WebviewWindow } from "@tauri-apps/api/webviewWindow"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const host = vi.hoisted(() => ({
  mac: false,
  existing: false,
  creationError: null as string | null,
  create: vi.fn<(label: string, options: ConstructorParameters<typeof WebviewWindow>[1]) => void>(),
  show: vi.fn(),
  focus: vi.fn(),
  destroy: vi.fn(),
  attach: vi.fn(),
  emit: vi.fn()
}))
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => (host.mac ? "macos" : "windows") }))
vi.mock("../platform", () => ({ isMac: () => host.mac }))
vi.mock("../i18n", () => ({ default: { t: () => "Settings" } }))
vi.mock("@/bindings", () => ({ commands: { attachWindowToMain: host.attach } }))
vi.mock("@tauri-apps/api/event", () => ({ emitTo: host.emit }))
vi.mock("@tauri-apps/api/window", async () => {
  // 生产代码用窗口级 API（`getCurrentWindow`）：子 webview 有焦点时 `getCurrentWebviewWindow()`
  // 会抛 "current webview is not a WebviewWindow"。测试里两者指向同一个假窗口。
  const webviewWindow = await import("@tauri-apps/api/webviewWindow")
  return { ...webviewWindow, getCurrentWindow: () => webviewWindow.getCurrentWebviewWindow() }
})

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    constructor(label: string, options: ConstructorParameters<typeof WebviewWindow>[1]) {
      host.create(label, options)
    }
    static getByLabel() {
      return Promise.resolve(
        host.existing ? { show: host.show, setFocus: host.focus, destroy: host.destroy } : null
      )
    }
    show = host.show
    setFocus = host.focus
    once(event: string, handler: (event: { payload: string }) => void) {
      return Promise.try(() => {
        if (event === (host.creationError === null ? "tauri://created" : "tauri://error"))
          handler({ payload: host.creationError ?? "" })
        return () => {}
      })
    }
  }
}))
import { openSettingsWindow } from "../window-manager"

beforeEach(() => {
  vi.clearAllMocks()
  host.mac = false
  host.existing = false
  host.creationError = null
  document.documentElement.style.setProperty("--background", "white")
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillStyle: "",
    fillRect: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) })
  } as unknown as CanvasRenderingContext2D)
})
afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.style.removeProperty("--background")
})

test("Windows settings retains native window decorations", async () => {
  await openSettingsWindow("general")
  expect(host.create).toHaveBeenCalledWith(
    "settings",
    expect.objectContaining({
      url: "/settings.html?tab=general",
      // The settings window is resizable now; the size floor keeps the layout usable.
      resizable: true,
      minWidth: 720,
      minHeight: 620,
      maximizable: false,
      minimizable: false
    })
  )
  expect(host.create.mock.calls[0]?.[1]?.decorations).not.toBe(false)
})

test("macOS settings retains its overlay title bar and starts hidden for native attachment", async () => {
  host.mac = true
  await openSettingsWindow()
  expect(host.create).toHaveBeenCalledWith(
    "settings",
    expect.objectContaining({
      hiddenTitle: true,
      titleBarStyle: "overlay",
      visible: false
    })
  )
})

test("reopening hidden Windows settings reuses the window and selects the requested tab", async () => {
  host.existing = true
  await openSettingsWindow("appearance")
  expect(host.create).not.toHaveBeenCalled()
  expect(host.show).toHaveBeenCalledOnce()
  expect(host.focus).toHaveBeenCalledOnce()
  expect(host.emit).toHaveBeenCalledWith("settings", "settings-change-tab", "appearance")
})

test("reopening hidden macOS settings always shows and focuses the existing window", async () => {
  host.mac = true
  host.existing = true
  await openSettingsWindow("computer")
  await openSettingsWindow("computer")
  expect(host.attach).toHaveBeenCalledTimes(2)
  expect(host.show).toHaveBeenCalledTimes(2)
  expect(host.focus).toHaveBeenCalledTimes(2)
  expect(host.create).not.toHaveBeenCalled()
})

test("a stale hidden settings window is recreated instead of silently staying closed", async () => {
  host.existing = true
  host.show.mockRejectedValueOnce(new Error("window not found"))

  await openSettingsWindow("extensions")

  expect(host.destroy).toHaveBeenCalledOnce()
  expect(host.create).toHaveBeenCalledWith(
    "settings",
    expect.objectContaining({ url: "/settings.html?tab=extensions" })
  )
})
