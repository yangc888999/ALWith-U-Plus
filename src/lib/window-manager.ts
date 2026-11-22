// On-demand windows, reduced from ALwith Desktop's window-manager to the one this app has.

import { emitTo } from "@tauri-apps/api/event"
import { WebviewWindow } from "@tauri-apps/api/webviewWindow"

import i18n from "@/lib/i18n"

export type SettingsSection =
  | "mobile"
  | "trackpad"
  | "general"
  | "editor"
  | "appearance"
  | "account"
  | "provider"
  | "voice"
  | "computer"
  | "extensions"
  | "skills"
  | "groups"
  | "drive"
  | "usage"
  | "automation"
  | "about"
export const SETTINGS_SECTIONS: SettingsSection[] = [
  "account",
  "general",
  "provider",
  "appearance",
  "editor",
  "drive",
  "voice",
  "trackpad",
  "computer",
  "mobile",
  "extensions",
  "skills",
  "usage",
  "automation",
  "about"
]
/** Default window width is sized around the usage overview's 3×3 stat grid: 240px sidebar +
 *  48px page padding + three ~180px columns + two 16px gutters, plus slack. Every settings
 *  section shares this reference width; the grid never grows past three columns on a wider
 *  window and drops to two only when the user deliberately narrows below 860px. */
export const SETTINGS_DEFAULT_WIDTH = 880
export const SETTINGS_DEFAULT_HEIGHT = 800
export const SETTINGS_CHANGE_TAB = "settings-change-tab"
/** Close hides this window instead of destroying it, so its scroll offset survives. Emitted on
 *  every reopen so the page header and the first card (the usage overview) are visible again. */
export const SETTINGS_RESET_SCROLL = "settings-reset-scroll"

/** The current theme's --background as [r, g, b] for the native window ground, so the
 *  new window never flashes white before its first frame (Desktop's themeBackgroundRGB). */
function themeBackgroundRGB(): [number, number, number] {
  const css = getComputedStyle(document.documentElement).getPropertyValue("--background").trim()
  const el = document.createElement("canvas")
  el.width = el.height = 1
  const ctx = el.getContext("2d", { colorSpace: "srgb" })
  if (!ctx || !css) throw new Error("cannot read --background for the window ground")
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return [r, g, b]
}

/**
 * Settings window: the right content keeps Desktop's 520px width while the navigation
 * sidebar grows to 240px, with a solid ground (Desktop keeps tool windows opaque).
 * Existing → shown and focused (its close is intercepted into hide); otherwise created.
 * The window is independent on every platform: attaching it as a macOS child window made
 * edge-resize run through the system's low-frame-rate child-window path (visible jank).
 */
export type SettingsTarget = { providerId?: string }
export type SettingsNavigation = { section: SettingsSection; providerId?: string }

/** Click-again closes: the rail's avatar/gear toggle Settings instead of stacking focus. */
export async function toggleSettingsWindow(section?: SettingsSection, target: SettingsTarget = {}): Promise<void> {
  const existing = await WebviewWindow.getByLabel("settings")
  if (existing && (await existing.isVisible())) {
    // Hide, not destroy: scroll offset and section survive for the next open.
    await existing.hide().catch(() => {})
    return
  }
  await openSettingsWindow(section, target)
}

export async function openSettingsWindow(section?: SettingsSection, target: SettingsTarget = {}): Promise<void> {
  const existing = await WebviewWindow.getByLabel("settings")
  if (existing) {
    let shown = true
    try {
      await existing.show()
      await existing.setFocus()
    } catch {
      // A hidden Settings window can outlive its native handle (macOS child-window teardown,
      // attach failure, webview reload). show()/setFocus() then reject and the click silently
      // does nothing — exactly the "Settings won't open" symptom. Drop the stale handle and
      // fall through to creating a fresh window below.
      shown = false
      try {
        await existing.destroy()
      } catch {
        // Already gone: the label is free again.
      }
    }
    if (shown) {
      try {
        if (section !== undefined) await emitTo("settings", SETTINGS_CHANGE_TAB,
          target.providerId ? { section, providerId: target.providerId } : section)
        await emitTo("settings", SETTINGS_RESET_SCROLL, null)
      } catch {
        // The window is already visible; a missed tab switch or scroll reset is harmless.
      }
      return
    }
  }
  const win = new WebviewWindow("settings", {
    url: `/settings.html?tab=${section ?? "general"}${target.providerId ? `&provider=${encodeURIComponent(target.providerId)}` : ""}`,
    title: i18n.t("settings.title"),
    width: SETTINGS_DEFAULT_WIDTH,
    height: SETTINGS_DEFAULT_HEIGHT,
    // Build and position the window before the first frame is painted. Showing it while the
    // platform is still placing it made the first click flash at a default frame and then jump.
    visible: false,
    center: true,
    // Resizable by dragging any edge; the content column stretches with the window.
    resizable: true,
    // 下限就是设计宽度：再窄就要走「整行竖排」的另一套布局，用户拉到最小仍会觉得「有点不正常」。
    // 这里直接不允许跨过去——窗口最小 860，等于把布局固定在一套。
    minWidth: 860,
    minHeight: 640,
    maximizable: false,
    minimizable: false,
    fullscreen: false,
    hiddenTitle: true,
    titleBarStyle: "overlay",
    backgroundColor: themeBackgroundRGB(),
  })
  void win.once(
    "tauri://created",
    () =>
      void (async () => {
        await win.show()
        await win.setFocus()
      })()
  )
  // Safety net for a `tauri://created` that never arrives, or an attach that hangs.
  setTimeout(() => void win.show().catch(() => undefined), 1500)
}

