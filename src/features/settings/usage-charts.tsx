// Charts for the usage page. Hand-drawn SVG instead of a charting dependency: the app ships three
// charts and a sparkline, and a library would add a few hundred kilobytes to every launch for
// geometry this small. All of them take pre-computed numbers and only decide where to put ink.

import { useState } from "react"

import type { GroupSeries } from "./usage-data"

/** Tuned to the app's warm accent, then stepped around the hue wheel so nine bands stay distinct. */
export const SERIES_COLORS = [
  "var(--settings-accent)",
  "oklch(0.72 0.15 62)",
  "oklch(0.66 0.11 170)",
  "oklch(0.62 0.13 250)",
  "oklch(0.64 0.15 305)",
  "oklch(0.75 0.13 95)",
  "oklch(0.6 0.09 200)",
  "oklch(0.68 0.12 340)",
  "oklch(0.7 0.05 30)"
]

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]
}

/** Catmull-Rom through the bucket centres, emitted as cubic Béziers. Control-point heights are
 *  clamped to the plot box so a spike at either end cannot bow the curve outside the chart. */
function smoothPath(points: Array<[number, number]>, height: number): string {
  if (points.length === 0) return ""
  const f = (n: number): string => n.toFixed(2)
  const clamp = (y: number): number => Math.min(height, Math.max(0, y))
  let d = `M ${f(points[0]![0])} ${f(points[0]![1])}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[i + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6)
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6)
    d += ` C ${f(c1x)} ${f(c1y)}, ${f(c2x)} ${f(c2y)}, ${f(p2[0])} ${f(p2[1])}`
  }
  return d
}

/** 60×16 sparkline: the shape matters, the scale does not. */
export function Spark({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min === 0 ? 1 : max - min
  const plot = values.map(
    (value, index) =>
      [(index / (values.length - 1)) * 60, 15 - ((value - min) / span) * 13] as [number, number]
  )
  return (
    <svg viewBox="0 0 60 16" className={className} fill="none" aria-hidden="true">
      <path
        d={smoothPath(plot, 16)}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** Hover panel shared by the time charts: bucket label, one row per group, then the total. */
function SeriesTooltip({
  series,
  index,
  leftPercent,
  formatValue,
  totalLabel
}: {
  series: GroupSeries
  index: number
  leftPercent: number
  formatValue: (value: number) => string
  totalLabel: string
}): React.ReactNode {
  const bucket = series.buckets[index]
  if (bucket === undefined) return null
  const total = bucket.values.reduce((sum, value) => sum + value, 0)
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 min-w-28 -translate-x-1/2 rounded-md border bg-popover/95 px-2 py-1.5 text-[10px] leading-4 shadow-md backdrop-blur"
      // Keep the panel inside the card at both ends of the axis.
      style={{ left: `${Math.min(88, Math.max(12, leftPercent))}%` }}
      role="tooltip"
    >
      <div className="mb-0.5 font-medium">{bucket.label}</div>
      <div className="flex flex-col gap-0.5">
        {series.groups.map((group, groupIndex) => (
          <div key={group.key} className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="size-[6px] shrink-0 rounded-[2px]" style={{ backgroundColor: seriesColor(groupIndex) }} />
            <span className="max-w-40 truncate text-muted-foreground">{group.label}</span>
            <span className="ms-auto tabular-nums">{formatValue(bucket.values[groupIndex] ?? 0)}</span>
          </div>
        ))}
      </div>
      <div className="mt-1 flex items-center gap-1.5 border-t border-[color-mix(in_oklab,var(--border)_60%,transparent)] pt-0.5 whitespace-nowrap">
        <span className="text-muted-foreground">{totalLabel}</span>
        <span className="ms-auto font-medium tabular-nums">{formatValue(total)}</span>
      </div>
    </div>
  )
}

/** Bars stacked by group, so one column still answers "how much that day" and "from which model". */
export function StackedBars({
  series,
  formatValue,
  totalLabel
}: {
  series: GroupSeries
  formatValue: (value: number) => string
  totalLabel: string
}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const count = Math.max(1, series.buckets.length)
  // A year of days is 365 columns: the gap has to give before the bars do, or the row overflows the
  // card on both sides. Below ~60 columns there is room to breathe.
  const gap = count > 120 ? 0 : count > 60 ? 1 : 2
  return (
    <div className="relative flex h-full justify-center">
      <div
        className="grid h-full w-full"
        style={{
          gap,
          gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
          // Fills the card so the chart scales with the window; the grid keeps one column per bucket.
          maxWidth: "100%"
        }}
        onMouseLeave={() => setHovered(null)}
      >
        {series.buckets.map((bucket, bucketIndex) => {
          return (
            <div
              key={bucket.key}
              className="flex h-full min-w-0 flex-col-reverse"
              onMouseEnter={() => setHovered(bucketIndex)}
              data-usage-bucket={bucket.key}
            >
              {bucket.values.map((value, index) =>
                value === 0 ? null : (
                  <div
                    key={index}
                    style={{ height: `${(value / series.max) * 100}%`, backgroundColor: seriesColor(index) }}
                  />
                )
              )}
            </div>
          )
        })}
      </div>
      {hovered !== null && (
        <SeriesTooltip
          series={series}
          index={hovered}
          // Column centres, not points: a bar owns the middle of its slot.
          leftPercent={((hovered + 0.5) / count) * 100}
          formatValue={formatValue}
          totalLabel={totalLabel}
        />
      )}
    </div>
  )
}

/** One line per group; `vector-effect` keeps the stroke 1.5px however the box is stretched. */
export function GroupLines({
  series,
  formatValue,
  totalLabel
}: {
  series: GroupSeries
  formatValue: (value: number) => string
  totalLabel: string
}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const width = 100
  const height = 40
  const count = series.buckets.length
  const step = count > 1 ? width / (count - 1) : width
  return (
    <div className="relative h-full w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden="true">
        {series.buckets.map((bucket, bucketIndex) => (
          <line
            key={bucket.key}
            x1={bucketIndex * step}
            x2={bucketIndex * step}
            y1={0}
            y2={height}
            stroke="var(--border)"
            strokeWidth="0.5"
            vectorEffect="non-scaling-stroke"
            opacity="0.4"
          />
        ))}
        {hovered !== null && (
          <line
            x1={hovered * step}
            x2={hovered * step}
            y1={0}
            y2={height}
            stroke="var(--muted-foreground)"
            strokeWidth="0.5"
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
            opacity="0.6"
          />
        )}
        {series.groups.map((group, groupIndex) => {
          const plot = series.buckets.map(
            (bucket, bucketIndex) =>
              [
                bucketIndex * step,
                height - ((bucket.values[groupIndex] ?? 0) / series.max) * (height - 2) - 1
              ] as [number, number]
          )
          return (
            <path
              key={group.key}
              d={smoothPath(plot, height)}
              fill="none"
              stroke={seriesColor(groupIndex)}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
      </svg>
      {/* Hit columns instead of per-point circles: a 1.5px line is impossible to hover. */}
      <div className="absolute inset-0 flex" onMouseLeave={() => setHovered(null)}>
        {series.buckets.map((bucket, bucketIndex) => (
          <span
            key={bucket.key}
            className="h-full min-w-0 flex-1"
            onMouseEnter={() => setHovered(bucketIndex)}
            data-usage-bucket={bucket.key}
          />
        ))}
      </div>
      {hovered !== null && (
        <SeriesTooltip
          series={series}
          index={hovered}
          leftPercent={count > 1 ? (hovered / (count - 1)) * 100 : 50}
          formatValue={formatValue}
          totalLabel={totalLabel}
        />
      )}
    </div>
  )
}

/** Donut of group shares: an arc per slice, drawn as a dash on one circle. Hovering a slice shows
 *  its label and value, so a pie reads as numbers and not just colour. */
export function Donut({
  series,
  formatValue,
  totalLabel
}: {
  series: GroupSeries
  formatValue: (value: number) => string
  totalLabel: string
}) {
  const radius = 34
  const circumference = 2 * Math.PI * radius
  const values = series.groups.map((group) => group.total)
  const total = values.reduce((sum, value) => sum + value, 0)
  const [hovered, setHovered] = useState<number | null>(null)
  const hoveredValue = hovered !== null ? (values[hovered] ?? 0) : 0
  const hoveredShare = total > 0 ? hoveredValue / total : 0
  let offset = 0
  return (
    <div className="relative h-full w-full">
      <svg viewBox="0 0 100 100" className="h-full max-h-[220px] w-full" role="img" aria-hidden="true">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--border)" strokeWidth="14" opacity="0.35" />
        {series.groups.map((group, index) => {
          const value = values[index] ?? 0
          const length = total > 0 ? (value / total) * circumference : 0
          const dash = `${length} ${circumference - length}`
          const element = (
            <circle
              key={group.key}
              cx="50"
              cy="50"
              r={radius}
              fill="none"
              stroke={seriesColor(index)}
              strokeWidth={hovered === index ? 17 : 14}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              transform="rotate(-90 50 50)"
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: "pointer" }}
            />
          )
          offset += length
          return element
        })}
      </svg>
      {hovered !== null && (
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 z-10 min-w-28 -translate-x-1/2 -translate-y-1/2 rounded-md border bg-popover/95 px-2 py-1.5 text-[10px] leading-4 shadow-md backdrop-blur"
          role="tooltip"
        >
          <div className="mb-0.5 flex items-center gap-1.5 font-medium">
            <span className="size-[6px] shrink-0 rounded-[2px]" style={{ backgroundColor: seriesColor(hovered) }} />
            <span className="max-w-40 truncate">{series.groups[hovered]?.label}</span>
          </div>
          <div className="flex items-center justify-between gap-3 whitespace-nowrap">
            <span className="text-muted-foreground">{formatValue(hoveredValue)}</span>
            <span className="tabular-nums">{(hoveredShare * 100).toFixed(1)}%</span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-3 border-t border-[color-mix(in_oklab,var(--border)_60%,transparent)] pt-0.5 whitespace-nowrap">
            <span className="text-muted-foreground">{totalLabel}</span>
            <span className="tabular-nums font-medium">{formatValue(total)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
