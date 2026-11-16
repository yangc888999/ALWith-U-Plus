import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

import { useMainCanvas } from "../use-main-canvas"

const carousel = vi.hoisted(() => {
  const api = {
    refresh: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    cancelInput: vi.fn(),
    goToSnap: vi.fn(),
    getGeometry: () => ({ selected: 1, snaps: [0, 1] }),
    on: vi.fn<(event: string, listener: () => void) => unknown>(),
    off: vi.fn()
  }
  api.on.mockReturnValue(api)
  api.off.mockReturnValue(api)
  return { api, ref: vi.fn(), options: vi.fn<(options: { navigationPinned?: boolean }) => void>() }
})
vi.mock("@nyssance/atlas/react", () => ({
  useAtlas: (options: { navigationPinned?: boolean }) => {
    carousel.options(options)
    return { ref: carousel.ref, atlas: carousel.api }
  }
}))
vi.mock("@/lib/trackpad-preference", () => ({ useThreeFingerSwipeEnabled: () => false }))
await initI18n("en")

function Harness() {
  const canvas = useMainCanvas("main", true)
  return (
    <div ref={canvas.ref} data-testid="canvas" data-moving={canvas.moving}>
      <div ref={canvas.navigationRef} />
      <button onClick={() => canvas.context.navigate("chat")}>Chat</button>
      <button onClick={() => canvas.context.setDividerDragging(true)}>Start</button>
      <button
        onClick={() =>
          canvas.context.setWorkspace({
            chat: 1000,
            preview: 1000,
            visible: true,
            maximized: false
          })
        }
      >
        Resize
      </button>
      <button onClick={() => canvas.context.setDividerDragging(false)}>End</button>
    </div>
  )
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(256)
  carousel.api.refresh.mockClear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test("semantic navigation does not rebuild unchanged canvas geometry", () => {
  const view = render(<Harness />)
  const before = carousel.api.refresh.mock.calls.length
  expect(before).toBeGreaterThan(0)
  fireEvent.click(view.getByText("Chat"))
  fireEvent.click(view.getByText("Chat"))
  expect(carousel.api.refresh).toHaveBeenCalledTimes(before)
  expect(view.getByTestId("canvas")).toHaveAttribute("data-moving", "false")
})

test("divider movement defers rebuilding until release", () => {
  const view = render(<Harness />)
  const before = carousel.api.refresh.mock.calls.length
  fireEvent.click(view.getByText("Start"))
  fireEvent.click(view.getByText("Resize"))
  expect(carousel.api.refresh).toHaveBeenCalledTimes(before)
  fireEvent.click(view.getByText("End"))
  expect(carousel.api.refresh).toHaveBeenCalledTimes(before + 1)
})

function PagingHarness({ pinned }: { pinned: boolean }) {
  const [screen, setScreen] = useState<"leading" | "main">("leading")
  const canvas = useMainCanvas(screen, pinned, setScreen, true)
  return (
    <div ref={canvas.ref}>
      <div ref={canvas.navigationRef} />
      {[0, 1, 2].map((index) => (
        <button key={index} onClick={() => canvas.select(index)}>
          {index + 1}
        </button>
      ))}
    </div>
  )
}

test.each([false, true])("offscreen navigation remains eligible for hover with pinned=%s", async (pinned) => {
  const view = render(<PagingHarness pinned={pinned} />)
  const geometry = vi.spyOn(carousel.api, "getGeometry")
  for (const index of [1, 2, 0, 1]) {
    fireEvent.click(view.getByText(String(index + 1)))
    geometry.mockReturnValue({ selected: index, snaps: [0, 1, 2] })
    const listener = carousel.api.on.mock.calls.findLast(([event]) => event === "select")?.[1]
    if (typeof listener !== "function") throw new Error("Missing Atlas selection subscription")
    await act(() => Promise.resolve(listener()))
    const settle = carousel.api.on.mock.calls.findLast(([event]) => event === "settle")?.[1]
    if (!settle) throw new Error("Missing Atlas settle subscription")
    await act(() => Promise.resolve(settle()))
    expect(carousel.options.mock.calls.at(-1)?.[0].navigationPinned).toBe(pinned && index === 1)
  }
})

test("repeated clicks on the selected target leave its animation running", () => {
  const view = render(<PagingHarness pinned={false} />)
  carousel.api.cancelInput.mockClear()
  carousel.api.goToSnap.mockClear()
  fireEvent.click(view.getByText("2"))
  fireEvent.click(view.getByText("2"))
  expect(carousel.api.cancelInput).not.toHaveBeenCalled()
  expect(carousel.api.goToSnap).not.toHaveBeenCalled()
})

test("selection during motion defers docking changes until settle", async () => {
  const geometry = vi.spyOn(carousel.api, "getGeometry")
  geometry.mockReturnValue({ selected: 0, snaps: [0, 1, 2] })
  const view = render(<PagingHarness pinned />)
  fireEvent.click(view.getByText("2"))
  geometry.mockReturnValue({ selected: 1, snaps: [0, 1, 2] })
  const select = carousel.api.on.mock.calls.findLast(([event]) => event === "select")?.[1]
  const settle = carousel.api.on.mock.calls.findLast(([event]) => event === "settle")?.[1]
  if (!select || !settle) throw new Error("Missing Atlas subscriptions")
  await act(() => Promise.resolve(select()))
  expect(carousel.options.mock.calls.at(-1)?.[0].navigationPinned).toBe(false)
  await act(() => Promise.resolve(settle()))
  expect(carousel.options.mock.calls.at(-1)?.[0].navigationPinned).toBe(true)
})

/** Mirrors how MainSidebarLayout renders the anchors, so the test sees the real geometry. */
function AnchorHarness() {
  const canvas = useMainCanvas("main", true, undefined, true)
  return (
    <div ref={canvas.ref}>
      <div ref={canvas.navigationRef} />
      <span data-testid="measured">{String(canvas.measured)}</span>
      {canvas.geometry.stops.map((offset, index) => (
        <div
          key={index}
          className="canvas-snap"
          data-atlas-region={canvas.geometry.regions[index]}
          style={{ insetInlineStart: offset, width: canvas.width }}
        />
      ))}
    </div>
  )
}

// 回归探针 —— 首次打开 / 最大化后侧栏被推到中间、左边一片空白。
//
// 根因：首帧 size={0,0} → resolveSplitGeometry 得到 leading=0/main=0，**三个 snap 全部重合在 0**。
// Atlas 构造时立刻 goTo(initialRegion)，就落在这组退化锚点算出的错误偏移上；之后真实尺寸到达，
// refresh() 重建了 snap 列表，但 Atlas 的 selected 索引没变，轨道仍停在旧偏移。
//
// 契约：Atlas 要求构造时至少有一个非空且唯一的 region 锚点，所以锚点不能不渲染；
// 未测量的那一帧必须用**非退化占位几何**，保证 stops 从第一帧起就互不相同。
test("the unmeasured first frame still yields distinct snap offsets", () => {
  const widths = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(0)
  const nav = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(0)
  const view = render(<AnchorHarness />)
  // 还没量到 —— 但锚点必须存在（Atlas 契约）且位置互不相同（否则轨道会错位）。
  expect(view.getByTestId("measured")).toHaveTextContent("false")
  const anchors = [...view.container.querySelectorAll(".canvas-snap")] as HTMLElement[]
  expect(anchors.length).toBeGreaterThan(1)
  const offsets = anchors.map((node) => node.style.insetInlineStart)
  expect(new Set(offsets).size).toBe(anchors.length)
  widths.mockRestore()
  nav.mockRestore()
})
