// On-demand windows, reduced from ALwith Desktop's window-manager to the one this app has.

import { emitTo } from "@tauri-apps/api/event"
import { WebviewWindow } from "@tauri-apps/api/webviewWindow"

import { commands } from "@/bindings"
import i18n from "@/lib/i18n"
import { isMac } from "@/lib/platform"

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
 * On macOS it is attached as a child of the main window, so it floats over it and never
 * becomes its own Stage Manager stage.
 */
export async function openSettingsWindow(section?: SettingsSection): Promise<void> {
  const existing = await WebviewWindow.getByLabel("settings")
  if (existing) {
    // Attach re-parents a window that was detached; a hidden window still needs show and focus.
    // A failing attach must not swallow the rest: the window would stay hidden forever.
    if (isMac()) {
      try {
        await commands.attachWindowToMain({ label: "settings" })
      } catch {
        // Fall through to showing it as a normal window.
      }
    }
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
        if (section !== undefined) await emitTo("settings", SETTINGS_CHANGE_TAB, section)
        await emitTo("settings", SETTINGS_RESET_SCROLL, null)
      } catch {
        // The window is already visible; a missed tab switch or scroll reset is harmless.
      }
      return
    }
  }
  const attachToMain = isMac()
  const win = new WebviewWindow("settings", {
    url: `/settings.html?tab=${section ?? "general"}`,
    title: i18n.t("settings.title"),
    width: SETTINGS_DEFAULT_WIDTH,
    height: SETTINGS_DEFAULT_HEIGHT,
    // Resizable by dragging any edge; the content column stretches with the window.
    resizable: true,
    minWidth: 720,
    minHeight: 620,
    maximizable: false,
    minimizable: false,
    fullscreen: false,
    hiddenTitle: true,
    titleBarStyle: "overlay",
    backgroundColor: themeBackgroundRGB(),
    // Shown by the native attach (child windows must not pop up as stages first).
    ...(attachToMain ? { visible: false } : {})
  })
  void win.once(
    "tauri://created",
    () =>
      void (async () => {
        // Attaching is best-effort: when it fails the window was left invisible, which is exactly
        // what made Settings look like it refused to open. Show it either way.
        if (attachToMain) {
          try {
            await commands.attachWindowToMain({ label: "settings" })
          } catch {
            // Fall through: a standalone Settings window beats none at all.
          }
        }
        await win.show()
        await win.setFocus()
      })()
  )
  // Safety net for a `tauri://created` that never arrives, or an attach that hangs.
  setTimeout(() => void win.show().catch(() => undefined), 1500)
}

