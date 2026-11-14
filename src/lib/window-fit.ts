/**
 * Keeps every window inside the visible frame of its monitor.
 *
 * A window dragged (or restored) taller than the screen loses macOS's rounded corners, and its
 * bottom rows (status bar, input) end up beyond the display — "the window is cut off". Clamping
 * on boot and after every move keeps both from happening. The guard is a no-op for windows that
 * already fit, so normal usage pays nothing.
 */
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window"

const MARGIN = 8

export async function clampWindowToScreen(): Promise<void> {
  const win = getCurrentWindow()
  const monitor = await currentMonitor()
  if (monitor === null) return
  const outer = await win.outerSize()
  const position = await win.outerPosition()
  // Physical pixels all around: monitor.size/position and the outer frame share the scale.
  const maxWidth = monitor.size.width - 2 * MARGIN
  const maxHeight = monitor.size.height - 2 * MARGIN
  const width = Math.min(outer.width, Math.max(0, maxWidth))
  const height = Math.min(outer.height, Math.max(0, maxHeight))
  if (width !== outer.width || height !== outer.height) {
    await win.setSize(new LogicalSize(width / monitor.scaleFactor, height / monitor.scaleFactor))
  }
  const x = Math.min(Math.max(monitor.position.x + MARGIN, position.x), monitor.position.x + maxWidth - width)
  const y = Math.min(Math.max(monitor.position.y + MARGIN, position.y), monitor.position.y + maxHeight - height)
  if (x !== position.x || y !== position.y) {
    await win.setPosition(new LogicalPosition(x / monitor.scaleFactor, y / monitor.scaleFactor))
  }
}
