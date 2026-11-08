// Pure arithmetic behind the usage page: range filtering, day/week/month bucketing, ranking and
// the four headline numbers. Kept out of the component so the numbers can be tested without a
// renderer, and so a wrong total is a failing test rather than a screenshot someone has to notice.

import { format, getDaysInMonth, parseISO, startOfWeek } from "date-fns"

import type { UsagePoint, UsageReport, UsageTurn } from "@/bindings"

export type Range = "1d" | "3d" | "7d" | "30d" | "90d" | "1y" | "6m" | "12m" | "custom"
export type Metric = "tokens" | "requests" | "cost"
export type Grain = "day" | "week" | "month"
export type GroupBy = "model" | "provider" | "all"

/** The single bucket a "no grouping" chart draws: every model/provider folded into one line. */
export const ALL_GROUP = "__all__"

/** The key a row contributes to under the chosen grouping. */
function groupKeyOf(row: { model: string; provider: string }, by: GroupBy): string {
  if (by === "all") return ALL_GROUP
  return by === "model" ? row.model : row.provider
}

/** A usage row plus the RMB amount it cost; pricing lives on the client, not in the report. */
export type CostedPoint = UsagePoint & { cost: number }

/** The metric value a chart, ranking or sparkline should read from a bucket/row. */
export function metricValue(row: { tokens: number; requests: number; cost?: number }, metric: Metric): number {
  if (metric === "tokens") return row.tokens
  if (metric === "requests") return row.requests
  return row.cost ?? 0
}

export const RANGES: Range[] = ["1d", "3d", "7d", "30d", "90d", "1y", "6m", "12m", "custom"]
/** `custom` carries its own dates, so the day count only matters for the fixed windows. */
export const RANGE_DAYS: Record<Range, number> = {
  "1d": 1,
  "3d": 3,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
  "6m": 182,
  "12m": 365,
  custom: 30
}

export type Totals = {
  requests: number
  input: number
  cached: number
  output: number
  tokens: number
  cost: number
}

export const EMPTY_TOTALS: Totals = { requests: 0, input: 0, cached: 0, output: 0, tokens: 0, cost: 0 }

export type Bucket = {
  key: string
  label: string
  tokens: number
  requests: number
  input: number
  cached: number
  output: number
  cost: number
}

export type Day = Bucket & { date: string }

/** `YYYY-MM-DD` in local time — the calendar the picker and the date inputs speak. */
export function dayKey(date: Date): string {
  return format(date, "yyyy-MM-dd")
}

/**
 * The engine stamps every call with `…Z` and writes `date` as the first ten characters, i.e. the
 * **UTC** calendar day. In UTC+8 a call made at 00:30 local is filed under yesterday, so a picker
 * asking for local "today" (`input[type=date]`, `cutoff`, `dayKey`) finds nothing while a 3/7-day
 * window still contains it. One conversion here puts the whole page on the reader's calendar.
 *
 * `localDateOf` rebuilds the UTC hour bucket; `localDateOfTimestamp` reads a full ISO turn stamp.
 * Both fall back to the engine's own day when a stamp is malformed rather than dropping the row.
 */
export function localDateOf(utcDay: string, utcHour = 0): string {
  const hour = Number.isFinite(utcHour) ? Math.min(23, Math.max(0, Math.trunc(utcHour))) : 0
  const stamp = Date.parse(`${utcDay}T${String(hour).padStart(2, "0")}:00:00Z`)
  return Number.isFinite(stamp) ? dayKey(new Date(stamp)) : utcDay
}

export function localDateOfTimestamp(at: string, fallback: string): string {
  const stamp = Date.parse(at)
  return Number.isFinite(stamp) ? dayKey(new Date(stamp)) : fallback
}

/**
 * Keep the original UTC day on each row: peak/off-peak pricing is quoted in UTC hours and must not
 * be shifted twice. Everything else on the page reads `date`, now a local calendar day.
 */
export function utcDayOf(row: { date: string; utcDate?: string }): string {
  return row.utcDate ?? row.date
}

export function localizeUsageReport(report: UsageReport): UsageReport {
  const points = report.points.map((point: UsagePoint) => ({
    ...point,
    date: localDateOf(point.date, point.hour),
    utcDate: point.date
  }))
  const recent = report.recent.map((turn: UsageTurn) => ({
    ...turn,
    date: localDateOfTimestamp(turn.at, turn.date),
    utcDate: turn.date
  }))
  return { ...report, points, recent }
}

/** First day the report keeps, inclusive. `30d` means today and the 29 days before it. */
export function cutoff(range: Range, today: Date): string {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (RANGE_DAYS[range] - 1))
  return dayKey(start)
}

/** The same-length window immediately before the selected one, for the period-over-period line. */
export function previousCutoff(range: Range, today: Date): string {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (RANGE_DAYS[range] - 1) * 2)
  return dayKey(start)
}

/** The selected window is closed on both ends, the same rule 分析 and the log already used. */
export function within<T extends { date: string }>(rows: T[], from: string, to?: string): T[] {
  return rows.filter((row) => row.date >= from && (to === undefined || row.date <= to))
}

