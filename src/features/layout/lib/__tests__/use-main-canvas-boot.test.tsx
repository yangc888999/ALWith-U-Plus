import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

/**
 * The canvas no longer owns a snap engine. These tests pin the replacement contract: the app's
 * `screen` prop decides where the track sits, and only an explicit navigation (dots / keyboard /
 * gesture) may ask the app to change screens. Nothing reads a DOM position back into state.
 */
const native = vi.hoisted(() => ({
  listen: vi.fn(() => Promise.resolve(() => {}))
}))
vi.mock("@/lib/trackpad-preference", () => ({ useThreeFingerSwipeEnabled: () => false }))
vi.mock("@/bindings", () => ({
  events: { "trackpad-gesture": { listen: native.listen } }
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

import { initI18n } from "@/lib/i18n"

import { useMainCanvas } from "../use-main-canvas"

await initI18n("en")

function Harness({ onScreenChange }: { onScreenChange?: (screen: "main" | "leading") => void }) {
  const canvas = useMainCanvas("main", true, onScreenChange)
  return (
    <div ref={canvas.ref} data-testid="root">
      <div ref={canvas.navigationRef} />
      <div className="main-screen-track" style={canvas.trackStyle} data-testid="track">
        <div className="main-screen-leading" />
        <div className="main-screen-content" />
      </div>
      <span data-testid="selected" data-value={canvas.selected} />
    </div>
  )
}

beforeEach(() => {
  native.listen.mockReset()
  native.listen.mockResolvedValue(() => {})
  // jsdom has no layout; give the canvas a real width so geometry resolves to three columns.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1470)
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(235)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test("every cold launch parks on the conversation screen", () => {
  const onScreenChange = vi.fn()
  render(<Harness onScreenChange={onScreenChange} />)
  expect(screen.getByTestId("selected").dataset.value).toBe("1")
  expect(onScreenChange).not.toHaveBeenCalled()
})

test("the track offset follows the selected screen and never reads the DOM back", async () => {
  render(<Harness />)
  const track = screen.getByTestId("track")
  // Chat is the first stop after zero: 1470 - 235 = 1235, translated negative in LTR.
  await waitFor(() => expect(track.style.transform).toContain("-1235px"))
})

test("an explicit select to leading asks the app once, and an echoed screen prop is idempotent", () => {
  const onScreenChange = vi.fn()
  const view = render(<Harness onScreenChange={onScreenChange} />)
  const canvasRoot = screen.getByTestId("root")

  act(() => {
    canvasRoot.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
  })
  expect(onScreenChange).toHaveBeenCalledExactlyOnceWith("leading")
  expect(screen.getByTestId("selected").dataset.value).toBe("0")

  // The app echoes the new screen back; re-rendering must not fire another change.
  view.rerender(<Harness onScreenChange={onScreenChange} />)
  expect(onScreenChange).toHaveBeenCalledTimes(1)
})

test("an unrelated key does not navigate", () => {
  const onScreenChange = vi.fn()
  render(<Harness onScreenChange={onScreenChange} />)
  act(() => {
    screen.getByTestId("root").dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))
  })
  expect(onScreenChange).not.toHaveBeenCalled()
  expect(screen.getByTestId("selected").dataset.value).toBe("1")
})
