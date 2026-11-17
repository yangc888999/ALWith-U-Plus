import { getCurrentWindow } from "@tauri-apps/api/window"

const INTERACTIVE =
  "button, a, input, select, textarea, label, summary, [role='button'], [role='link'], [contenteditable='true']"

/**
 * Tauri's injected drag script only starts a drag when the pointer lands on the drag-region
 * element itself (a bare attribute requires `el === composedPath[0]`), so pressing a title, an
 * icon or an absolutely positioned wrapper does nothing — the "sometimes the window won't move"
 * case. Driving `startDragging` from pointerdown makes the whole strip draggable, and
 * `preventDefault` stops the injected mousedown handler from starting a second drag for the same
 * gesture. Double-click still toggles maximize, matching the native title bar.
 */
export function installWindowDrag(): () => void {
  const regionOf = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null
    const region = target.closest<HTMLElement>("[data-tauri-drag-region]")
    if (!region || region.dataset.tauriDragRegion === "false") return null
    return target.closest(INTERACTIVE) ? null : region
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary || event.detail > 1) return
    if (!regionOf(event.target)) return
    event.preventDefault()
    void getCurrentWindow().startDragging().catch(() => undefined)
  }

  const onDoubleClick = (event: MouseEvent) => {
    if (event.button !== 0 || !regionOf(event.target)) return
    void getCurrentWindow().toggleMaximize().catch(() => undefined)
  }

  document.addEventListener("pointerdown", onPointerDown, true)
  document.addEventListener("dblclick", onDoubleClick, true)
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true)
    document.removeEventListener("dblclick", onDoubleClick, true)
  }
}