export function sum(
  rows: Array<Pick<UsagePoint, "requests" | "input" | "cached" | "output" | "tokens"> & { cost?: number }>
): Totals {
  return rows.reduce<Totals>(
    (total, row) => ({
      requests: total.requests + row.requests,
      input: total.input + row.input,
      cached: total.cached + row.cached,
      output: total.output + row.output,
      tokens: total.tokens + row.tokens,
      cost: total.cost + (row.cost ?? 0)
    }),
    { ...EMPTY_TOTALS }
  )
}

/**
 * Cached reads over everything the provider had to look at. `input` already excludes the cached
 * part, so the denominator is their sum — not `input + cached` of the raw number.
 */
export function cacheHitRate(totals: Totals): number {
  const read = totals.input + totals.cached
  return read === 0 ? 0 : totals.cached / read
}

/** Every day of the range, gaps included: a heatmap with holes would misread as missing data. */
export function dailyBuckets(rows: Array<UsagePoint & { cost?: number }>, from: string, to: string): Day[] {
  const byDate = new Map<string, Day>()
  for (const row of rows) {
    const day = byDate.get(row.date) ?? {
      key: row.date,
      date: row.date,
      label: format(parseISO(row.date), "MM/dd"),
      tokens: 0,
      requests: 0,
      input: 0,
      cached: 0,
      output: 0,
      cost: 0
    }
    day.tokens += row.tokens
    day.requests += row.requests
    day.input += row.input
    day.cached += row.cached
    day.output += row.output
    day.cost += row.cost ?? 0
    byDate.set(row.date, day)
  }
  const days: Day[] = []
  const end = parseISO(to)
  for (let cursor = parseISO(from); cursor <= end; cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)) {
    const key = dayKey(cursor)
    days.push(byDate.get(key) ?? { key, date: key, label: format(cursor, "MM/dd"), tokens: 0, requests: 0, input: 0, cached: 0, output: 0, cost: 0 })
  }
  return days
}

function bucketKeyOf(date: string, grain: Grain): string {
  if (grain === "day") return date
  const parsed = parseISO(date)
  return grain === "week" ? dayKey(startOfWeek(parsed, { weekStartsOn: 1 })) : format(parsed, "yyyy-MM")
}

function bucketLabel(key: string, grain: Grain): string {
  if (grain === "day") return format(parseISO(key), "MM/dd")
  if (grain === "week") return format(parseISO(key), "MM/dd")
  return format(parseISO(`${key}-01`), "yyyy/MM")
}

/** Ranked rows for the distribution list; `share` is of the same metric the list ranks by. */
export function ranking(
  rows: Array<UsagePoint & { cost?: number }>,
  by: GroupBy,
  metric: Metric,
  top: number
): Array<{ key: string; label: string; tokens: number; requests: number; cost: number; share: number }> {
  const grouped = new Map<string, { key: string; label: string; tokens: number; requests: number; cost: number }>()
  for (const row of rows) {
    const key = groupKeyOf(row, by)
    const entry = grouped.get(key) ?? { key, label: key, tokens: 0, requests: 0, cost: 0 }
    entry.tokens += row.tokens
    entry.requests += row.requests
    entry.cost += row.cost ?? 0
    grouped.set(key, entry)
  }
  const sorted = [...grouped.values()].sort(
    (left, right) => metricValue(right, metric) - metricValue(left, metric)
  )
  const total = sorted.reduce((value, entry) => value + metricValue(entry, metric), 0)
  return sorted.slice(0, top).map((entry) => ({
    ...entry,
    share: total === 0 ? 0 : metricValue(entry, metric) / total
  }))
}

/** Longest run of consecutive days that saw at least one call. */
export function longestStreak(days: Day[]): number {
  let best = 0
  let run = 0
  for (const day of days) {
    if (day.requests > 0) {
      run += 1
      best = Math.max(best, run)
    } else {
      run = 0
    }
  }
  return best
}

/** Relative change against the previous window; `null` when there is nothing to compare with. */
export function change(current: number, previous: number): number | null {
  if (previous === 0) return null
  return (current - previous) / previous
}

/** The tail of the range as a line, for the sparkline in each headline stat. */
export function sparkline(days: Day[], metric: Metric, count = 14): number[] {
  return days.slice(-count).map((day) => metricValue(day, metric))
}

export type GroupSeries = {
  groups: Array<{ key: string; label: string; total: number }>
  buckets: Array<{ key: string; label: string; values: number[] }>
  max: number
}

const OTHER = "__other__"

/** Every bucket key the range touches, so a chart keeps one column per day instead of skipping gaps. */
export function bucketKeys(from: string, to: string, grain: Grain): string[] {
  const end = parseISO(to)
  const keys: string[] = []
  if (grain === "month") {
    for (let cursor = parseISO(`${from.slice(0, 7)}-01`); cursor <= end; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
      keys.push(format(cursor, "yyyy-MM"))
    }
    return keys
  }
  const step = grain === "week" ? 7 : 1
  let cursor = grain === "week" ? startOfWeek(parseISO(from), { weekStartsOn: 1 }) : parseISO(from)
  while (cursor <= end) {
    keys.push(dayKey(cursor))
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + step)
  }
  return keys
}

