import { act, cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { OnlineBiNativeView } from "../online-bi-embed"

const invokeMock = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown) => null))
const eventMock = vi.hoisted(() => ({
  listener: null as ((event: { payload: { phase: "started" | "finished"; signedIn: boolean; url: string } }) => void) | null
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, listener: typeof eventMock.listener) => {
    eventMock.listener = listener
    return () => {}
  })
}))
vi.mock("@/features/profile/use-display-profile", () => ({ useDisplayProfile: () => null }))

let intersectionCallback: IntersectionObserverCallback | null = null

class FakeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback
  }
  observe(): void {}
  disconnect(): void {}
}

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

function intersect(visible: boolean): void {
  act(() => {
    intersectionCallback?.(
      [
        {
          isIntersecting: visible,
          intersectionRatio: visible ? 1 : 0,
          intersectionRect: { width: visible ? 800 : 0, height: visible ? 600 : 0 }
        } as IntersectionObserverEntry
      ],
      {} as IntersectionObserver
    )
  })
}

beforeEach(() => {
  invokeMock.mockClear()
  eventMock.listener = null
  intersectionCallback = null
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 810,
    bottom: 620,
    width: 800,
    height: 600,
    toJSON: () => ({})
  } as DOMRect)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test("mounts only while the slot is visible, follows the theme and closes on unmount", async () => {
  const view = render(<OnlineBiNativeView src="https://bi.finture.id/report" theme="dark" />)
  expect(invokeMock).not.toHaveBeenCalledWith("online_bi_embed_mount", expect.anything())

  intersect(true)
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith(
      "online_bi_embed_mount",
      expect.objectContaining({ url: "https://bi.finture.id/report", theme: "dark" })
    )
  )

  view.rerender(<OnlineBiNativeView src="https://bi.finture.id/report" theme="light" />)
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("online_bi_embed_set_theme", { theme: "light" })
  )

  intersect(false)
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("online_bi_embed_set_visible", { visible: false })
  )

  intersect(true)
  await waitFor(() =>
    expect(invokeMock.mock.calls.filter(([command]) => command === "online_bi_embed_mount")).toHaveLength(2)
  )

  view.unmount()
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("online_bi_embed_close"))
})

test("keeps the native view hidden while loading and reports the finished page state", async () => {
  const states: Array<{ ready: boolean; signedIn: boolean; url: string }> = []
  render(
    <OnlineBiNativeView
      src="https://bi.finture.id/report"
      theme="dark"
      onPageState={(state) => states.push(state)}
    />
  )
  intersect(true)
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith(
      "online_bi_embed_mount",
      expect.objectContaining({ url: "https://bi.finture.id/report", visible: false })
    )
  )
  await waitFor(() => expect(eventMock.listener).not.toBeNull())

  act(() => eventMock.listener?.({ payload: { phase: "started", signedIn: false, url: "" } }))
  await waitFor(() => expect(states.at(-1)).toMatchObject({ ready: false }))

  act(() =>
    eventMock.listener?.({
      payload: { phase: "finished", signedIn: true, url: "https://bi.finture.id/self-board?board=x&tab=y" }
    })
  )
  await waitFor(() =>
    expect(states.at(-1)).toEqual({
      ready: true,
      signedIn: true,
      url: "https://bi.finture.id/self-board?board=x&tab=y"
    })
  )
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith(
      "online_bi_embed_mount",
      expect.objectContaining({ visible: true })
    )
  )
})
