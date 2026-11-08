import { describe, expect, test } from "vitest"

import { dayKey } from "../usage-data"
import {
  HEAT_RANGES,
  firstLocalDay,
  heatRangeFrom,
  hourlyBuckets,
  type HeatRange,
  type HourCell,
  type HourPoint,
  type HourlyHeat
} from "../usage-heatmap"

/** A point with only the columns the heatmap reads; `utcDate` is the localized-report extension. */
function pt(date: string, hour: number, tokens: number, requests: number, rest: Partial<HourPoint> = {}): HourPoint {
  return { date, hour, tokens, requests, ...rest }
}

/**
 * Expected local placement computed independently of the implementation: `Date.UTC` builds the
 * same instant from its parts (rather than parsing the `...Z` string), then the OS local clock
 * reads the day and hour. Keeps the suite correct in any timezone, including UTC and UTC-.
 */
function expectedLocal(utcDay: string, utcHour: number): { day: string; hour: number } {
  const [year, month, day] = utcDay.split("-").map(Number)
  const local = new Date(Date.UTC(year!, month! - 1, day!, utcHour))
  return { day: dayKey(local), hour: local.getHours() }
}

function cellAt(heat: HourlyHeat, day: string, hour: number): HourCell | undefined {
  const column = heat.days.indexOf(day)
  return column < 0 ? undefined : heat.cells[hour]?.[column]
}

/** A tight window covering exactly the points' converted local days, whatever the timezone is. */
function heatOf(points: HourPoint[]): HourlyHeat {
  const days = points.map((point) => expectedLocal(point.utcDate ?? point.date, point.hour).day)
  const to = days.length === 0 ? dayKey(new Date()) : [...days].sort().at(-1)!
  return hourlyBuckets(points, "", to)
}

/** Local calendar-day arithmetic (DST-safe): `day` minus `days` days, as a `YYYY-MM-DD` key. */
function localDayMinus(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number)
  return dayKey(new Date(year!, month! - 1, date! - days))
}

const TODAY = new Date(2026, 10, 2) // 2026-11-02, local midnight

describe("HEAT_RANGES", () => {
  test("lists the seven windows in order with their day counts", () => {
    expect(HEAT_RANGES.map((option) => option.value)).toEqual(["3d", "7d", "30d", "90d", "180d", "365d", "all"])
    expect(HEAT_RANGES.map((option) => option.days)).toEqual([3, 7, 30, 90, 180, 365, null])
    expect(HEAT_RANGES.every((option) => option.labelKey.startsWith("usageReport."))).toBe(true)
  })
})

describe("heatRangeFrom", () => {
  const fromFor = (days: number): string => dayKey(new Date(2026, 10, 2 - (days - 1)))

  const cases: Array<[HeatRange, number]> = [
    ["3d", 3],
    ["7d", 7],
    ["30d", 30],
    ["90d", 90],
    ["180d", 180],
    ["365d", 365]
  ]
  test.each(cases)("%s counts back %i days, today included", (range, days) => {
    expect(heatRangeFrom(range, TODAY, "")).toBe(fromFor(days))
  })

  test("a few concrete boundaries", () => {
    expect(heatRangeFrom("3d", TODAY, "")).toBe("2026-10-31")
    expect(heatRangeFrom("30d", TODAY, "")).toBe("2026-10-04")
    expect(heatRangeFrom("90d", TODAY, "")).toBe("2026-08-05")
  })

  test("clamps the start up to the first day the ledger holds, so a fresh install is not mostly empty", () => {
    expect(heatRangeFrom("90d", TODAY, "2026-11-01")).toBe("2026-11-01")
    expect(heatRangeFrom("90d", TODAY, "2020-01-01")).toBe("2026-08-05")
    expect(heatRangeFrom("90d", TODAY, "")).toBe("2026-08-05")
  })

  test("all has no lower bound", () => {
    expect(heatRangeFrom("all", TODAY, "2020-01-01")).toBe("")
    expect(heatRangeFrom("all", TODAY, "")).toBe("")
  })
})

