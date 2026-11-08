// macOS Dock badge for conversations that settled while the user was not looking at the app.
// The badge is app-wide (setBadgeCount is not per-window), so one module owns the counter: every
// settle adds one, returning to the app clears it. Non-Tauri environments (Storybook, tests) are
// a no-op — calling the native API there would produce an unhandled rejection.
import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"

let pending = 0
let watching = false

function paint(): void {
  if (!isTauri()) return
  // `undefined` removes the badge; passing 0 would render a literal "0" on some macOS versions.
  void getCurrentWindow()
    .setBadgeCount(pending > 0 ? pending : undefined)
    .catch(() => undefined)
}

/** One more settled conversation. Only counts when the app is in the background. */
export function bumpDockBadge(): void {
  if (!isTauri() || document.hasFocus()) return
  pending += 1
  paint()
  watchFocus()
}

/** Called on focus and on startup, so a badge never outlives the reason it was shown. */
export function clearDockBadge(): void {
  pending = 0
  paint()
}

function watchFocus(): void {
  if (watching || !isTauri()) return
  watching = true
  window.addEventListener("focus", clearDockBadge)
  // Clicking the Dock icon can make the window key without a DOM focus event (a child panel may
  // own focus), so the native focus event is the reliable signal on macOS.
  void getCurrentWindow()
    .onFocusChanged(({ payload: focused }) => {
      if (focused) clearDockBadge()
    })
    .catch(() => {
      watching = false
    })
}
