/**
 * The boot-time window clamp. These cases are unit-only: they drive the real `window-fit` code
 * against a fake window server, because the defect they cover ("从一个屏到另一个屏，窗口只占屏幕三分
 * 之一、侧边栏被压到 100px") needs two displays with different scale factors to reproduce and the
 * development machine has one.
 */
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window"
import { beforeEach, expect, test, vi } from "vitest"

import { clampWindowToScreen, overlapArea, owningMonitorIndex, planWindowClamp } from "../window-fit"

interface FakeMonitor {
  name: string
  /** Global physical origin of the display. */
  x: number
  y: number
  /** Global physical size of the display. */
  width: number
  height: number
  scaleFactor: number
}

const fake = vi.hoisted(() => ({
  monitors: [] as FakeMonitor[],
  frame: { x: 0, y: 0, width: 0, height: 0 },
  maximized: false,
  fullscreen: false,
  sizes: [] as unknown[],
  positions: [] as unknown[]
}))

vi.mock("@tauri-apps/api/window", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/window")>()
  return {
    ...actual,
    availableMonitors: async () =>
      fake.monitors.map((monitor) => ({
        name: monitor.name,
        position: new actual.PhysicalPosition(monitor.x, monitor.y),
        size: new actual.PhysicalSize(monitor.width, monitor.height),
        workArea: {
          position: new actual.PhysicalPosition(monitor.x, monitor.y),
          size: new actual.PhysicalSize(monitor.width, monitor.height)
        },
        scaleFactor: monitor.scaleFactor
      })),
    getCurrentWindow: () => ({
      isMaximized: async () => fake.maximized,
      isFullscreen: async () => fake.fullscreen,
      outerSize: async () => new actual.PhysicalSize(fake.frame.width, fake.frame.height),
      outerPosition: async () => new actual.PhysicalPosition(fake.frame.x, fake.frame.y),
      setSize: async (size: unknown) => {
        fake.sizes.push(size)
      },
      setPosition: async (position: unknown) => {
        fake.positions.push(position)
      }
    })
  }
})

/** A 1920x1080 laptop panel at 1x on the left… */
const LAPTOP: FakeMonitor = { name: "HDP-V104", x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 }
/** …and a 2560x1440 external panel at 2x to its right. */
const EXTERNAL: FakeMonitor = { name: "DELL U2720Q", x: 1920, y: 0, width: 2560, height: 1440, scaleFactor: 2 }

function area(monitor: FakeMonitor) {
  return { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height }
}

beforeEach(() => {
  fake.monitors = [LAPTOP, EXTERNAL]
  fake.frame = { x: 0, y: 0, width: 0, height: 0 }
  fake.maximized = false
  fake.fullscreen = false
  fake.sizes = []
  fake.positions = []
})

test("overlap counts only the shared region and nothing for a mere touch", () => {
  const left = { x: 0, y: 0, width: 100, height: 100 }
  expect(overlapArea(left, { x: 50, y: 50, width: 100, height: 100 })).toBe(50 * 50)
  expect(overlapArea(left, { x: 100, y: 0, width: 100, height: 100 })).toBe(0)
  expect(overlapArea(left, { x: 10, y: 10, width: 10, height: 10 })).toBe(100)
})

test("a window straddling the seam belongs to the display it covers most of", () => {
  const areas = fake.monitors.map(area)
  // 420px on the laptop, 1380px on the external panel.
  let frame = { x: 1500, y: 100, width: 1800, height: 900 }
  expect(owningMonitorIndex(areas, frame)).toBe(1)
  // The same geometry shifted a little the other way belongs to the laptop instead.
  frame = { x: 300, y: 100, width: 1000, height: 900 }
  expect(owningMonitorIndex(areas, frame)).toBe(0)
  // A window off every screen falls back to the nearest display rather than to "none".
  expect(owningMonitorIndex(areas, { x: 9000, y: 9000, width: 400, height: 300 })).toBe(1)
})

