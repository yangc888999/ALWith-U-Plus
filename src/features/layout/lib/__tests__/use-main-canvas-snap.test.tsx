import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

/**
 * A collapsed sidebar changes the CSS width of every column. Geometry arithmetic alone used to
 * translate the chat screen a sidebar-width too far, leaving a blank strip on the right (2026-11-18
 * resolution report). Snap positions must come from the rendered slides, as a carousel measures
 * them, so the conversation always lands flush with the viewport.
 */
vi.mock("@/lib/trackpad-preference", () => ({ useThreeFingerSwipeEnabled: () => false }))
vi.mock("@/bindings", () => ({
  events: { "trackpad-gesture": { listen: vi.fn(() => Promise.resolve(() => {})) } }
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

import { initI18n } from "@/lib/i18n"

import { useMainCanvas } from "../use-main-canvas"

await initI18n("en")

let chatOffsetLeft = 1513 // the shared sidebar's left edge = leading = 1672 - 159
let viewportWidth = 1672

function Harness({ pinned }: { pinned: boolean }) {
  const canvas = useMainCanvas("main", pinned)
  return (
    <div ref={canvas.ref} data-testid="root">
      <div ref={canvas.navigationRef} />
      <div className="main-screen-track" style={canvas.trackStyle} data-testid="track">
        <div className="main-screen-leading" data-snap-region="leading" />
        <div className="main-sidebar-shell" data-snap-region="chat" />
        <div className="main-screen-content" />
      </div>
    </div>
  )
}

beforeEach(() => {
  chatOffsetLeft = 1513
  viewportWidth = 1672
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => viewportWidth)
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => 159)
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    // The sidebar sits at the track's inline padding (leading); the content column starts after it.
    if (this.classList.contains("main-sidebar-shell")) return chatOffsetLeft
    return 0
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test("the chat snap uses the rendered content position, not the geometry estimate", async () => {
  render(<Harness pinned />)
  await waitFor(() => expect(screen.getByTestId("track").style.transform).toContain("-1513px"))
})

test("after collapsing the sidebar the snap follows the new DOM position with no blank strip", async () => {
  const view = render(<Harness pinned />)
  await waitFor(() => expect(screen.getByTestId("track").style.transform).toContain("-1513px"))
  // The sidebar collapses: geometry would say stops[1] = full viewport (1672), but the content
  // column still starts at 1513. The translate must follow the DOM, else 159px stays blank.
  chatOffsetLeft = 1513
  view.rerender(<Harness pinned={false} />)
  await waitFor(() => expect(screen.getByTestId("track").style.transform).toContain("-1513px"))
  expect(screen.getByTestId("track").style.transform).not.toContain("-1672px")
})
