/**
 * Keeps the main window inside the visible area of the display it belongs to.
 *
 * A window dragged (or restored) taller than the screen loses macOS's rounded corners, and its
 * bottom rows (status bar, input) end up beyond the display — "the window is cut off". Clamping
 * on boot keeps that from happening, and the native side re-runs the same policy whenever a display
 * changes.
 *
 * Two rules are shared with `src-tauri/src/window.rs`, and they have to stay identical or the two
 * clamps fight each other:
 *
 * 1. **Ownership is decided by the largest overlap.** `currentMonitor()` answers with whichever
 *    display the platform feels like for a window that straddles the seam between two screens, and
 *    acting on "whichever" is how a window came back sized against the *other* screen (「第2屏挤占」).
 *    The display the window covers most of is the only defensible answer.
 * 2. **Everything is compared in global physical pixels.** `outerSize`, `outerPosition` and
 *    `Monitor.workArea` are already in that space, so nothing is divided by a scale factor. The
 *    previous version converted the physical frame with *the monitor's* scale factor and then let
 *    Tauri convert it again with *the window's*, which on a mixed-DPI pair (1x + 2x) landed the
 *    window at half or double the intended size.
 */
import {
  availableMonitors,
  getCurrentWindow,
  type Monitor,
  PhysicalPosition,
  PhysicalSize
} from "@tauri-apps/api/window"

/** Gap left between the window frame and the edges of the work area, in physical pixels. */
const MARGIN = 8

/** A rectangle in global physical pixels — the one unit every comparison here uses. */
export interface RectPx {
  x: number
  y: number
  width: number
  height: number
}

/** What a clamp has to change. `null` members mean "already correct, do not touch it". */
export interface ClampPlan {
  size: { width: number; height: number } | null
  position: { x: number; y: number } | null
}

/**
 * The area two rectangles share. Zero when they merely touch, so a window sitting exactly on the
 * seam between two displays belongs to neither rather than to both.
 */
export function overlapArea(a: RectPx, b: RectPx): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width <= 0 || height <= 0 ? 0 : width * height
}

/** The display whose centre is nearest to the window's centre — the reachable one when off-screen. */
function nearestMonitorIndex(areas: RectPx[], frame: RectPx): number {
  const centreX = frame.x + frame.width / 2
  const centreY = frame.y + frame.height / 2
  let nearest = 0
  let nearestDistance = Number.POSITIVE_INFINITY
  areas.forEach((area, index) => {
    const dx = centreX - (area.x + area.width / 2)
    const dy = centreY - (area.y + area.height / 2)
    const distance = dx * dx + dy * dy
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = index
    }
  })
  return nearest
}

/**
 * The display a window belongs to: the one it covers the most of. Falls back to the nearest display
 * when the window is off every screen, so a stranded window is pulled onto the closest one instead
 * of being left where nobody can reach it.
 */
export function owningMonitorIndex(areas: RectPx[], frame: RectPx): number {
  let owner = -1
  let mostCovered = 0
  areas.forEach((area, index) => {
    const covered = overlapArea(area, frame)
    if (covered > mostCovered) {
      mostCovered = covered
      owner = index
    }
  })
  return owner >= 0 ? owner : nearestMonitorIndex(areas, frame)
}

/**
 * Decides what to change so `frame` fits inside the work area of the display that owns it.
 * Returns `null` when the window already fits — a no-op must stay a no-op, or a drag against a
 * screen edge would be fought by a re-centre.
 */
export function planWindowClamp(frame: RectPx, areas: RectPx[]): ClampPlan | null {
  if (areas.length === 0) return null
  const area = areas[owningMonitorIndex(areas, frame)]
  if (area === undefined || area.width <= 0 || area.height <= 0) return null

  // The ceiling leaves the margin free, so the frame never sits on top of the Dock or the menu bar.
  const maxWidth = Math.max(1, area.width - 2 * MARGIN)
  const maxHeight = Math.max(1, area.height - 2 * MARGIN)
  const width = Math.min(Math.max(1, frame.width), maxWidth)
  const height = Math.min(Math.max(1, frame.height), maxHeight)
  // Inside the *whole* work area, not the margin-inset one: a window legitimately dragged flush to
  // the edge must not be nudged 8px inwards on every launch.
  const x = Math.min(Math.max(frame.x, area.x), Math.max(area.x, area.x + area.width - width))
  const y = Math.min(Math.max(frame.y, area.y), Math.max(area.y, area.y + area.height - height))

  const size = width === frame.width && height === frame.height ? null : { width, height }
  const position = x === frame.x && y === frame.y ? null : { x, y }
  return size === null && position === null ? null : { size, position }
}

/**
 * The work area of a monitor in physical pixels. Falls back to the full monitor size when the
 * platform reports no work area (a bare X11 session), so the ceiling is never "0" and the window
 * is not collapsed to a single pixel.
 */
function monitorRect(monitor: Monitor): RectPx {
  const area = monitor.workArea
  const usable = area !== undefined && area !== null && area.size.width > 0 && area.size.height > 0
  return usable
    ? { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height }
    : { x: monitor.position.x, y: monitor.position.y, width: monitor.size.width, height: monitor.size.height }
}

/**
 * Fits the current window into its own display's work area. Safe to call on every start: a window
 * that already fits produces no IPC write. A maximized or fullscreen window is left entirely alone
 * — its frame *is* the work area, and resizing it would read as "the app shrinks itself when
 * maximized".
 */
export async function clampWindowToScreen(): Promise<void> {
  const win = getCurrentWindow()
  const monitors = await availableMonitors()
  const areas = monitors.map(monitorRect).filter((area) => area.width > 0 && area.height > 0)
  if (areas.length === 0) return
  const [maximized, fullscreen] = await Promise.all([win.isMaximized(), win.isFullscreen()])
  if (maximized || fullscreen) return
  const [outer, position] = await Promise.all([win.outerSize(), win.outerPosition()])
  const plan = planWindowClamp({ x: position.x, y: position.y, width: outer.width, height: outer.height }, areas)
  if (plan === null) return
  if (plan.size !== null) await win.setSize(new PhysicalSize(plan.size.width, plan.size.height))
  if (plan.position !== null) await win.setPosition(new PhysicalPosition(plan.position.x, plan.position.y))
}
