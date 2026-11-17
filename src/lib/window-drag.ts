import { getCurrentWindow } from "@tauri-apps/api/window"

import { commands } from "@/bindings"

const INTERACTIVE =
  "button, a, input, select, textarea, label, summary, [role='button'], [role='link'], [contenteditable='true']"

/**
 * Pressing the title bar moves the window.
 *
 * Nothing is overlaid on the page: the title bar stays an ordinary element, so every control in it
 * keeps its own clicks (an AppKit strip that covered the strip dragged well and killed the buttons
 * underneath — measured, reverted). When the press lands on empty title-bar space the page asks
 * Rust to run the drag, and that command keeps the mouse for the rest of the gesture.
 */
export function installWindowDrag(): () => void {
  const regionOf = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null
    const region = target.closest<HTMLElement>("[data-tauri-drag-region]")
    if (!region || region.dataset.tauriDragRegion === "false") return null
    return target.closest(INTERACTIVE) ? null : region
  }

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    if (!regionOf(event.target)) return
    // No text selection, and no second drag from Tauri's injected script.
    event.preventDefault()
    event.stopImmediatePropagation()
    void commands.windowDrag().catch(() => undefined)
  }

  const onDoubleClick = (event: MouseEvent) => {
    if (event.button !== 0 || !regionOf(event.target)) return
    void getCurrentWindow().toggleMaximize().catch(() => undefined)
  }

  document.addEventListener("mousedown", onMouseDown, true)
  document.addEventListener("dblclick", onDoubleClick, true)
  return () => {
    document.removeEventListener("mousedown", onMouseDown, true)
    document.removeEventListener("dblclick", onDoubleClick, true)
  }
}
