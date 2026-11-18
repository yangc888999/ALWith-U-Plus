import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

/**
 * A controllable Atlas controller. The real controller is driven by Embla + layout measurement,
 * which jsdom cannot reproduce faithfully; the launch bug is entirely about how useMainCanvas
 * reacts to Atlas' `settle`/`select` events, so controlling those events directly is the precise
 * level to test at.
 */
const { controller, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>()
  const controller = {
    selected: 0,
    snaps: [0, 1, 2],
    getGeometry: () => ({
      selected: controller.selected,
      snaps: controller.snaps,
      groups: [],
      offsets: [],
      regions: [],
      location: 0,
      target: 0,
      progress: 0
    }),
    refresh: vi.fn(),
    goToSnap: vi.fn((index: number) => {
      controller.selected = index
    }),
    cancelInput: vi.fn(),
    gesture: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    on: vi.fn((event: string, fn: () => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
      return controller
    }),
    off: vi.fn((event: string, fn: () => void) => {
      listeners.get(event)?.delete(fn)
      return controller
    })
  }
  return { controller, listeners }
})

vi.mock("@nyssance/atlas/react", () => ({
  useAtlas: () => ({ ref: vi.fn(), atlas: controller, state: {} })
}))
vi.mock("@/lib/trackpad-preference", () => ({ useThreeFingerSwipeEnabled: () => false }))
vi.mock("@/bindings", () => ({ events: { "trackpad-gesture": { listen: vi.fn(() => Promise.resolve(() => {})) } } }))

import { initI18n } from "@/lib/i18n"

import { useMainCanvas } from "../use-main-canvas"

await initI18n("en")

function emit(event: string): void {
  act(() => {
    for (const fn of listeners.get(event) ?? []) fn()
  })
}

function setSelected(index: number): void {
  act(() => {
    controller.selected = index
  })
}

function Harness({ onScreenChange }: { onScreenChange: (screen: "main" | "leading") => void }) {
  const canvas = useMainCanvas("main", true, onScreenChange)
  return (
    <div ref={canvas.ref}>
      <div ref={canvas.navigationRef} />
      <div className="main-screen-track" data-atlas-track>
        <div className="canvas-snap" data-atlas-region="leading" data-atlas-leading />
        <div className="canvas-snap" data-atlas-region="chat" />
        <div className="canvas-snap" data-atlas-region="preview" />
      </div>
    </div>
  )
}

beforeEach(() => {
  controller.selected = 0
  controller.snaps = [0, 1, 2]
  controller.refresh.mockClear()
  controller.goToSnap.mockClear()
  listeners.clear()
  // jsdom has no layout; give the canvas a real width so the landing effect runs (size.viewport > 0).
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1470)
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(248)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test("cold snap-0 settles never relay the launch to the leading screen", () => {
  const onScreenChange = vi.fn()
  render(<Harness onScreenChange={onScreenChange} />)

  // Real Atlas on a cold MacBook Air: before the track lays out, the first settle reports snap 0.
  setSelected(0)
  emit("select")
  emit("settle")
  expect(onScreenChange).not.toHaveBeenCalledWith("leading")

  // A second cold settle (e.g. after a window-state refresh) must also be ignored.
  setSelected(0)
  emit("settle")
  expect(onScreenChange).not.toHaveBeenCalledWith("leading")

  // Every launch still aims at the conversation; no navigation happened, so view stays "main".
  expect(controller.goToSnap).toHaveBeenCalledWith(1, expect.anything())
})

test("a programmatic chat settle does not end the lock; only a real interaction does", () => {
  const onScreenChange = vi.fn()
  render(<Harness onScreenChange={onScreenChange} />)

  // Even the landing settle is programmatic (goToSnap), so it must not open the gate — otherwise a
  // later window-state refresh could emit a cold snap-0 and relay the launch to the leading screen.
  setSelected(1)
  emit("settle")
  setSelected(0)
  emit("settle")
  expect(onScreenChange).not.toHaveBeenCalledWith("leading")

  // A real pointer interaction (pan-drag or trackpad swipe) hands authority back to Atlas.
  emit("pointerDown")
  setSelected(0)
  emit("select")
  emit("settle")
  expect(onScreenChange).toHaveBeenCalledWith("leading")
})

test("a pointer-down before any settle releases the lock so a drag is not swallowed", () => {
  const onScreenChange = vi.fn()
  render(<Harness onScreenChange={onScreenChange} />)

  emit("pointerDown")
  setSelected(0)
  emit("settle")
  expect(onScreenChange).toHaveBeenCalledWith("leading")
})

test("a keyboard navigation key releases the lock so Atlas' settle-only move is honored", () => {
  const onScreenChange = vi.fn()
  const view = render(<Harness onScreenChange={onScreenChange} />)
  const canvasRoot = view.container.firstElementChild as HTMLElement

  // Arrow keys fire no pointerDown in Atlas; it reports the move solely via settle.
  act(() => {
    canvasRoot.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
  })
  setSelected(0)
  emit("settle")
  expect(onScreenChange).toHaveBeenCalledWith("leading")
})

test("an unrelated key does not release the launch lock", () => {
  const onScreenChange = vi.fn()
  const view = render(<Harness onScreenChange={onScreenChange} />)
  const canvasRoot = view.container.firstElementChild as HTMLElement

  act(() => {
    canvasRoot.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))
  })
  setSelected(0)
  emit("settle")
  expect(onScreenChange).not.toHaveBeenCalledWith("leading")
})
