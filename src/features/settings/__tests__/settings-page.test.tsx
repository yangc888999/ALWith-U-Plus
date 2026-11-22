import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }))
vi.mock("@tauri-apps/api/window", async () => {
  // 生产代码用窗口级 API（`getCurrentWindow`）：子 webview 有焦点时 `getCurrentWebviewWindow()`
  // 会抛 "current webview is not a WebviewWindow"。测试里两者指向同一个假窗口。
  const webviewWindow = await import("@tauri-apps/api/webviewWindow")
  return { ...webviewWindow, getCurrentWindow: () => webviewWindow.getCurrentWebviewWindow() }
})

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    hide: () => {
      return Promise.resolve()
    }
  })
}))
vi.mock("@/features/mobile/mobile-section", () => ({ MobileSection: () => null }))
vi.mock("@/features/drive/drive", () => ({ DriveSettings: () => null }))
vi.mock("@/features/drive/use-drive-visible", () => ({ useDriveVisible: () => true }))
vi.mock("@/features/extensions/runtime", () => ({ reportExtensionError: vi.fn() }))
vi.mock("@/features/extensions/use-extensions", () => ({
  useExtensions: () => ({ host: { views: [] }, state: { native: null } })
}))
vi.mock("@/features/extensions/extensions-section", () => ({ ExtensionsSection: () => null }))
vi.mock("@/features/workspace/editor-settings-dialog", () => ({ EditorSettingsSection: () => null }))
vi.mock("../sections/general-section", () => ({ GeneralSection: () => null }))
vi.mock("../sections/model-section", () => ({ ModelSection: () => null }))
vi.mock("../sections/appearance-section", () => ({ AppearanceSection: () => null }))
vi.mock("../sections/account-section", () => ({ AccountSection: () => null }))
vi.mock("../sections/provider-section", () => ({ ProviderSection: () => null }))
vi.mock("../sections/voice-section", () => ({ VoiceSection: () => null }))
vi.mock("../sections/computer-section", () => ({ ComputerSection: () => null }))
vi.mock("../sections/about-section", () => ({ AboutSection: () => null }))

import { SettingsPage } from "../settings-page"

beforeAll(() => initI18n("en"))
afterEach(cleanup)

test("settings has no visible window or sidebar title and keeps navigation accessible", () => {
  render(<SettingsPage />)
  expect(screen.queryByText("Settings")).not.toBeInTheDocument()
  // 标题现在长在内容区顶部（页面标题栏），导航里还有一个同名入口。
  expect(screen.getByRole("heading", { level: 1, name: "General" })).toBeVisible()
  expect(screen.getAllByText("General")).toHaveLength(2)
  expect(screen.getByRole("navigation", { name: "Settings" })).toBeVisible()
  expect(screen.getByRole("region", { name: "General" })).toBeVisible()
})

test("changing settings sections updates the accessible content label and current navigation item", () => {
  render(<SettingsPage />)
  fireEvent.click(screen.getByRole("button", { name: "Theme & appearance" }))
  expect(screen.getByRole("region", { name: "Theme & appearance" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Theme & appearance" })).toHaveAttribute("aria-current", "page")
  expect(screen.getByRole("button", { name: "General" })).not.toHaveAttribute("aria-current")
  expect(screen.getByRole("heading", { level: 1, name: "Theme & appearance" })).toBeVisible()
  expect(screen.getAllByText("Theme & appearance")).toHaveLength(2)
})

test("mobile connections are reachable from settings navigation", () => {
  render(<SettingsPage />)
  fireEvent.click(screen.getByRole("button", { name: "Mobile connection" }))
  expect(screen.getByRole("region", { name: "Mobile connection" })).toBeVisible()
})

test("usage is no longer a settings destination and old deep links land on General", () => {
  window.history.replaceState({}, "", "/settings.html?tab=usage")
  try {
    render(<SettingsPage />)
    expect(screen.queryByRole("button", { name: "Usage" })).toBeNull()
    expect(screen.getByRole("heading", { level: 1, name: "General" })).toBeVisible()
  } finally {
    window.history.replaceState({}, "", "/")
  }
})

test("a retired ?tab=external deep link lands on 通用 instead of a blank page", () => {
  // 外部调用页已下线：老链接（收藏、窗口 URL）不能掉进空白页，规范化后回落到「通用」。
  window.history.replaceState({}, "", "/settings.html?tab=external")
  try {
    render(<SettingsPage />)
    expect(screen.getByRole("heading", { level: 1, name: "General" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "External calls" })).toBeNull()
  } finally {
    window.history.replaceState({}, "", "/")
  }
})
