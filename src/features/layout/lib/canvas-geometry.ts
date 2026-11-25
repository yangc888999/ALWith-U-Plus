export const CANVAS_RAIL_SPACE = 62

export type CanvasRegion = "leading" | "chat" | "preview" | "trailing"

export type CanvasGeometryInput = {
  viewport: number
  navigation: number
  railSpace?: number
  pinned: boolean
  chat: number
  preview: number
}

/**
 * Screen offsets are plain arithmetic — no library owns them, so no snap reading can be handed
 * back to the app and slide the track onto the wrong screen (2026-11-18). The numbers are the
 * same ones Atlas' `resolveSplitGeometry` produced; only the dependency and the runtime loop
 * around them are gone.
 */
export function resolveMainCanvasGeometry(input: CanvasGeometryInput, trailing: boolean) {
  const { viewport, navigation, pinned, chat, preview } = input
  const leading = Math.max(0, viewport - navigation)
  const main = leading + (pinned ? 0 : navigation)
  const budget = Math.max(0, viewport - (pinned ? navigation : (input.railSpace ?? 0)))
  const content = Math.max(budget, chat + preview)
  const baseStops = [0, main]
  if (chat > 0 && preview > 0 && chat + preview > budget) baseStops.push(leading + navigation + chat)

  const regions: CanvasRegion[] = baseStops.length > 2 ? ["leading", "chat", "preview"] : ["leading", "chat"]
  const stops = [...baseStops]
  if (trailing) {
    regions.push("trailing")
    stops.push(leading + navigation + content + navigation - viewport)
  }
  // Four columns can push the trailing stop behind the preview one (`chat + preview > budget`).
  // Every consumer indexes these as ordered translate distances, so an inverted list lands the
  // track past the conversation: blank paper with only the icon rail until a resize rerolls it.
  // A column may share a stop with the one before it, never precede it.
  for (let index = 1; index < stops.length; index += 1) stops[index] = Math.max(stops[index], stops[index - 1])
  return { leading, main, content, stops, regions, split: baseStops.length > 2 }
}