describe("UTC hour -> local day + local hour", () => {
  test("a single bucket is filed under one instant's local day and hour, never raw (date, hour)", () => {
    const utcDay = "2026-06-15"
    const utcHour = 20
    const expected = expectedLocal(utcDay, utcHour)
    // Cover both the raw UTC day and the converted local day so a wrong placement is visible.
    const from = utcDay < expected.day ? utcDay : expected.day
    const to = utcDay > expected.day ? utcDay : expected.day
    const heat = hourlyBuckets([pt(utcDay, utcHour, 500, 3)], from, to)

    const nonZero = heat.cells.flat().filter((cell) => cell.tokens > 0)
    expect(nonZero).toHaveLength(1)
    expect(nonZero[0]).toMatchObject({ date: expected.day, hour: expected.hour, tokens: 500, requests: 3 })
    if (expected.hour !== utcHour || expected.day !== utcDay) {
      expect(cellAt(heat, utcDay, utcHour)?.tokens ?? 0).toBe(0)
    }
  })

  test("UTC 16..23 roll onto the next local day wherever the offset pushes past midnight", () => {
    const utcDay = "2026-06-15"
    const hours = [16, 17, 20, 23]
    const heat = heatOf(hours.map((hour) => pt(utcDay, hour, hour, 1)))
    for (const hour of hours) {
      const expected = expectedLocal(utcDay, hour)
      expect(cellAt(heat, expected.day, expected.hour)?.tokens).toBe(hour)
      const hoursAhead = -new Date(Date.UTC(2026, 5, 15, hour)).getTimezoneOffset() / 60
      if (hour + hoursAhead >= 24) expect(expected.day).not.toBe(utcDay)
    }
    // No bucket was lost or duplicated on the way across midnight.
    expect(heat.cells.flat().filter((cell) => cell.tokens > 0)).toHaveLength(hours.length)
    expect(heat.cells.flat().reduce((sum, cell) => sum + cell.tokens, 0)).toBe(hours.reduce((a, b) => a + b, 0))
  })

  test("all 24 UTC hours map to 24 distinct local (day, hour) cells", () => {
    const utcDay = "2026-06-15"
    const points = Array.from({ length: 24 }, (_, hour) => pt(utcDay, hour, hour + 1, 1))
    const heat = heatOf(points)
    const seen = new Set<string>()
    for (let hour = 0; hour < 24; hour += 1) {
      const expected = expectedLocal(utcDay, hour)
      expect(cellAt(heat, expected.day, expected.hour)?.tokens).toBe(hour + 1)
      seen.add(`${expected.day}#${expected.hour}`)
    }
    expect(seen.size).toBe(24)
    expect(heat.cells.flat().filter((cell) => cell.tokens > 0)).toHaveLength(24)
    expect(heat.cells.flat().reduce((sum, cell) => sum + cell.tokens, 0)).toBe((24 * 25) / 2)
  })

  test("a localized point (date already local) still converts from its original utcDate", () => {
    const utcDay = "2026-06-15"
    const utcHour = 20
    const expected = expectedLocal(utcDay, utcHour)
    const localized: HourPoint = pt(expected.day, utcHour, 500, 3, { utcDate: utcDay })
    const heat = heatOf([localized])
    const nonZero = heat.cells.flat().filter((cell) => cell.tokens > 0)
    expect(nonZero).toHaveLength(1)
    expect(nonZero[0]).toMatchObject({ date: expected.day, hour: expected.hour, tokens: 500 })
    // Using the rewritten `date` (instead of `utcDate`) would have picked a different instant.
    const wrong = expectedLocal(expected.day, utcHour)
    if (wrong.day !== expected.day || wrong.hour !== expected.hour) {
      expect(cellAt(heat, wrong.day, wrong.hour)?.tokens ?? 0).toBe(0)
    }
  })

  test("firstLocalDay reads the earliest converted day and is empty without points", () => {
    const early = "2026-01-01"
    const late = "2026-06-15"
    expect(firstLocalDay([pt(early, 8, 1, 1), pt(late, 12, 1, 1)])).toBe(expectedLocal(early, 8).day)
    expect(firstLocalDay([])).toBe("")
  })
})

