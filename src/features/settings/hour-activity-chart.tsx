// 24 小时活跃度：环形时钟 + 每日连续时间带。
//
// 方格矩阵适合「哪天 × 哪小时」的二维模式识别，但看「我通常几点最活跃」是单维问题：
// WakaTime / Screen Time 这类产品用极坐标时钟（PolarClock）或连续时间带，而不是一排排
// 小方块。这里用 24 根圆头径向条表示各小时总量，0 点在正上方顺时针；下方每天一条无缝
// 圆角时间带保留逐日细节。颜色是连续插值，不是离散色块，稀疏数据也不会显得像棋盘。

import { useState } from "react"
import { useTranslation } from "react-i18next"

import type { HourlyHeat } from "./usage-heatmap"

type Translate = ReturnType<typeof useTranslation>["t"]

const SIZE = 208
const CENTER = SIZE / 2
const INNER = 50
const OUTER = 88
const STROKE = 9
/** Daily strips stay light even for a year-long range; the ring already covers the whole window. */
const MAX_STRIP_DAYS = 21

export type HourTotal = { hour: number; tokens: number; requests: number }

/** Sum every date in the window into 24 hourly totals. */
export function hourTotals(heat: HourlyHeat): HourTotal[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const row = heat.cells[hour] ?? []
    return {
      hour,
      tokens: row.reduce((sum, cell) => sum + cell.tokens, 0),
      requests: row.reduce((sum, cell) => sum + cell.requests, 0)
    }
  })
}

export function peakHour(heat: HourlyHeat): HourTotal | null {
  let best: HourTotal | null = null
  for (const total of hourTotals(heat)) {
    if (total.tokens > 0 && (best === null || total.tokens > best.tokens)) best = total
  }
  return best
}

/** One continuous accent ramp. Square-root keeps low values visible next to a huge peak. */
export function heatColor(value: number, max: number): string {
  if (value <= 0 || max <= 0) return "color-mix(in oklab, var(--muted-foreground) 18%, var(--card))"
  const strength = 18 + Math.sqrt(Math.min(1, value / max)) * 82
  return `color-mix(in oklab, var(--settings-accent) ${strength.toFixed(1)}%, transparent)`
}

/** 0h at twelve o'clock, clockwise. */
function polar(hour: number, radius: number): [number, number] {
  const angle = (hour / 24) * Math.PI * 2 - Math.PI / 2
  return [CENTER + Math.cos(angle) * radius, CENTER + Math.sin(angle) * radius]
}

function clockLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`
}

export function HourActivityChart({
  heat,
  t,
  formatTokens,
  formatCount
}: {
  heat: HourlyHeat
  t: Translate
  formatTokens: (value: number) => string
  formatCount: (value: number) => string
}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const totals = hourTotals(heat)
  const peak = peakHour(heat)
  const largest = Math.max(1, ...totals.map((total) => total.tokens))
  const focus = hovered === null ? peak : totals[hovered] ?? null
  const stripDays = heat.days.slice(-MAX_STRIP_DAYS).reverse()
  const columnOf = new Map(heat.days.map((date, column) => [date, column]))

  return (
    <div className="flex flex-col gap-5 py-2 sm:flex-row sm:items-start">
      {/* Radial clock: 24 rounded bars growing out of a quiet track ring. */}
      <div className="flex shrink-0 flex-col items-center gap-3">
        <div className="relative" style={{ width: SIZE, height: SIZE }}>
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-full" role="img" aria-label={t("usageReport.hourHeatmap")}>
            <circle
              cx={CENTER}
              cy={CENTER}
              r={(INNER + OUTER) / 2}
              fill="none"
              stroke="color-mix(in oklab, var(--muted-foreground) 12%, var(--card))"
              strokeWidth={STROKE + 3}
            />
            {totals.map((total) => {
              const ratio = total.tokens > 0 ? Math.sqrt(total.tokens / largest) : 0
              const [x1, y1] = polar(total.hour, INNER)
              const [x2, y2] = polar(total.hour, INNER + (OUTER - INNER) * Math.max(0.055, ratio))
              return (
                <line
                  key={total.hour}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={heatColor(total.tokens, largest)}
                  strokeWidth={STROKE}
                  strokeLinecap="round"
                  className="cursor-default transition-[stroke] duration-150"
                  onMouseEnter={() => setHovered(total.hour)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <title>{`${clockLabel(total.hour)} · ${formatTokens(total.tokens)} · ${formatCount(total.requests)}`}</title>
                </line>
              )
            })}
          </svg>
          {/* HTML labels, not SVG text: a viewBox would clip anything drawn at the rim. */}
          <span className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 text-[9px] tabular-nums text-muted-foreground">00</span>
          <span className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-[9px] tabular-nums text-muted-foreground">06</span>
          <span className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 text-[9px] tabular-nums text-muted-foreground">12</span>
          <span className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 text-[9px] tabular-nums text-muted-foreground">18</span>
          <div className="pointer-events-none absolute inset-0 grid place-content-center gap-0.5 text-center">
            <span className="text-[10px] text-muted-foreground">
              {hovered === null ? t("usageReport.hourPeak") : clockLabel(hovered)}
            </span>
            <span className="text-xl font-semibold tabular-nums leading-none">
              {focus === null ? "—" : clockLabel(focus.hour)}
            </span>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {focus === null ? t("usageReport.hourHeatmapEmpty") : `${formatTokens(focus.tokens)} · ${formatCount(focus.requests)}`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{t("usageReport.less")}</span>
          <span
            className="h-2 w-24 rounded-full"
            style={{
              background: `linear-gradient(90deg, ${heatColor(0, 1)}, ${heatColor(0.08, 1)}, ${heatColor(0.3, 1)}, ${heatColor(1, 1)})`
            }}
          />
          <span>{t("usageReport.more")}</span>
        </div>
      </div>

      {/* One seamless rounded strip per day: no cells, no borders, no checkerboard. */}
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium">{t("usageReport.hourDailyStrip")}</span>
          <span className="text-[10px] text-muted-foreground">
            {t("usageReport.hourStripRange", { days: Math.min(heat.days.length, MAX_STRIP_DAYS) })}
          </span>
        </div>
        <div className="max-h-[212px] space-y-[3px] overflow-y-auto pe-1">
          {stripDays.map((date) => {
            const column = columnOf.get(date) ?? -1
            return (
              <div key={date} className="flex items-center gap-2">
                <span className="w-11 shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {`${date.slice(5, 7)}/${date.slice(8, 10)}`}
                </span>
                <div className="flex h-[7px] min-w-0 flex-1 overflow-hidden rounded-full bg-muted/25">
                  {Array.from({ length: 24 }, (_, hour) => {
                    const cell = heat.cells[hour]?.[column]
                    return (
                      <span
                        key={hour}
                        className="min-w-0 flex-1"
                        style={{ backgroundColor: heatColor(cell?.tokens ?? 0, heat.max) }}
                        title={`${date} ${clockLabel(hour)} · ${formatTokens(cell?.tokens ?? 0)} · ${formatCount(cell?.requests ?? 0)}`}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
        <div className="mt-1.5 flex justify-between ps-[52px] text-[9px] tabular-nums text-muted-foreground">
          <span>00</span>
          <span>06</span>
          <span>12</span>
          <span>18</span>
          <span>23</span>
        </div>
      </div>
    </div>
  )
}