/**
 * A value per group per bucket, so the chart can stack or draw a line per group. Groups past `top`
 * fold into one "other" band instead of vanishing, so the stack still adds up to the total.
 */
export function seriesByGroup(
  rows: Array<UsagePoint & { cost?: number }>,
  grain: Grain,
  by: GroupBy,
  metric: Metric,
  top: number,
  from: string,
  to: string
): GroupSeries {
  // Only the visible window: a row outside it would mint an extra column past the axis end, and
  // would let a model that was busy last month outrank one that is busy now.
  const scoped = rows.filter((row) => row.date >= from && row.date <= to)
  const value = (row: { tokens: number; requests: number; cost?: number }) => metricValue(row, metric)
  const totals = new Map<string, number>()
  for (const row of scoped) {
    const key = groupKeyOf(row, by)
    totals.set(key, (totals.get(key) ?? 0) + value(row))
  }
  // Ties break on the key so the legend does not reshuffle between two renders of the same data.
  const ranked = [...totals.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  const keep = new Set(ranked.slice(0, top).map(([key]) => key))
  const groups = ranked.slice(0, top).map(([key, total]) => ({ key, label: key, total }))
  if (ranked.length > top) {
    groups.push({ key: OTHER, label: "…", total: ranked.slice(top).reduce((sum, [, total]) => sum + total, 0) })
  }
  const grouped = new Map<string, { key: string; label: string; values: number[] }>()
  for (const key of bucketKeys(from, to, grain)) {
    grouped.set(key, { key, label: bucketLabel(key, grain), values: groups.map(() => 0) })
  }
  for (const row of scoped) {
    const raw = groupKeyOf(row, by)
    const key = keep.has(raw) ? raw : OTHER
    const bucketKey = bucketKeyOf(row.date, grain)
    const bucket = grouped.get(bucketKey) ?? { key: bucketKey, label: bucketLabel(bucketKey, grain), values: groups.map(() => 0) }
    const index = groups.findIndex((group) => group.key === key)
    bucket.values[index] = (bucket.values[index] ?? 0) + value(row)
    grouped.set(bucketKey, bucket)
  }
  const buckets = [...grouped.values()].sort((left, right) => left.key.localeCompare(right.key))
  const max = buckets.reduce((peak, bucket) => Math.max(peak, bucket.values.reduce((sum, value) => sum + value, 0)), 0)
  return { groups, buckets, max: Math.max(1, max) }
}

export function peakDay(days: Day[]): Day | null {
  return days.reduce<Day | null>((best, day) => (best === null || day.tokens > best.tokens ? day : best), null)
}

export type HeatCell = { date: string; tokens: number; requests: number; column: number; row: number }

/** `count` month keys ending at `anchor` (`YYYY-MM`), oldest first: "2026-11", 3 → 09, 10, 11. */
export function monthKeysEndingAt(anchor: string, count: number): string[] {
  const [year, month] = anchor.split("-").map(Number)
  if (!Number.isFinite(year) || !Number.isFinite(month)) return []
  const keys: string[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const cursor = new Date(year, month - 1 - offset, 1)
    keys.push(dayKey(cursor).slice(0, 7))
  }
  return keys
}

export type MonthBlock = {
  key: string
  /** Days in the month — the block draws exactly this many cells, never a padded 5×7 sheet. */
  days: number
  columns: number
  cells: HeatCell[]
}

/** Days per row in a month block. */
export const MONTH_COLUMNS = 6

/**
 * One block per month, six cells per row in plain reading order (1, 2, 3 … — no weekday columns).
 * Calendar alignment made a month that starts on Sunday draw an L above the rest, which reads as a
 * broken shape next to its neighbours; a rectangle of 30 or 31 cells does not.
 */
export function monthBlocks(rows: Array<Pick<Day, "date" | "tokens" | "requests">>, keys: string[]): MonthBlock[] {
  const byDate = new Map(rows.map((row) => [row.date, row]))
  return keys.map((key) => {
    const start = parseISO(`${key}-01`)
    const days = getDaysInMonth(start)
    const cells: HeatCell[] = []
    for (let day = 1; day <= days; day += 1) {
      const date = new Date(start.getFullYear(), start.getMonth(), day)
      const hit = byDate.get(dayKey(date))
      cells.push({
        date: dayKey(date),
        tokens: hit?.tokens ?? 0,
        requests: hit?.requests ?? 0,
        column: (day - 1) % MONTH_COLUMNS,
        row: Math.floor((day - 1) / MONTH_COLUMNS)
      })
    }
    return { key, days, columns: MONTH_COLUMNS, cells }
  })
}

export function heatLevel(tokens: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || max <= 0) return 0
  const ratio = tokens / max
  if (ratio > 0.66) return 4
  if (ratio > 0.33) return 3
  if (ratio > 0.1) return 2
  return 1
}
