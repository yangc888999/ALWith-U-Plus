import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

/**
 * The maximized-window bug was a resize feedback loop: the sidebar's floating 0px width was
 * written into the geometry, which gave the whole viewport to chat, re-docked a *larger* sidebar,
 * and repeated every few seconds (135→159→…→261px, 2026-11-18 diagnostic log). With the snap
 * engine gone the loop is already impossible — nothing writes a measured position back into the
 * screen state — but the 0px guard is kept and pinned here as a regression.
 */
const observers: Array<() => void> = []
vi.mock("@/lib/trackpad-preference", () => ({ useThreeFingerSwipeEnabled: () => false }))
vi.mock("@/bindings", () => ({
  events: { "trackpad-gesture": { listen: vi.fn(() => Promise.resolve(() => {})) } }
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

import { initI18n } from "@/lib/i18n"

import { useMainCanvas } from "../use-main-canvas"

await initI18n("en")

class ControlledResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    observers.push(() => callback([], this as unknown as ResizeObserver))
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const nativeResizeObserver = globalThis.ResizeObserver
let sidebarWidth = 159
let viewportWidth = 1672

function Harness() {
  const canvas = useMainCanvas("main", true)
  return (
    <div ref={canvas.ref}>
      <div ref={canvas.navigationRef} />
      <div className="main-screen-track" style={canvas.trackStyle} />
      <span data-testid="leading" data-width={canvas.geometry.leading} />
      <span data-testid="stops" data-value={canvas.geometry.stops.join(":")} />
    </div>
  )
}

function remeasure(): void {
  act(() => {
    for (const fire of observers) fire()
  })
}

beforeEach(() => {
  globalThis.ResizeObserver = ControlledResizeObserver
  sidebarWidth = 159
  viewportWidth = 1672
  observers.length = 0
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => viewportWidth)
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => sidebarWidth)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  globalThis.ResizeObserver = nativeResizeObserver
})

test("a floating sidebar reporting 0px cannot rewrite the persisted column width", () => {
  render(<Harness />)
  expect(screen.getByTestId("leading").dataset.width).toBe("1513")
  sidebarWidth = 0
  remeasure()
  expect(screen.getByTestId("leading").dataset.width).toBe("1513")
})

test("geometry follows a real window resize monotonically, with no feedback loop", () => {
  render(<Harness />)
  expect(screen.getByTestId("stops").dataset.value).toBe("0:1513")
  viewportWidth = 1424
  remeasure()
  expect(screen.getByTestId("stops").dataset.value).toBe("0:1265")
  // A second measurement at the same size settles immediately — no oscillation.
  remeasure()
  expect(screen.getByTestId("stops").dataset.value).toBe("0:1265")
})