test("the clamp uses the owning display's work area, not the display it straddles", async () => {
  // Mostly on the external panel, but its left edge hangs 420px over the laptop. Measured against
  // the laptop's work area this would be "off-screen" and dragged left; measured against the panel
  // it belongs to, only the origin has to move.
  fake.frame = { x: 1500, y: 100, width: 1800, height: 900 }
  await clampWindowToScreen()
  expect(fake.sizes).toEqual([])
  expect(fake.positions).toHaveLength(1)
  const moved = fake.positions[0]
  expect(moved).toBeInstanceOf(PhysicalPosition)
  expect(moved).toMatchObject({ x: 1920, y: 100 })
})

test("an oversized window is resized in physical pixels on a 2x display", async () => {
  // The old code divided the physical frame by the monitor's scale factor and then let Tauri divide
  // it again by the window's, so on a mixed-DPI pair the result was half the intended size.
  fake.frame = { x: 1920, y: 0, width: 3000, height: 2000 }
  await clampWindowToScreen()
  expect(fake.sizes).toHaveLength(1)
  const resized = fake.sizes[0]
  expect(resized).toBeInstanceOf(PhysicalSize)
  expect(resized).toMatchObject({ width: 2560 - 16, height: 1440 - 16 })
})

test("a window that already fits is not touched at all", async () => {
  fake.frame = { x: 100, y: 60, width: 1400, height: 900 }
  await clampWindowToScreen()
  expect(fake.sizes).toEqual([])
  expect(fake.positions).toEqual([])
})

test("a window flush against the work-area edge is not nudged inwards", async () => {
  // Only the size ceiling leaves the margin free; the frame may legitimately sit on the edge.
  fake.frame = { x: 0, y: 0, width: 1920, height: 1080 }
  await clampWindowToScreen()
  expect(fake.positions).toEqual([])
  expect(fake.sizes).toHaveLength(1)
  expect(fake.sizes[0]).toMatchObject({ width: 1920 - 16, height: 1080 - 16 })
})

test("a window stranded off every display is pulled onto the nearest one", async () => {
  fake.frame = { x: 9000, y: 9000, width: 1280, height: 800 }
  await clampWindowToScreen()
  expect(fake.positions).toHaveLength(1)
  // Right edge of the external panel, bottom edge of its work area.
  expect(fake.positions[0]).toMatchObject({ x: 1920 + 2560 - 1280, y: 1440 - 800 })
})

test("a maximized or fullscreen window is left entirely alone", async () => {
  fake.frame = { x: 1920, y: 0, width: 2560, height: 1440 }
  fake.maximized = true
  await clampWindowToScreen()
  expect(fake.sizes).toEqual([])
  expect(fake.positions).toEqual([])
  fake.maximized = false
  fake.fullscreen = true
  await clampWindowToScreen()
  expect(fake.sizes).toEqual([])
  expect(fake.positions).toEqual([])
})

test("no displays at all is a silent no-op", async () => {
  fake.monitors = []
  fake.frame = { x: 0, y: 0, width: 800, height: 600 }
  await expect(clampWindowToScreen()).resolves.toBeUndefined()
  expect(fake.sizes).toEqual([])
  expect(fake.positions).toEqual([])
})

test("the plan itself is pure and reports null when nothing has to change", () => {
  const areas = fake.monitors.map(area)
  expect(planWindowClamp({ x: 100, y: 60, width: 1400, height: 900 }, areas)).toBeNull()
  expect(planWindowClamp({ x: 100, y: 60, width: 1400, height: 900 }, [])).toBeNull()
  // Mostly on the external panel, so it is the panel's 2544x1424 ceiling that applies and the
  // origin is pushed to the panel's left edge.
  expect(planWindowClamp({ x: 0, y: 0, width: 4000, height: 3000 }, areas)).toEqual({
    size: { width: 2544, height: 1424 },
    position: { x: 1920, y: 0 }
  })
})
