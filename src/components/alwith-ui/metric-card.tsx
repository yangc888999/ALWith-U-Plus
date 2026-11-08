import type { ReactNode } from "react"
import { CopyIcon, DownloadIcon, Maximize2Icon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * 指标卡 — the BI cards the company dashboard used before it moved into the preview column:
 * a two-line title, the 口径 line with its group chip, a line chart with dashed gridlines and a
 * comparison series, and a legend underneath.
 *
 * Kept dependency-free (hand-rolled SVG) so the card costs nothing to render inside a scrolled
 * list of a dozen metrics.
 */
export interface MetricSeries {
  label: string
  points: number[]
  /** Solid = this period, dashed amber = the comparison period, grey = an estimate. */
  tone?: "actual" | "previous" | "forecast"
}

export interface MetricCardProps {
  title: string
  /** e.g. 「交易规模 / 近 30 天」 */
  scope?: string
  /** e.g. 「交易」 */
  group?: string
  series: MetricSeries[]
  /** One label per point; the chart prints every fifth one. */
  xLabels: string[]
  /** Big number variant: 「1.2K」 above the chart. */
  value?: string
  /** Deltas under the number, already signed and formatted by the caller. */
  deltas?: { label: string; value: string }[]
  onOpen?: () => void
  className?: string
}

const TONES = {
  actual: { stroke: "var(--metric-actual)", dash: undefined },
  previous: { stroke: "var(--metric-previous)", dash: "5 4" },
  forecast: { stroke: "var(--metric-forecast)", dash: "2 4" }
} as const

/** 1 420 000 → 1.4M, 975.52 → 975.52, 46 600 → 46.6K. */
export function compact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(Math.abs(value) >= 10 ? 1 : 2)
}

/** nice-ish upper bound so the top gridline lands on a round number. */
function ceiling(max: number): number {
  if (max <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(max))
  const scaled = max / magnitude
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
  return step * magnitude
}

export function MetricCard({
  title,
  scope,
  group,
  series,
  xLabels,
  value,
  deltas,
  onOpen,
  className
}: MetricCardProps): ReactNode {
  const width = 320
  const height = 132
  const padLeft = 40
  const padRight = 6
  const padTop = 6
  const padBottom = 20
  const plotWidth = width - padLeft - padRight
  const plotHeight = height - padTop - padBottom

  const flat = series.flatMap((line) => line.points)
  const max = ceiling(Math.max(...flat, 1))
  const count = Math.max(...series.map((line) => line.points.length), 1)
  const x = (index: number): number => padLeft + (count === 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth)
  const y = (point: number): number => padTop + plotHeight - (point / max) * plotHeight

  const ticks = [1, 2 / 3, 1 / 3, 0].map((ratio) => Math.round(max * ratio))
  const labelEvery = Math.max(1, Math.ceil(count / 6))

  return (
    <article
      className={cn(
        "group relative flex flex-col gap-2.5 rounded-xl border border-border/70 bg-card p-4 transition-shadow",
        "hover:shadow-[0_1px_3px_rgba(15,23,42,0.08),0_8px_24px_-12px_rgba(15,23,42,0.18)]",
        className
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 text-[13px] leading-snug font-medium text-foreground">{title}</h3>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {[
            { icon: <CopyIcon className="size-3.5" />, label: "复制" },
            { icon: <DownloadIcon className="size-3.5" />, label: "下载" },
            { icon: <Maximize2Icon className="size-3.5" />, label: "展开" }
          ].map((action) => (
            <button
              key={action.label}
              type="button"
              aria-label={action.label}
              title={action.label}
              onClick={action.label === "展开" ? onOpen : undefined}
              className="rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
            >
              {action.icon}
            </button>
          ))}
        </div>
      </header>

      {(scope !== undefined || group !== undefined) && (
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
          {scope !== undefined && <span className="truncate">数据口径：{scope}</span>}
          {group !== undefined && (
            <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {group}
            </span>
          )}
        </p>
      )}

      {value !== undefined && (
        <div className="flex items-baseline gap-2">
          <span className="text-2xl leading-none font-semibold tracking-tight tabular-nums">{value}</span>
          {deltas !== undefined && (
            <span className="flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
              {deltas.map((delta) => (
                <span key={delta.label} className="tabular-nums">
                  {delta.label} {delta.value}
                </span>
              ))}
            </span>
          )}
        </div>
      )}

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[132px] w-full"
        role="img"
        aria-label={`${title} 走势`}
        preserveAspectRatio="none"
      >
        {ticks.map((tick, index) => {
          const line = padTop + (index / (ticks.length - 1)) * plotHeight
          return (
            <g key={`${tick}-${index}`}>
              <line
                x1={padLeft}
                x2={width - padRight}
                y1={line}
                y2={line}
                stroke="var(--metric-grid)"
                strokeDasharray="3 4"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={padLeft - 6}
                y={line + 3}
                textAnchor="end"
                className="fill-muted-foreground text-[9px] tabular-nums"
              >
                {compact(tick)}
              </text>
            </g>
          )
        })}

        {series.map((line) => {
          const tone = TONES[line.tone ?? "actual"]
          const path = line.points
            .map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(2)},${y(point).toFixed(2)}`)
            .join(" ")
          return (
            <path
              key={line.label}
              d={path}
              fill="none"
              stroke={tone.stroke}
              strokeDasharray={tone.dash}
              strokeWidth={line.tone === "actual" ? 1.6 : 1.3}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )
        })}

        {xLabels.map((label, index) =>
          index % labelEvery === 0 || index === xLabels.length - 1 ? (
            <text
              key={`${label}-${index}`}
              x={x(index)}
              y={height - 6}
              textAnchor={index === 0 ? "start" : index === xLabels.length - 1 ? "end" : "middle"}
              className="fill-muted-foreground text-[9px] tabular-nums"
            >
              {label}
            </text>
          ) : null
        )}
      </svg>

      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        {series.map((line) => {
          const tone = TONES[line.tone ?? "actual"]
          return (
            <li key={line.label} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-0 w-3 border-t-[1.5px]"
                style={{ borderColor: tone.stroke, borderTopStyle: tone.dash === undefined ? "solid" : "dashed" }}
              />
              {line.label}
            </li>
          )
        })}
      </ul>
    </article>
  )
}
