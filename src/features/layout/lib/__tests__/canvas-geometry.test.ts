import { resolveReleaseSnap } from "@nyssance/atlas/core"
import { resolveSplitGeometry as resolveCanvasGeometry } from "@nyssance/atlas/layout"
import { resolveMainCanvasGeometry } from "../canvas-geometry"
import { expect, test } from "vitest"

test("a pinned sidebar is shared by leading and chat, never a separate stop", () => {
  expect(resolveCanvasGeometry({ viewport: 1200, navigation: 240, pinned: true, chat: 560, preview: 400 })).toEqual({
    leading: 960,
    main: 960,
    content: 960,
    stops: [0, 960]
  })
})
test("floating navigation takes no chat space and overflowing preview has its own stop", () => {
  expect(resolveCanvasGeometry({ viewport: 1200, navigation: 240, pinned: false, chat: 1200, preview: 1200 })).toEqual({
    leading: 960,
    main: 1200,
    content: 2400,
    stops: [0, 1200, 2400]
  })
})
test("pinned overflow accounts for navigation only on the first work screen", () => {
  expect(
    resolveCanvasGeometry({ viewport: 900, navigation: 240, pinned: true, chat: 660, preview: 900 }).stops
  ).toEqual([0, 660, 1560])
})
test("release uses the nearest screen before the fifteen percent flick rule", () => {
  const base = { startIndex: 1, snapPoints: [960, 0, -1200], viewportWidth: 1200 }
  expect(resolveReleaseSnap({ ...base, displacement: -179, location: -179 })).toBe(1)
  expect(resolveReleaseSnap({ ...base, displacement: -180, location: -180 })).toBe(2)
  expect(resolveReleaseSnap({ ...base, displacement: 180, location: 180 })).toBe(0)
  expect(resolveReleaseSnap({ ...base, displacement: -650, location: -650 })).toBe(2)
  expect(resolveReleaseSnap({ ...base, startIndex: 2, displacement: -600, location: -1800 })).toBe(2)
})
test("release also follows RTL coordinates and one-screen layouts", () => {
  expect(
    resolveReleaseSnap({
      startIndex: 1,
      snapPoints: [-960, 0, 1200],
      viewportWidth: 1200,
      displacement: 180,
      location: 180
    })
  ).toBe(2)
  expect(
    resolveReleaseSnap({ startIndex: 0, snapPoints: [0], viewportWidth: 1200, displacement: 300, location: 300 })
  ).toBe(0)
})

// ── The canvas' own stop list ──────────────────────────────────────────────────────────────────
// `resolveMainCanvasGeometry` adds the trailing column's stop on top of Atlas' split geometry, and
// that stop is what the four-column layout broke on a narrow window.
test("every stop stays ahead of the one before it when four columns overflow", () => {
  // 1470 is the MacBook Air: preview open, work columns wider than the budget. Atlas' split
  // geometry puts the preview stop at 2590 while the trailing formula lands on 2155 — behind it.
  // Atlas indexes its snap markers by region, so an inverted list translated the track past the
  // conversation and the window opened on blank paper.
  const geometry = resolveMainCanvasGeometry({ viewport: 1470, navigation: 235, pinned: true, chat: 1120, preview: 800 }, true)
  expect(geometry.stops).toEqual([0, 1235, 2590, 2590])
  expect(geometry.regions).toEqual(["leading", "chat", "preview", "trailing"])
})

test("a window wide enough for the work columns keeps the trailing stop where it was", () => {
  const geometry = resolveMainCanvasGeometry({ viewport: 1712, navigation: 235, pinned: true, chat: 1477, preview: 0 }, true)
  expect(geometry.stops).toEqual([0, 1477, 1712])
})

test("stops never decrease across a sweep of window widths", () => {
  for (const viewport of [1000, 1180, 1280, 1470, 1600, 1712, 2048]) {
    for (const preview of [0, 400, 800, 1200]) {
      const { stops } = resolveMainCanvasGeometry({ viewport, navigation: 235, pinned: true, chat: 1120, preview }, true)
      const ordered = stops.every((value, index) => index === 0 || value >= stops[index - 1])
      expect({ viewport, preview, stops, ordered }).toEqual({ viewport, preview, stops, ordered: true })
    }
  }
})
