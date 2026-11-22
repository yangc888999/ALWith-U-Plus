import { getCurrentWindow } from "@tauri-apps/api/window"

/**
 * macOS repaints the whole transparent webview on every frame while a window is being dragged.
 * Blurred surfaces are the expensive part, so heavy compositing is switched off for the duration
 * (see the `data-window-moving` rules in index.css) and restored once the drag settles. Without
 * this the first move after a heavy screen can look like the app froze.
 */
export function watchWindowMovement(): () => void {
  const root = document.documentElement
  let timer: number | undefined
  let disposed = false
  const unlisteners: Array<() => void> = []

  const mark = () => {
    root.dataset.windowMoving = ""
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      delete root.dataset.windowMoving
    }, 240)
  }

  const attach = (listening: Promise<() => void>) => {
    void listening
      .then((off) => {
        if (disposed) off()
        else unlisteners.push(off)
      })
      .catch(() => undefined)
  }

  const current = getCurrentWindow()
  attach(current.onMoved(mark))
  // Dragging an edge or a corner only emits `Resized` — `Moved` fires when the origin changes, so
  // a right/bottom-edge drag never set this flag and kept paying for blur on every frame.
  attach(current.onResized(mark))

  return () => {
    disposed = true
    window.clearTimeout(timer)
    for (const off of unlisteners) off()
    delete root.dataset.windowMoving
  }
}
