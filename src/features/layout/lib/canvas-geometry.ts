import { resolveSplitGeometry } from "@nyssance/atlas/layout"

type CanvasRegion = "leading" | "chat" | "preview" | "trailing"

export function resolveMainCanvasGeometry(input: Parameters<typeof resolveSplitGeometry>[0], trailing: boolean) {
  const base = resolveSplitGeometry(input)
  const regions: CanvasRegion[] = base.stops.length > 2 ? ["leading", "chat", "preview"] : ["leading", "chat"]
  const stops = [...base.stops]
  if (trailing) {
    regions.push("trailing")
    stops.push(base.leading + input.navigation + base.content + input.navigation - input.viewport)
  }
  // Every consumer of these numbers — the snap markers, Atlas' own snap list, `goToSnap` — indexes
  // them by region and treats them as ordered translate distances. A stop that sits *before* the
  // one in front of it is not a shorter jump, it is a corrupt list: Atlas resolves the marker for
  // the trailing column to a position behind the preview column, so settling on the conversation
  // translates the track by an amount that is only right at one particular width.
  //
  // That inversion is not hypothetical. As soon as the preview is open and the work columns are
  // wider than the budget (`chat + preview > viewport - navigation` — any narrow window carrying
  // four columns), the trailing stop came out a few hundred pixels *behind* the preview stop. The
  // window then opened on a screen translated past the conversation: blank paper with just the icon
  // rail, which a window drag "fixed" because the resize recomputed the same wrong numbers until
  // the widths happened to line up (2026-11-18, the MacBook Air report, and the four-column layout
  // that never held).
  //
  // Clamping keeps the invariant without inventing a new layout: a column may share a stop with the
  // one before it, but it can never be placed behind it.
  for (let index = 1; index < stops.length; index += 1) stops[index] = Math.max(stops[index], stops[index - 1])
  return { ...base, stops, regions, split: base.stops.length > 2 }
}
