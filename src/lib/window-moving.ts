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
  let unlisten: (() => void) | undefined

  void getCurrentWindow()
    .onMoved(() => {
      root.dataset.windowMoving = ""
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        delete root.dataset.windowMoving
      }, 240)
    })
    .then((off) => {
      if (disposed) off()
      else unlisten = off
    })
    .catch(() => undefined)

  return () => {
    disposed = true
    window.clearTimeout(timer)
    unlisten?.()
    delete root.dataset.windowMoving
  }
}
