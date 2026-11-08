// Pure arithmetic for the 24-hour time-of-day heatmap. `localizeUsageReport` moves each point's
// `date` onto the reader's calendar day but deliberately leaves `hour` as the UTC hour, so plotting
// `(date, hour)` would be shifted by the whole UTC offset (and the UTC-16..23 buckets would sit on
// the wrong day). Here both the day and the hour come from one instant — the UTC bucket
// `YYYY-MM-DDTHH:00:00Z` — read through the OS local clock, the same clock `dayKey` and the rest
// of the page's local-day filters use. No user-configured `utcOffset` is involved, so day and
// hour can never belong to two different timezones.

import { parseISO } from "date-fns"

import type { UsagePoint } from "@/bindings"

import { dayKey, utcDayOf } from "./usage-data"

/** A point as the heatmap needs it: the engine's UTC day (or the localized `date`) and UTC hour. */
export type HourPoint = Pick<UsagePoint, "date" | "hour" | "tokens" | "requests"> & { utcDate?: string }

export type HeatRange = "3d" | "7d" | "30d" | "90d" | "180d" | "365d" | "all"

export type HeatRangeOption = {
  value: HeatRange
  /** i18n key for the picker label; reuses the overview's range words where one fits. */
  labelKey: string
  /** Days in the window, counting today; `null` means "no lower bound". */
  days: number | null
}

/** Independent of the overview's `Range`: this picker has its own day-count windows. */
export const HEAT_RANGES: readonly HeatRangeOption[] = [
  { value: "3d", labelKey: "usageReport.range.3d", days: 3 },
  { value: "7d", labelKey: "usageReport.range.7d", days: 7 },
  { value: "30d", labelKey: "usageReport.range.30d", days: 30 },
  { value: "90d", labelKey: "usageReport.range.90d", days: 90 },
  { value: "180d", labelKey: "usageReport.range.6m", days: 180 },
  { value: "365d", labelKey: "usageReport.range.1y", days: 365 },
  { value: "all", labelKey: "usageReport.allTime", days: null }
]

/**
 * Inclusive local-day start for the chosen window. Fixed windows count back from `today`
 * (`3d` = today plus the two days before it), clamped up to `firstDay` — the earliest day the
 * ledger holds — so a fresh install does not open on hundreds of empty columns. `"all"` has no
 * lower bound and returns `""`; `hourlyBuckets` then starts at the first day that has data.
 */
export function heatRangeFrom(range: HeatRange, today: Date, firstDay: string): string {
  const option = HEAT_RANGES.find((entry) => entry.value === range)
  if (option === undefined || option.days === null) return ""
  const cutoff = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (option.days - 1)))
  return firstDay !== "" && firstDay > cutoff ? firstDay : cutoff
}

/** The same instant read twice: local calendar day and local hour, both from the OS local clock. */
function localHourOf(point: HourPoint): { day: string; hour: number } {
  const utcDay = utcDayOf(point)
  const utcHour = Number.isFinite(point.hour) ? Math.min(23, Math.max(0, Math.trunc(point.hour))) : 0
  const stamp = Date.parse(`${utcDay}T${String(utcHour).padStart(2, "0")}:00:00Z`)
  if (!Number.isFinite(stamp)) return { day: "", hour: 0 }
  const local = new Date(stamp)
  return { day: dayKey(local), hour: local.getHours() }
}

/** Earliest local day any point contributes to, or `""` when there is none. Feeds `heatRangeFrom`. */
export function firstLocalDay(points: readonly HourPoint[]): string {
  let first = ""
  for (const point of points) {
    const { day } = localHourOf(point)
    if (day !== "" && (first === "" || day < first)) first = day
  }
  return first
}

export type HourCell = {
  date: string
  hour: number
  tokens: number
  requests: number
  /** Day index (x / column). */
  column: number
  /** Hour index (y / row), 0..23. */
  row: number
}

export type HourlyHeat = {
  /** Column labels, oldest first; one per day in `[from, to]`, gaps included. */
  days: string[]
  /** `24` rows (hours 0..23) × `days.length` columns, zero-filled. */
  cells: HourCell[][]
  /** Largest tokens in any single cell (0 when empty); `heatLevel` guards a zero max itself. */
  max: number
  /** Whether any cell saw a call; the card shows a friendly empty state when false. */
  active: boolean
}

function daysBetween(from: string, to: string): string[] {
  const days: string[] = []
  const end = parseISO(to)
  for (let cursor = parseISO(from); cursor <= end; cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)) {
    days.push(dayKey(cursor))
  }
  return days
}

/**
 * Fold every point into a local `(day, hour)` bucket and lay the result out as a 24×N matrix.
 * `from` is an inclusive local-day key; pass `""` (the "all" range) to start at the earliest day
 * that has data. `to` is the inclusive upper bound (normally today). Points whose local day falls
 * outside the window are ignored, and every day in the window gets all 24 cells even when empty.
 */
export function hourlyBuckets(points: readonly HourPoint[], from: string, to: string): HourlyHeat {
  // Convert once, dropping anything after `to` (a UTC bucket can land on a local day past today).
  const converted: Array<{ day: string; hour: number; tokens: number; requests: number }> = []
  for (const point of points) {
    const { day, hour } = localHourOf(point)
    if (day === "" || day > to) continue
    converted.push({ day, hour, tokens: point.tokens, requests: point.requests })
  }

  const start = from !== ""
    ? from
    : converted.reduce<string>((min, row) => (min === "" || row.day < min ? row.day : min), "")
  const days = start === "" ? [] : daysBetween(start, to)
  const index = new Map(days.map((day, column) => [day, column]))
  const cells: HourCell[][] = Array.from({ length: 24 }, (_, hour) =>
    days.map((date, column) => ({ date, hour, tokens: 0, requests: 0, column, row: hour }))
  )

  for (const row of converted) {
    const column = index.get(row.day)
    if (column === undefined) continue
    const cell = cells[row.hour]?.[column]
    if (cell === undefined) continue
    cell.tokens += row.tokens
    cell.requests += row.requests
  }

  let max = 0
  let active = false
  for (const row of cells) {
    for (const cell of row) {
      if (cell.tokens > max) max = cell.tokens
      if (cell.tokens > 0 || cell.requests > 0) active = true
    }
  }
  return { days, cells, max, active }
}