describe("hourlyBuckets", () => {
  test("several providers/models on the same UTC hour fold into one cell", () => {
    const utcDay = "2026-06-15"
    const utcHour = 9
    const expected = expectedLocal(utcDay, utcHour)
    const heat = heatOf([
      pt(utcDay, utcHour, 100, 2),
      pt(utcDay, utcHour, 250, 3),
      pt(utcDay, utcHour, 50, 1)
    ])
    expect(cellAt(heat, expected.day, expected.hour)).toMatchObject({ tokens: 400, requests: 6 })
    expect(heat.cells.flat().filter((cell) => cell.tokens > 0)).toHaveLength(1)
  })

  test("fills every day of the window with a full 24-row zero column", () => {
    const heat = hourlyBuckets([], "2026-11-01", "2026-11-03")
    expect(heat.days).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"])
    expect(heat.cells).toHaveLength(24)
    for (const row of heat.cells) expect(row).toHaveLength(3)
    expect(heat.cells[0]?.[0]).toMatchObject({ date: "2026-11-01", hour: 0, column: 0, row: 0, tokens: 0, requests: 0 })
    expect(heat.cells[23]?.[2]).toMatchObject({ date: "2026-11-03", hour: 23, column: 2, row: 23 })
    expect(heat.max).toBe(0)
    expect(heat.active).toBe(false)
  })

  test("a zero column between active days stays zero", () => {
    const utcDay = "2026-06-15"
    const expected = expectedLocal(utcDay, 9)
    // Two active days with an empty day forced between them.
    const from = localDayMinus(expected.day, 2)
    const to = expected.day
    const heat = hourlyBuckets([pt(utcDay, 9, 400, 4)], from, to)
    expect(heat.days).toHaveLength(3)
    const middle = heat.days[1]!
    expect(heat.cells.every((row) => row[1]?.tokens === 0 && row[1]?.requests === 0)).toBe(true)
    expect(middle).not.toBe(expected.day)
    expect(cellAt(heat, expected.day, expected.hour)?.tokens).toBe(400)
  })

  test("ignores points whose local day is outside the window but still zero-fills it", () => {
    const heat = hourlyBuckets([pt("2026-11-05", 10, 999, 5)], "2026-01-01", "2026-01-03")
    expect(heat.days).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"])
    expect(heat.cells.flat().every((cell) => cell.tokens === 0)).toBe(true)
    expect(heat.max).toBe(0)
    expect(heat.active).toBe(false)
  })

  test("max is the busiest single cell and active tracks any call", () => {
    const utcDay = "2026-06-15"
    const heat = heatOf([
      pt(utcDay, 1, 100, 1),
      pt(utcDay, 8, 250, 2),
      pt(utcDay, 16, 900, 3)
    ])
    expect(heat.max).toBe(900)
    expect(heat.active).toBe(true)
    expect(hourlyBuckets([], "2026-11-01", "2026-11-01").max).toBe(0)
    expect(hourlyBuckets([], "2026-11-01", "2026-11-01").active).toBe(false)
  })

  test("a request with zero tokens still counts as activity", () => {
    const utcDay = "2026-06-15"
    const heat = heatOf([pt(utcDay, 4, 0, 2)])
    expect(heat.max).toBe(0)
    expect(heat.active).toBe(true)
  })
})

describe("the all range has no lower bound", () => {
  test("starts at the earliest day with data and ends at `to`", () => {
    const early = "2026-01-01"
    const late = "2026-06-15"
    const heat = hourlyBuckets([pt(early, 8, 10, 1), pt(late, 12, 20, 2)], "", "2026-06-20")
    const dayEarly = expectedLocal(early, 8).day
    const dayLate = expectedLocal(late, 12).day
    expect(heat.days[0]).toBe(dayEarly)
    expect(heat.days.at(-1)).toBe("2026-06-20")
    expect(cellAt(heat, dayEarly, expectedLocal(early, 8).hour)?.tokens).toBe(10)
    expect(cellAt(heat, dayLate, expectedLocal(late, 12).hour)?.tokens).toBe(20)
  })

  test("drops a point whose local day is past `to`", () => {
    const heat = hourlyBuckets(
      [pt("2026-06-15", 12, 20, 2), pt("2027-01-01", 5, 999, 1)],
      "",
      "2026-06-20"
    )
    expect(heat.cells.flat().some((cell) => cell.tokens === 999)).toBe(false)
    expect(heat.cells.flat().reduce((sum, cell) => sum + cell.tokens, 0)).toBe(20)
  })
})
