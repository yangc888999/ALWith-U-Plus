// 环形时钟 / 连续时间带的纯函数：小时聚合、峰值、连续色阶。

import { expect, test } from "vitest"

import { heatColor, hourTotals, peakHour } from "../hour-activity-chart"
import type { HourlyHeat } from "../usage-heatmap"

function heat(): HourlyHeat {
  const days = ["2026-11-04", "2026-11-05"]
  const cells = Array.from({ length: 24 }, (_, hour) =>
    days.map((date, column) => ({ date, hour, tokens: 0, requests: 0, column, row: hour }))
  )
  cells[9]![0]!.tokens = 100
  cells[9]![0]!.requests = 1
  cells[9]![1]!.tokens = 50
  cells[9]![1]!.requests = 1
  cells[22]![1]!.tokens = 300
  cells[22]![1]!.requests = 2
  return { days, cells, max: 300, active: true }
}

test("every date in the window is folded into its hour", () => {
  const totals = hourTotals(heat())
  expect(totals).toHaveLength(24)
  expect(totals[9]).toEqual({ hour: 9, tokens: 150, requests: 2 })
  expect(totals[22]).toEqual({ hour: 22, tokens: 300, requests: 2 })
  expect(totals[3]).toEqual({ hour: 3, tokens: 0, requests: 0 })
})

test("the peak hour is the busiest one, and an empty window has none", () => {
  expect(peakHour(heat())?.hour).toBe(22)
  const empty = heat()
  for (const row of empty.cells) for (const cell of row) cell.tokens = 0
  expect(peakHour(empty)).toBeNull()
})

test("the colour ramp is continuous instead of five hard tiers", () => {
  const idle = heatColor(0, 300)
  const low = heatColor(30, 300)
  const high = heatColor(300, 300)
  expect(idle).toContain("muted-foreground")
  expect(low).toContain("--settings-accent")
  expect(high).toContain("--settings-accent")
  const strength = (color: string): number => Number(/([\d.]+)%/.exec(color)?.[1] ?? 0)
  expect(strength(low)).toBeGreaterThan(0)
  expect(strength(low)).toBeLessThan(strength(high))
  expect(strength(high)).toBeCloseTo(100, 1)
  // A destroyed max must never divide by zero or produce a saturated cell.
  expect(heatColor(20, 0)).toContain("muted-foreground")
})
