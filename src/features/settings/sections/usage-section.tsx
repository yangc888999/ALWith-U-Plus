// 用量: what this Mac's transcripts say the models cost in tokens. Everything on the page is read
// from the machine, so the page opens with a plain "read the ledger" call and no polling — a
// number that only changes when a turn ends does not need a timer.

import { CloudIcon, RefreshCwIcon } from "lucide-react"
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { isTauri } from "@tauri-apps/api/core"

import { commands, type UsageReport } from "@/bindings"
import {
  usePriceStore,
  costOf,
  blankPrice,
  modelMatchKey,
  parseOpenRouterPrices,
  parsePriceArray,
  parseVendorPrices,
  type Currency,
  type ModelPrice
} from "../price-store"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"
import { nativeModelOverrides, providerGroups } from "@/lib/providers"
import { useProviders } from "@/lib/use-providers"

import { SettingsCard, SettingsDetails, SettingsNote } from "./shared"
import { Donut, GroupLines, seriesColor, Spark, StackedBars } from "../usage-charts"
import { WordCloud } from "../usage-word-cloud"
import {
  ALL_GROUP,
  cacheHitRate,
  change,
  cutoff,
  type CostedPoint,
  dailyBuckets,
  dayKey,
  type Grain,
  type GroupBy,
  heatLevel,
  localizeUsageReport,
  longestStreak,
  type Metric,
  monthBlocks,
  monthKeysEndingAt,
  peakDay,
  previousCutoff,
  type Range,
  ranking,
  seriesByGroup,
  sparkline,
  sum,
  utcDayOf,
  within
} from "../usage-data"
import {
  HEAT_RANGES,
  type HeatRange,
  firstLocalDay,
  heatRangeFrom,
  hourlyBuckets
} from "../usage-heatmap"
import { HourActivityChart } from "../hour-activity-chart"

type ChartKind = "bar" | "line" | "pie"

/** 12,345,678 → "1.23 亿" in Chinese, "12.3M" in English. Three significant digits keep a
 *  headline readable; Intl already knows 万/亿 for Chinese. */
function compact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumSignificantDigits: 3 }).format(value)
}

/** Token unit, unified to the metric K / M / B / T ladder regardless of locale, with exactly one
 *  decimal. The overview used 万/亿 before, which made the same number read differently across
 *  languages; one ladder keeps every Token figure comparable at a glance. */
function formatTokens(value: number, locale: string): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? "-" : ""
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(1)}T`
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`
  return exact(value, locale)
}

function exact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value)
}

/** The day before a `yyyy-MM-dd` key, for naming the previous comparison window. */
function dayBefore(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00`)
  date.setDate(date.getDate() - 1)
  return dayKey(date)
}

function percent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value)
}

/** The headline spend figure is RMB: USD-quoted models are converted with the configured rate. */
function money(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "CNY",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 2
  }).format(value)
}

const HEAT_TIERS = [
  "color-mix(in oklab, var(--muted-foreground) 12%, transparent)",
  "color-mix(in oklab, var(--settings-accent) 25%, transparent)",
  "color-mix(in oklab, var(--settings-accent) 45%, transparent)",
  "color-mix(in oklab, var(--settings-accent) 70%, transparent)",
  "var(--settings-accent)"
]

/** One cell of the 3×3 overview: label, figure, period-over-period line, optional sparkline. */
function Stat({
  label,
  value,
  hint,
  delta,
  deltaKind = "relative",
  spark,
  locale,
  tone = "volume",
  info,
  infoContent
}: {
  label: string
  value: string
  hint?: string
  delta?: number | null
  /** A volume reads as a relative %; a rate as percentage points; a day count as whole days. */
  deltaKind?: "relative" | "points" | "days"
  spark?: number[]
  locale: string
  /** "volume" paints more-usage red the way Chinese finance screens do; a rate reads better plain. */
  tone?: "volume" | "neutral"
  /** Optional hover hint rendered as a small "?" badge next to the label. */
  info?: string
  /** Rich hover content for the "?" badge (e.g. the list of unpriced model ids). */
  infoContent?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[11px] leading-4 text-muted-foreground">
        <span>{label}</span>
        {infoContent !== undefined ? (
          <HoverCard>
            <HoverCardTrigger
              render={
                <span
                  role="img"
                  aria-label={info}
                  className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-full border border-current text-[9px] font-bold leading-none"
                >
                  ?
                </span>
              }
            />
            <HoverCardContent className="w-64 text-xs leading-5">
              <div className="mb-1 font-medium">{info}</div>
              {infoContent}
            </HoverCardContent>
          </HoverCard>
        ) : (
          info !== undefined && (
            <span
              role="img"
              aria-label={info}
              title={info}
              className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-full border border-current text-[9px] font-bold leading-none"
            >
              ?
            </span>
          )
        )}
      </div>
      <div className="mt-0.5 flex items-end gap-2">
        <div className="truncate text-lg leading-6 font-semibold tabular-nums">{value}</div>
        {spark !== undefined && <Spark values={spark} className="mb-1 h-4 w-12 shrink-0 text-[var(--settings-accent)]" />}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-1 text-[10px] leading-4">
        {delta !== undefined && delta !== null && (
          <span
            className={cn(
              "tabular-nums",
              tone === "neutral"
                ? "text-muted-foreground"
                : delta > 0
                  ? "text-destructive"
                  : "text-emerald-600 dark:text-emerald-400"
            )}
          >
            {delta > 0 ? "▲" : "▼"}{" "}
            {deltaKind === "points"
              ? t("usageReport.deltaPoints", { value: Math.abs(delta).toFixed(1) })
              : deltaKind === "days"
                ? t("usageReport.deltaDays", { count: Math.round(Math.abs(delta)) })
                : Math.abs(delta) >= 10
                  ? t("usageReport.deltaNew")
                  : percent(Math.abs(delta), locale)}
          </span>
        )}
        {hint !== undefined && <span className="truncate text-muted-foreground">{hint}</span>}
      </div>
    </div>
  )
}

/** A labelled control: the tiny caption above it is what makes five dropdowns readable. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] leading-3 text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function Choice<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="flex rounded-md bg-[color-mix(in_oklab,var(--muted-foreground)_10%,transparent)] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={cn(
            "rounded-[5px] px-2 py-1 text-[11px] leading-4 whitespace-nowrap transition-colors",
            option.value === value
              ? "bg-[var(--card)] text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)]"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** One-click overview windows; the longest three stay behind the Select. */
const QUICK_RANGES: Range[] = ["1d", "3d", "7d"]
const SELECT_RANGES: Range[] = ["30d", "90d", "1y", "6m", "12m"]

/** Quick detail windows, in days back from today; `null` is "all the history the ledger holds". */
const DETAIL_WINDOWS = [
  { daysBack: 0, label: "usageReport.rangeToday" },
  { daysBack: 2, label: "usageReport.range3d" },
  { daysBack: 6, label: "usageReport.range7d" },
  { daysBack: null, label: "usageReport.allTime" }
] as const

/** Rows per page in the log: long enough to scan a day, short enough to page through a month. */
/**
 * The page buttons to show: at most ten, so a long log does not turn the footer into a wall of
 * numbers. `"gap"` stands in for the runs that were collapsed.
 */
function pageItems(page: number, pages: number): Array<number | "gap"> {
  const MAX = 10
  if (pages <= MAX) return Array.from({ length: pages }, (_, index) => index + 1)
  const inner = MAX - 2
  let start = Math.max(2, page - Math.floor(inner / 2))
  const end = Math.min(pages - 1, start + inner - 1)
  start = Math.max(2, end - inner + 1)
  const items: Array<number | "gap"> = [1]
  if (start > 2) items.push("gap")
  for (let index = start; index <= end; index += 1) items.push(index)
  if (end < pages - 1) items.push("gap")
  items.push(pages)
  return items
}

const DETAIL_PAGE_SIZE = 100

/** TOP ranking choices: every integer from 1 to 10, so the chart can show a single model or ten. */
const TOP_OPTIONS = Array.from({ length: 10 }, (_, index) => index + 1)

export function UsageSection() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Only an explicit refresh spins. The first open paints the page shell immediately; the Rust
  // snapshot returns in one cache read and heavy cards mount in later frames (see `stage`).
  const [loading, setLoading] = useState(false)
  // 0 = overview only, 1 = charts, 2 = log + price table. Advancing one step per frame keeps the
  // first paint cheap instead of committing every chart and 100 table rows in a single render.
  const [stage, setStage] = useState(0)
  // Rolled forward whenever the window regains focus: a page left open overnight must not keep
  // calling yesterday "today".
  const [today, setToday] = useState(() => new Date())
  const [range, setRange] = useState<Range>("30d")
  const [metric, setMetric] = useState<Metric>("tokens")
  // 「今日」看的是一天之内的构成，不是趋势：按模型分组、用 Token 衡量、饼图看占比最直观。
  // 这也是分析区的默认视图（饼图没有时间轴，所以粒度固定为总计）。
  const [grain, setGrain] = useState<Grain | "total">("total")
  const [chart, setChart] = useState<ChartKind>("pie")
  const [groupBy, setGroupBy] = useState<GroupBy>("model")
  const [top, setTop] = useState(8)
  // Which months the activity grid shows, and where it ends. Three is the default because one month
  // hides the trend and twelve shrinks every cell to a dot.
  const [monthSpan, setMonthSpan] = useState<3 | 6 | 12>(6)
  const [anchorMonth, setAnchorMonth] = useState(() => dayKey(new Date()).slice(0, 7))
  // The 24-hour grid has its own window, independent of the overview's `range` picker.
  const [heatRange, setHeatRange] = useState<HeatRange>("7d")
  // The log is the record of every call, not just today's: it opens on the whole history (the
  // ledger keeps the newest 2000 calls) and pages through it 50 rows at a time.
  const [detailFrom, setDetailFrom] = useState("")
  const [detailTo, setDetailTo] = useState(() => dayKey(new Date()))
  // The two date inputs hold a draft. Filtering uses the applied pair above, so picking a start
  // date no longer empties the table while the end date is still being chosen; 「查询」 commits both.
  const [draftFrom, setDraftFrom] = useState("")
  const [draftTo, setDraftTo] = useState(() => dayKey(new Date()))
  const [detailPage, setDetailPage] = useState(1)
  // Log filters: narrow the record by vendor (provider) and model id before paging.
  const [detailVendor, setDetailVendor] = useState("")
  const [detailModel, setDetailModel] = useState("")
  // Each page holds 100 rows, but only 20 paint at first; scrolling the table loads the rest.
  const [visibleRows, setVisibleRows] = useState(20)

  // Selecting 「今日」 restores the analysis defaults above. It fires only on the transition into
  // 1d, so a manual choice made afterwards survives, and the overview's own 30d default is left
  // alone (every card on this page shares `range`).
  const previousRange = useRef(range)
  useEffect(() => {
    if (range === "1d" && previousRange.current !== "1d") {
      setGroupBy("model")
      setMetric("tokens")
      setChart("pie")
      setGrain("total")
    }
    previousRange.current = range
  }, [range])

  // The ledger stores raw model ids. The model settings page owns the display names the user typed
  // for custom providers and for the built-in GPT rows, so the legend shows those instead of long
  // ids. A model that was never renamed keeps its id; the full id stays in the legend tooltip.
  const providers = useProviders()
  const modelNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const model of nativeModelOverrides() ?? []) {
      const id = model.api_id.trim()
      const label = model.label.trim()
      if (id !== "" && label !== "" && label !== id) names.set(id, label)
    }
    if (providers !== null) {
      for (const group of providerGroups(providers)) {
        for (const model of group.models) {
          const label = model.label?.trim() ?? ""
          if (label !== "" && label !== model.id) names.set(model.id, label)
        }
      }
    }
    return names
  }, [providers])

  const load = useCallback(async (force = false): Promise<void> => {
    if (!isTauri()) return
    if (force) setLoading(true)
    setError(null)
    try {
      // The engine files calls under UTC days. Localize once at the boundary, so every range,
      // chart and the log agree with the local dates the reader picked. A normal read returns the
      // last snapshot instantly — even an expired one — while Rust rebuilds in the background.
      setReport(
        localizeUsageReport(await (force ? commands.usageReportRefresh() : commands.usageReport()))
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Stale-while-revalidate: an expired snapshot arrives with `pending`, and the rebuild runs off
  // the main thread. Poll quietly (no spinner, no skeleton) until the fresh snapshot lands.
  // A self-rescheduling timer is used instead of an effect keyed on `updatedAt`: while the
  // rebuild runs the timestamp does not change, so a dependency-based effect would schedule
  // exactly one poll and then stop. A hard cap keeps a wedged rebuild from polling forever.
  const pending = report?.pending === true
  useEffect(() => {
    if (!pending) return
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      attempts += 1
      await load()
      if (!cancelled && attempts < 24) timer = setTimeout(() => void poll(), 2500)
    }
    timer = setTimeout(() => void poll(), 2500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pending, load])

  // Only the first report triggers the staged mount. A later snapshot replaces numbers in place —
  // resetting the stage here would make every card disappear and reappear on each background poll.
  const staged = useRef(false)
  useEffect(() => {
    if (report === null || staged.current) return
    staged.current = true
    const first = setTimeout(() => setStage(1), 0)
    const second = setTimeout(() => setStage(2), 90)
    return () => {
      clearTimeout(first)
      clearTimeout(second)
    }
  }, [report])

  // The settings window is reused, not recreated, so the calendar has to roll forward at midnight
  // or "今日" and a custom single day keep showing yesterday. The ledger itself is a 30-minute
  // snapshot in Rust: re-reading on every focus still deserialised ~190 KB and recomputed every
  // chart for numbers that had not changed. Only re-read once the snapshot expires; the refresh
  // button is the explicit way to force a rebuild.
  const lastRefresh = useRef(Date.now())
  useEffect(() => {
    const refresh = (): void => {
      const now = new Date()
      if (dayKey(today) !== dayKey(now)) {
        const previousToday = dayKey(today)
        const nextToday = dayKey(now)
        setToday(now)
        setDetailTo((current) => (current === previousToday ? nextToday : current))
        setDraftTo((current) => (current === previousToday ? nextToday : current))
      }
      if (Date.now() - lastRefresh.current < 30 * 60_000) return
      lastRefresh.current = Date.now()
      void load()
    }
    window.addEventListener("focus", refresh)
    const onVisible = (): void => {
      if (document.visibilityState === "visible") refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [load, today])

  const from = cutoff(range, today)
  const to = dayKey(today)
  const previousFrom = useMemo(() => previousCutoff(range, today), [range, today])

  // Prices come first: the analysis view's "cost" metric reads them while bucketing.
  const {
    prices,
    usdToCny,
    utcOffset,
    vendorSources,
    setPrices,
    setUsdToCny,
    setUtcOffset,
    setVendorSource,
    resetPrices
  } = usePriceStore()

  const view = useMemo(() => {
    const all: CostedPoint[] = (report?.points ?? []).map((point) => ({
      ...point,
      // Pricing still wants the original UTC day/hour bucket, not the localized calendar day.
      cost: costOf({ ...point, date: utcDayOf(point) }, prices, usdToCny, utcOffset) ?? 0
    }))
    const points = within(all, from, to)
    const earlier = all.filter((point) => point.date >= previousFrom && point.date < from)
    const totals = sum(points)
    const previous = sum(earlier)
    const days = dailyBuckets(points, from, to)
    const peak = peakDay(days)
    const models = ranking(points, "model", "tokens", 1)
    const topModel = models[0] === undefined ? undefined : {
      ...models[0],
      label: modelNames.get(models[0].key) ?? models[0].label
    }
    const activeDays = days.filter((day) => day.requests > 0).length
    const streak = longestStreak(days)
    const previousDays = dailyBuckets(earlier, previousFrom, from)
    // "全部" is one series; its label is a UI word, not a model id, so it is translated here.
    const allLabel = t("usageReport.groupAll")
    const groups = ranking(points, groupBy, metric, top).map((entry) => ({
      ...entry,
      label: entry.key === ALL_GROUP ? allLabel : (modelNames.get(entry.key) ?? entry.label)
    }))
    const stackedRaw = seriesByGroup(points, grain === "total" ? "day" : grain, groupBy, metric, top, from, to)
    const stacked = {
      ...stackedRaw,
      groups: stackedRaw.groups.map((group) => ({
        ...group,
        label: group.key === ALL_GROUP ? allLabel : (modelNames.get(group.key) ?? group.label)
      }))
    }
    return {
      points,
      totals,
      previous,
      days,
      peak,
      topModel,
      streak,
      activeDays,
      previousActiveDays: previousDays.filter((day) => day.requests > 0).length,
      source: report?.source ?? "",
      scanned: report?.scanned ?? 0,
      groups,
      stacked,
      sparks: {
        tokens: sparkline(days, "tokens"),
        requests: sparkline(days, "requests")
      },
      // Per-day spend, for the cost stat's daily-trend sparkline.
      dailyCost: days.map((day) => day.cost)
    }
  }, [report, from, to, previousFrom, grain, groupBy, metric, top, prices, usdToCny, utcOffset, t, modelNames])

  // Analysis reuses the overview's range: one window drives both cards, so the chart always
  // matches what the stat blocks above it are summarizing.
  const analysisRange = useMemo(() => ({ from, to }), [from, to])

  const analysisView = useMemo(() => {
    const points = (report?.points ?? [])
      .map((point) => ({ ...point, cost: costOf({ ...point, date: utcDayOf(point) }, prices, usdToCny, utcOffset) ?? 0 }))
      .filter((point) => point.date >= analysisRange.from && point.date <= analysisRange.to)
    const allLabel = t("usageReport.groupAll")
    const groups = ranking(points, groupBy, metric, top).map((entry) => ({
      ...entry,
      label: entry.key === ALL_GROUP ? allLabel : (modelNames.get(entry.key) ?? entry.label)
    }))
    const stackedRaw = seriesByGroup(points, grain === "total" ? "day" : grain, groupBy, metric, top, analysisRange.from, analysisRange.to)
    const stacked = {
      ...stackedRaw,
      groups: stackedRaw.groups.map((group) => ({
        ...group,
        label: group.key === ALL_GROUP ? allLabel : (modelNames.get(group.key) ?? group.label)
      }))
    }
    return { groups, stacked }
  }, [report, analysisRange, grain, groupBy, metric, top, prices, usdToCny, utcOffset, t, modelNames])

  // ---- Model prices & estimated spend ------------------------------------------------
  const patchPrice = (index: number, patch: Partial<ModelPrice>) => {
    setPrices(prices.map((price, i) => (i === index ? { ...price, ...patch } : price)))
  }

  const updatePrice = (index: number, field: "input" | "cached" | "output", raw: string) => {
    patchPrice(index, { [field]: Number(raw) || 0 })
  }

  const updateOffPeak = (index: number, field: "input" | "cached" | "output", raw: string) => {
    const price = prices[index]
    const offPeak = price.offPeak ?? { input: 0, cached: 0, output: 0 }
    patchPrice(index, { offPeak: { ...offPeak, [field]: Number(raw) || 0 } })
  }

  /** The table is grouped by vendor; a vendor exists as long as one model carries its name. */
  const vendorGroups = useMemo(() => {
    const groups = new Map<string, Array<{ price: ModelPrice; index: number }>>()
    prices.forEach((price, index) => {
      const rows = groups.get(price.vendor) ?? []
      rows.push({ price, index })
      groups.set(price.vendor, rows)
    })
    return Array.from(groups.entries())
  }, [prices])

  const addVendor = () => {
    let name = t("usageReport.newVendor")
    let suffix = 2
    while (prices.some((price) => price.vendor === name)) {
      name = `${t("usageReport.newVendor")}${suffix}`
      suffix += 1
    }
    setPrices([...prices, blankPrice(name)])
  }

  const addModel = (vendor: string) => setPrices([...prices, blankPrice(vendor)])
  const renameVendor = (from: string, to: string) =>
    setPrices(prices.map((price) => (price.vendor === from ? { ...price, vendor: to } : price)))
  const removeVendor = (vendor: string) => setPrices(prices.filter((price) => price.vendor !== vendor))
  const removeModel = (index: number) => setPrices(prices.filter((_, i) => i !== index))

  // JSON export/import keeps the price table portable: copy it out as a backup, or paste a saved
  // snapshot back in. The same parser as the remote updater validates the shape.
  const fileInputRef = useRef<HTMLInputElement>(null)
  const exportPrices = useCallback(() => {
    const json = JSON.stringify(prices, null, 2)
    void navigator.clipboard?.writeText(json)
    setUpdateState({ status: "ok", msg: t("usageReport.exportOk") })
  }, [prices, t])
  const importPricesFromFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const next = parsePriceArray(JSON.parse(String(reader.result)))
        if (next.length === 0) throw new Error("no model prices found")
        setPrices(next)
        setUpdateState({ status: "ok", msg: t("usageReport.importOk", { count: next.length }) })
      } catch (cause) {
        setUpdateState({
          status: "error",
          msg: t("usageReport.importFailed", { error: cause instanceof Error ? cause.message : String(cause) })
        })
      }
    }
    reader.onerror = () => setUpdateState({ status: "error", msg: t("usageReport.importFailed", { error: "read error" }) })
    reader.readAsText(file)
  }

  const [updateState, setUpdateState] = useState<{ status: "idle" | "loading" | "ok" | "error"; msg?: string }>({
    status: "idle"
  })

  // Per-vendor one-click update: fetch that vendor's official pricing page, run its regex, and swap
  // that vendor's rows only. Other vendors are untouched; a bad/empty regex throws and leaves the
  // table intact (an empty result can never wipe a vendor).
  const [vendorStatus, setVendorStatus] = useState<Record<string, { status: "loading" | "ok" | "error"; msg?: string }>>({})

  const updateVendor = useCallback(
    async (vendor: string) => {
      const source = vendorSources[vendor]
      if (source === undefined || source.url.trim() === "") {
        setVendorStatus((current) => ({ ...current, [vendor]: { status: "error", msg: t("usageReport.vendorUrlEmpty") } }))
        return
      }
      setVendorStatus((current) => ({ ...current, [vendor]: { status: "loading" } }))
      try {
        const text = await commands.fetchText({ url: source.url.trim() })
        const parsed =
          source.openrouter === undefined
            ? parseVendorPrices(text, source.regex)
            : parseOpenRouterPrices(text, source.openrouter)
        // Match on a dot/dash-folded key: vendors quote `claude-opus-5.5` while the table says
        // `claude-opus-5-5`, and xAI writes `grok-4-7` for the app's `grok-4.7`.
        const parsedByModel = new Map(parsed.map((row) => [modelMatchKey(row.model), row]))
        const existing = prices.filter((price) => price.vendor === vendor)
        // A fresh vendor takes the whole parsed list; an existing one only refreshes the models it
        // already tracks (official pages list dozens we don't care about, and a flood of new rows
        // would bury a curated table). No match at all → surface it instead of silently doing nothing.
        if (existing.length === 0) {
          const added = parsed.map((row) => ({
            ...blankPrice(vendor),
            model: row.model,
            currency: source.currency,
            input: row.input ?? 0,
            cached: row.cached ?? 0,
            output: row.output ?? 0
          }))
          setPrices([...prices, ...added])
          setVendorStatus((current) => ({
            ...current,
            [vendor]: { status: "ok", msg: t("usageReport.vendorUpdated", { count: added.length }) }
          }))
          return
        }
        let updated = 0
        const merged = prices.map((price) => {
          if (price.vendor !== vendor) return price
          const hit = parsedByModel.get(modelMatchKey(price.model))
          if (hit === undefined) return price
          updated += 1
          // A field the page does not publish keeps its current value (Qwen's cache price lives in
          // a separate table, for example), so an update never zeroes a number it couldn't read.
          return {
            ...price,
            currency: source.currency,
            input: hit.input ?? price.input,
            cached: hit.cached ?? price.cached,
            output: hit.output ?? price.output
          }
        })
        if (updated === 0) throw new Error(t("usageReport.vendorNoMatch", { count: parsed.length }))
        setPrices(merged)
        setVendorStatus((current) => ({
          ...current,
          [vendor]: { status: "ok", msg: t("usageReport.vendorUpdated", { count: updated }) }
        }))
      } catch (cause) {
        setVendorStatus((current) => ({
          ...current,
          [vendor]: {
            status: "error",
            msg: t("usageReport.vendorUpdateFailed", { error: cause instanceof Error ? cause.message : String(cause) })
          }
        }))
      }
    },
    [vendorSources, prices, setPrices, t]
  )

  const cost = useMemo(() => {
    let total = 0
    const unpriced = new Set<string>()
    const priced = new Set<string>()
    for (const point of view.points) {
      const value = costOf(point, prices, usdToCny, utcOffset)
      if (value === null) unpriced.add(point.model)
      else {
        total += value
        priced.add(point.model)
      }
    }
    return { total, unpriced: unpriced.size, priced: priced.size, unpricedModels: [...unpriced].sort() }
  }, [view.points, prices, usdToCny, utcOffset])

  /** Models that actually appear in the current window — what the price table is really pricing. */
  const usedModels = useMemo(() => {
    const set = new Set<string>()
    for (const point of view.points) if (point.model !== "") set.add(point.model)
    return set
  }, [view.points])

  // A pie has no time axis and a line needs one, so those two choices move the granularity rather
  // than sitting there doing nothing.
  const chooseChart = (next: ChartKind) => {
    setChart(next)
    if (next === "pie" && grain !== "total") setGrain("total")
    if (next === "line" && grain === "total") setGrain("day")
  }
  const chooseGrain = (next: Grain | "total") => {
    setGrain(next)
    if (next === "total" && chart === "line") setChart("bar")
    if (next !== "total" && chart === "pie") setChart("bar")
  }

  const heat = useMemo(() => {
    const keys = monthKeysEndingAt(anchorMonth, monthSpan)
    if (keys.length === 0) return { blocks: [], max: 1 }
    const blocks = monthBlocks(dailyBuckets(report?.points ?? [], `${keys[0]}-01`, to), keys)
    const max = Math.max(1, ...blocks.flatMap((block) => block.cells.map((cell) => cell.tokens)))
    return { blocks, max }
  }, [report, anchorMonth, monthSpan, to])

  // The 24-hour grid converts each UTC (day, hour) bucket to the reader's local day AND hour from
  // one instant (see usage-heatmap.ts), so UTC+8 no longer shifts the whole sheet by eight hours.
  const hourHeat = useMemo(() => {
    const points = report?.points ?? []
    const from = heatRangeFrom(heatRange, today, firstLocalDay(points))
    return hourlyBuckets(points, from, dayKey(today))
  }, [report, heatRange, today])

  // Once the report lands, open the grid on the newest month that actually has data: a fresh install
  // in a quiet month would otherwise greet the user with three empty calendars.
  const anchored = useRef(false)
  useEffect(() => {
    if (anchored.current) return
    const last = report?.last
    if (last === null || last === undefined) return
    anchored.current = true
    const current = dayKey(new Date()).slice(0, 7)
    if (last.slice(0, 7) < current) setAnchorMonth(last.slice(0, 7))
  }, [report])

  const monthLabel = useCallback(
    (key: string) => {
      const [year, month] = key.split("-").map(Number)
      return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(new Date(year, month - 1, 1))
    },
    [locale]
  )

  // Newest first, and long enough to reach back over everything the ledger holds.
  const monthOptions = useMemo(() => {
    const current = to.slice(0, 7)
    const newest = report?.last === null || report?.last === undefined || report.last.slice(0, 7) < current ? current : report.last.slice(0, 7)
    return monthKeysEndingAt(newest, 12).reverse()
  }, [report, to])

  const detailTurns = useMemo(
    () =>
      (report?.recent ?? []).filter(
        (turn) =>
          (detailFrom === "" || turn.date >= detailFrom) &&
          turn.date <= detailTo &&
          (detailVendor === "" || turn.provider === detailVendor) &&
          (detailModel === "" || turn.model === detailModel)
      ),
    [report, detailFrom, detailTo, detailVendor, detailModel]
  )
  // Vendor and model id options derive from the ledger itself, so the dropdowns only ever offer
  // ids that actually appear in the log.
  const detailVendors = useMemo(() => {
    const set = new Set<string>()
    for (const turn of report?.recent ?? []) if (turn.provider !== "") set.add(turn.provider)
    return [...set].sort()
  }, [report])
  const detailModels = useMemo(() => {
    const set = new Set<string>()
    for (const turn of report?.recent ?? []) if (turn.model !== "") set.add(turn.model)
    return [...set].sort()
  }, [report])
  const detailPages = Math.max(1, Math.ceil(detailTurns.length / DETAIL_PAGE_SIZE))
  const currentPage = Math.min(detailPage, detailPages)
  const pageRows = detailTurns.slice((currentPage - 1) * DETAIL_PAGE_SIZE, currentPage * DETAIL_PAGE_SIZE)
  // The page holds up to 100 rows, but only the first 20 paint; scrolling the table loads more.
  const rows = pageRows.slice(0, visibleRows)

  // Any filter change rebuilds the list: drop back to page 1 and re-show only the first 20 rows.
  useEffect(() => {
    setDetailPage(1)
    setVisibleRows(20)
  }, [detailFrom, detailTo, detailVendor, detailModel])

  /** Paging starts a fresh page: its own first 20 rows, not however far the last one was scrolled. */
  const goToDetailPage = (page: number): void => {
    setDetailPage(page)
    setVisibleRows(20)
  }

  const todayKey = dayKey(today)
  /** Local calendar day, so a DST change cannot shift the window by an hour into yesterday. */
  const dayBack = (days: number): string =>
    dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - days))
  /** "今日 / 近 3 天 / 近 7 天 / 全部": the windows the log actually needs, one click each. */
  const setDetailWindow = (daysBack: number | null): void => {
    const from = daysBack === null ? "" : dayBack(daysBack)
    // Quick ranges are one decision, not a two-field form: they still apply immediately.
    setDetailTo(todayKey)
    setDetailFrom(from)
    setDraftTo(todayKey)
    setDraftFrom(from)
  }
  /** The custom range is one action: only pressing 查询 repaints the log. */
  const applyDetailRange = (): void => {
    setDetailFrom(draftFrom)
    setDetailTo(draftTo)
    setDetailPage(1)
    setVisibleRows(20)
  }

  const dayAverage = view.activeDays === 0 ? 0 : Math.round(view.totals.tokens / view.activeDays)
  const dailyAvgCost = view.activeDays === 0 ? 0 : cost.total / view.activeDays
  const timeSeries = grain !== "total"
  /** Chart tooltips read in the same unit as the selected metric. */
  const formatMetric = (value: number): string =>
    metric === "cost" ? money(value, locale) : metric === "tokens" ? formatTokens(value, locale) : exact(value, locale)

  return (
    <>
      <SettingsCard
        title={t("usageReport.overview")}
        desc={t("usageReport.compareWindow", {
          from,
          to,
          previousFrom,
          previousTo: dayBefore(from)
        })}
        action={
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
            {/* 今日 / 近 3 天 / 近 7 天 are one click away; the Select keeps the longer windows and
                the custom one. */}
            {QUICK_RANGES.map((quick) => (
              <button
                key={quick}
                type="button"
                aria-pressed={range === quick}
                onClick={() => setRange(quick)}
                className={`h-7 rounded-md border px-2 text-xs transition-colors ${
                  range === quick
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-input text-muted-foreground hover:bg-muted"
                }`}
              >
                {t(`usageReport.range.${quick}`)}
              </button>
            ))}
            <Select
              items={SELECT_RANGES.map((option) => ({ value: option, label: t(`usageReport.range.${option}`) }))}
              value={range}
              onValueChange={(value) => setRange(value as Range)}
            >
              <SelectTrigger size="sm" aria-label={t("usageReport.rangeLabel")} className="w-[112px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SELECT_RANGES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(`usageReport.range.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("usageReport.refresh")}
              title={t("usageReport.refresh")}
              disabled={loading}
              onClick={() => void load(true)}
            >
              <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} aria-hidden="true" />
            </Button>
          </div>
        }
      >
        {report !== null && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[11px] leading-4 text-muted-foreground">
            {pending && <span>{t("usageReport.building")}</span>}
            {(report.updatedAt ?? 0) > 0 && (
              <span>
                {t("usageReport.snapshotAt", {
                  time: new Date(report.updatedAt ?? 0).toLocaleString(locale)
                })}
              </span>
            )}
          </div>
        )}
        {error !== null ? (
          <p role="alert" className="py-3 text-xs text-destructive">
            {error}
          </p>
        ) : report === null ? (
          <SettingsNote>{t("usageReport.loading")}</SettingsNote>
        ) : view.points.length === 0 ? (
          <div className="py-4">
            <p className="text-sm font-medium">{pending ? t("usageReport.building") : t("usageReport.empty")}</p>
            {!pending && <p className="mt-1 text-xs text-muted-foreground">{t("usageReport.emptyHint")}</p>}
          </div>
        ) : (
          /* Default 3×3: nine stats, three columns, three rows at the settings window's default
             width (see SETTINGS_DEFAULT_WIDTH). It never grows past three columns when the window
             is dragged wider; only a deliberately narrowed window drops to two to stay legible. */
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 py-3 min-[860px]:grid-cols-3">
            <Stat
              label={t("usageReport.tokens")}
              value={formatTokens(view.totals.tokens, locale)}
              hint={`${t("usageReport.dailyAverage")} ${formatTokens(dayAverage, locale)}`}
              delta={change(view.totals.tokens, view.previous.tokens)}
              spark={view.sparks.tokens}
              locale={locale}
            />
            <Stat
              label={t("usageReport.requests")}
              value={exact(view.totals.requests, locale)}
              hint={`${t("usageReport.activeDays")} ${t("usageReport.dayUnit", { count: view.activeDays })}`}
              delta={change(view.totals.requests, view.previous.requests)}
              spark={view.sparks.requests}
              locale={locale}
            />
            {/* The three cards that carry a daily trend line live together at the front, so the
                first row always reads as "volume · traffic · spend" instead of splitting spend
                off into the second row. */}
            <Stat
              label={t("usageReport.cost")}
              value={money(cost.total, locale)}
              info={t("usageReport.costInfo", { rate: usdToCny })}
              infoContent={
                <>
                  <p className="text-muted-foreground">
                    {t("usageReport.costMatched", { priced: cost.priced, unpriced: cost.unpriced })}
                  </p>
                  {cost.unpricedModels.length > 0 ? (
                    <div className="mt-1.5">
                      <div className="mb-1 text-muted-foreground">{t("usageReport.unpricedModels")}</div>
                      <div className="flex flex-wrap gap-1">
                        {cost.unpricedModels.map((id) => (
                          <span
                            key={id}
                            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
                          >
                            {id}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <p className="mt-1.5 text-muted-foreground">{t("usageReport.costNote")}</p>
                </>
              }
              hint={t("usageReport.costDailyAvg", { value: money(dailyAvgCost, locale) })}
              spark={view.dailyCost}
              locale={locale}
            />
            <Stat
              label={t("usageReport.cacheHit")}
              value={percent(cacheHitRate(view.totals), locale)}
              // The cached/total raw numbers used to sit here as a 30-character fraction; the rate
              // above already says it, and the exact counts live in the request log. A rate moves
              // in points, not in percent, or 90% vs 52% would read as "+73.8%" instead of +38.4pp.
              delta={(cacheHitRate(view.totals) - cacheHitRate(view.previous)) * 100}
              deltaKind="points"
              tone="neutral"
              locale={locale}
            />
            <Stat
              label={t("usageReport.activeDays")}
              value={exact(view.activeDays, locale)}
              hint={`${t("usageReport.streak")} ${t("usageReport.dayUnit", { count: view.streak })}`}
              delta={view.activeDays - view.previousActiveDays}
              deltaKind="days"
              locale={locale}
            />
            <Stat
              label={t("usageReport.dailyAverage")}
              value={formatTokens(dayAverage, locale)}
              hint={t("usageReport.perActiveDay")}
              locale={locale}
            />
            <Stat
              label={t("usageReport.peak")}
              value={view.peak === null ? "—" : formatTokens(view.peak.tokens, locale)}
              hint={view.peak?.date}
              locale={locale}
            />
            <Stat
              label={t("usageReport.topModel")}
              value={view.topModel?.label ?? "—"}
              hint={view.topModel === undefined ? undefined : formatTokens(view.topModel.tokens, locale)}
              locale={locale}
            />
            <Stat
              label={t("usageReport.streak")}
              value={t("usageReport.dayUnit", { count: view.streak })}
              hint={`${t("usageReport.activeDays")} ${view.activeDays}`}
              locale={locale}
            />
          </div>
        )}
      </SettingsCard>

      {/* One frame for the overview, one for the charts, one for the log and the price table.
          The numbers are all in memory already; this only spreads the SVG layout and the 100-row
          table across frames so the page is interactive from the very first paint. */}
      {view.points.length > 0 && stage === 0 && (
        <SettingsCard title={t("usageReport.analysis")} desc={t("usageReport.analysisDesc")}>
          <SettingsNote>{t("usageReport.loading")}</SettingsNote>
        </SettingsCard>
      )}

      {view.points.length > 0 && stage >= 1 && (
        <>
          <SettingsCard title={t("usageReport.analysis")} desc={t("usageReport.analysisDesc")}>
            <div className="flex flex-wrap items-end gap-x-3 gap-y-2 py-3">
              <Field label={t("usageReport.group")}>
                <Select
                  items={[
                    { value: "model", label: t("usageReport.byModel") },
                    { value: "provider", label: t("usageReport.byProvider") },
                    { value: "all", label: t("usageReport.groupAll") }
                  ]}
                  value={groupBy}
                  onValueChange={(value) => setGroupBy(value as GroupBy)}
                >
                  <SelectTrigger size="sm" aria-label={t("usageReport.group")} className="w-[96px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="model">{t("usageReport.byModel")}</SelectItem>
                    <SelectItem value="provider">{t("usageReport.byProvider")}</SelectItem>
                    <SelectItem value="all">{t("usageReport.groupAll")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("usageReport.metric")}>
                <Select
                  items={[
                    { value: "tokens", label: t("usageReport.metricTokens") },
                    { value: "requests", label: t("usageReport.metricRequests") },
                    { value: "cost", label: t("usageReport.metricCost") }
                  ]}
                  value={metric}
                  onValueChange={(value) => setMetric(value as Metric)}
                >
                  <SelectTrigger size="sm" aria-label={t("usageReport.metric")} className="w-[104px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tokens">{t("usageReport.metricTokens")}</SelectItem>
                    <SelectItem value="requests">{t("usageReport.metricRequests")}</SelectItem>
                    <SelectItem value="cost">{t("usageReport.metricCost")}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("usageReport.top")}>
                <Select
                  items={TOP_OPTIONS.map((count) => ({ value: String(count), label: String(count) }))}
                  value={String(top)}
                  onValueChange={(value) => setTop(Number(value))}
                >
                  <SelectTrigger size="sm" aria-label={t("usageReport.top")} className="w-[64px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOP_OPTIONS.map((count) => (
                      <SelectItem key={count} value={String(count)}>
                        {count}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("usageReport.chart")}>
                <Choice
                  value={chart}
                  options={[
                    { value: "bar" as ChartKind, label: t("usageReport.chartBar") },
                    { value: "line" as ChartKind, label: t("usageReport.chartLine") },
                    { value: "pie" as ChartKind, label: t("usageReport.chartPie") }
                  ]}
                  onChange={chooseChart}
                />
              </Field>
              <Field label={t("usageReport.grain")}>
                <Choice
                  value={grain}
                  options={[
                    { value: "total" as const, label: t("usageReport.grainTotal") },
                    { value: "day" as const, label: t("usageReport.grainDay") },
                    { value: "week" as const, label: t("usageReport.grainWeek") },
                    { value: "month" as const, label: t("usageReport.grainMonth") }
                  ]}
                  onChange={chooseGrain}
                />
              </Field>
            </div>

            <div className="h-72 pb-1">
              {chart === "pie" ? (
                <div className="flex h-full items-center justify-center">
                  <Donut
                    series={analysisView.stacked}
                    formatValue={formatMetric}
                    totalLabel={t("usageReport.columnTotal")}
                  />
                </div>
              ) : timeSeries ? (
                chart === "line" ? (
                  <GroupLines
                    series={analysisView.stacked}
                    formatValue={formatMetric}
                    totalLabel={t("usageReport.columnTotal")}
                  />
                ) : (
                  <StackedBars
                    series={analysisView.stacked}
                    formatValue={formatMetric}
                    totalLabel={t("usageReport.columnTotal")}
                  />
                )
              ) : (
                <ul className="flex h-full flex-col justify-center gap-2 overflow-y-auto">
                  {analysisView.groups.map((entry, index) => (
                    <li key={entry.key} className="min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[11px]">{entry.label}</span>
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {metric === "cost"
                            ? money(entry.cost, locale)
                            : metric === "tokens"
                              ? formatTokens(entry.tokens, locale)
                              : compact(entry.requests, locale)}{" "}
                          · {percent(entry.share, locale)}
                        </span>
                      </div>
                      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--muted-foreground)_12%,transparent)]">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.max(2, entry.share * 100)}%`, backgroundColor: seriesColor(index) }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {chart !== "pie" && timeSeries && (
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                <span>{analysisView.stacked.buckets[0]?.label}</span>
                <span>{analysisView.stacked.buckets.at(-1)?.label}</span>
              </div>
            )}
            {/* One shared legend for every chart kind, including the pie: all entries sit below the
                chart and are centred. The pie used to have none, so its slices were unreadable
                without hovering each one. */}
            <div data-usage-legend className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 pb-3 text-[10px] text-muted-foreground">
              {analysisView.stacked.groups.map((group, index) => (
                <span key={group.key} className="flex items-center gap-1">
                  <span className="size-[7px] rounded-[2px]" style={{ backgroundColor: seriesColor(index) }} />
                  <span className="max-w-[9rem] truncate" title={group.key.startsWith("__") ? undefined : group.key}>{group.label}</span>
                </span>
              ))}
            </div>
          </SettingsCard>
          <SettingsCard
            title={t("usageReport.wordCloud")}
            desc={t("usageReport.wordCloudDesc")}
            icon={<CloudIcon className="size-4" />}
          >
            <WordCloud prompts={report?.prompts ?? []} />
          </SettingsCard>
          <SettingsCard
            title={t("usageReport.heatmap")}
            desc={t("usageReport.heatmapDesc")}
            action={
              <div className="flex items-center gap-1">
                <Select
                  items={([3, 6, 12] as const).map((count) => ({
                    value: String(count),
                    label: t("usageReport.monthSpanOption", { count })
                  }))}
                  value={String(monthSpan)}
                  onValueChange={(value) => setMonthSpan(Number(value) as 3 | 6 | 12)}
                >
                  <SelectTrigger size="sm" aria-label={t("usageReport.monthSpan")} className="w-[92px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {([3, 6, 12] as const).map((count) => (
                      <SelectItem key={count} value={String(count)}>
                        {t("usageReport.monthSpanOption", { count })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  items={monthOptions.map((key) => ({ value: key, label: monthLabel(key) }))}
                  value={anchorMonth}
                  onValueChange={(value) => value !== null && setAnchorMonth(value)}
                >
                  <SelectTrigger size="sm" aria-label={t("usageReport.monthAnchor")} className="w-[116px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {monthOptions.map((key) => (
                      <SelectItem key={key} value={key}>
                        {monthLabel(key)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            }
          >
            <div className="py-3">
              {/* One block per month, each drawing exactly as many cells as the month has days.
                  Cells keep a fixed 14px footprint: stretching them to fill the card made the sheet
                  read as a coarse colour board, and a 3-month range looked different from a 6-month
                  one. Fewer months centre instead of growing. */}
              <div className="grid grid-cols-3 justify-start gap-x-4 gap-y-3 sm:grid-cols-6">
                {heat.blocks.map((block) => (
                  // Fluid block: the column decides its width, the cells follow. A fixed 99px block
                  // inside a 1/6 column overflowed the column on a narrow window and the months
                  // drew on top of each other. `max-w` keeps a wide window from inflating them.
                  <div key={block.key} className="w-full min-w-0 max-w-[99px] justify-self-start">
                    <div className="mb-1 flex items-baseline gap-2">
                      <span
                        className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground"
                        title={t("usageReport.monthDays", { count: block.days })}
                      >
                        {monthLabel(block.key)}
                      </span>
                    </div>
                    <div
                      className="grid gap-[3px]"
                      style={{
                        // A plain 6×6 sheet: days run left to right, so a month is a filled
                        // rectangle instead of a weekday-aligned L. Six rows cover the longest
                        // month (31 days) and keep every block the same height.
                        gridTemplateColumns: "repeat(6, minmax(0, 1fr))"
                      }}
                    >
                      {block.cells.map((cell) => (
                        <span
                          key={cell.date}
                          className="aspect-square w-full rounded-[2px]"
                          style={{
                            gridColumn: cell.column + 1,
                            gridRow: cell.row + 1,
                            backgroundColor: HEAT_TIERS[heatLevel(cell.tokens, heat.max)]
                          }}
                          title={`${cell.date} · ${formatTokens(cell.tokens, locale)} · ${exact(cell.requests, locale)}`}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                <span>{t("usageReport.less")}</span>
                {HEAT_TIERS.map((color, index) => (
                  <span key={index} className="size-[10px] rounded-[2px]" style={{ backgroundColor: color }} />
                ))}
                <span>{t("usageReport.more")}</span>
              </div>
            </div>
          </SettingsCard>

          <SettingsCard
            title={t("usageReport.hourHeatmap")}
            desc={t("usageReport.hourHeatmapDesc")}
            action={
              <Select
                items={HEAT_RANGES.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                value={heatRange}
                onValueChange={(value) => value !== null && setHeatRange(value as HeatRange)}
              >
                <SelectTrigger size="sm" aria-label={t("usageReport.hourHeatmap")} className="w-[116px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HEAT_RANGES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          >
            {report === null ? (
              <SettingsNote>{t("usageReport.loading")}</SettingsNote>
            ) : !hourHeat.active ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                {t("usageReport.hourHeatmapEmpty")}
              </div>
            ) : (
              <HourActivityChart
                heat={hourHeat}
                t={t}
                formatTokens={(value) => formatTokens(value, locale)}
                formatCount={(value) => exact(value, locale)}
              />
            )}
          </SettingsCard>

          {stage >= 2 && (
            <>
          <SettingsCard title={t("usageReport.details")} desc={t("usageReport.detailsDesc", { count: detailTurns.length })}>
            {/* The filter lives in the body, not the card header: two date fields in the header
                squeezed the title into three lines as soon as the window got narrow. */}
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="flex items-center gap-1">
                {DETAIL_WINDOWS.map((window) => {
                  const active =
                    detailTo === todayKey &&
                    (window.daysBack === null
                      ? detailFrom === ""
                      : detailFrom === dayBack(window.daysBack))
                  return (
                    <button
                      key={String(window.daysBack)}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setDetailWindow(window.daysBack)}
                      className={`h-8 rounded-md border px-2 text-xs transition-colors ${
                        active
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-input text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {t(window.label)}
                    </button>
                  )
                })}
              </div>
              <input
                type="date"
                aria-label={t("usageReport.detailFrom")}
                value={draftFrom}
                max={draftTo || undefined}
                onChange={(event) => setDraftFrom(event.currentTarget.value)}
                className="h-8 w-[136px] rounded-md border border-input bg-transparent px-2 text-xs tabular-nums shadow-xs outline-none [color-scheme:light] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:[color-scheme:dark] dark:bg-input/30"
              />
              <span className="text-[10px] text-muted-foreground">—</span>
              <input
                type="date"
                aria-label={t("usageReport.detailTo")}
                value={draftTo}
                min={draftFrom || undefined}
                onChange={(event) => setDraftTo(event.currentTarget.value || draftTo)}
                className="h-8 w-[136px] rounded-md border border-input bg-transparent px-2 text-xs tabular-nums shadow-xs outline-none [color-scheme:light] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:[color-scheme:dark] dark:bg-input/30"
              />
              <Select
                items={[{ value: "", label: t("usageReport.allVendors") }, ...detailVendors.map((vendor) => ({ value: vendor, label: vendor }))]}
                value={detailVendor}
                onValueChange={(value) => setDetailVendor(value ?? "")}
              >
                <SelectTrigger size="sm" aria-label={t("usageReport.filterVendor")} className="w-[140px]">
                  <SelectValue placeholder={t("usageReport.filterVendor")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t("usageReport.allVendors")}</SelectItem>
                  {detailVendors.map((vendor) => (
                    <SelectItem key={vendor} value={vendor}>
                      {vendor}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                items={[{ value: "", label: t("usageReport.allModels") }, ...detailModels.map((model) => ({ value: model, label: model }))]}
                value={detailModel}
                onValueChange={(value) => setDetailModel(value ?? "")}
              >
                <SelectTrigger size="sm" aria-label={t("usageReport.filterModel")} className="w-[180px]">
                  <SelectValue placeholder={t("usageReport.filterModel")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t("usageReport.allModels")}</SelectItem>
                  {detailModels.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Directly after the last filter (模型 ID), not pushed to the far right: the button
                  belongs to the filter group it submits, so it wraps with 模型 ID on narrow panes. */}
              <button
                type="button"
                aria-label={t("usageReport.query")}
                onClick={applyDetailRange}
                className={`h-8 rounded-md border px-3 text-xs transition-colors ${
                  draftFrom !== detailFrom || draftTo !== detailTo
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-input text-muted-foreground hover:bg-muted"
                }`}
              >
                {t("usageReport.query")}
              </button>
            </div>
            {detailTurns.length === 0 ? (
              <p className="py-4 text-xs text-muted-foreground">{t("usageReport.detailEmpty")}</p>
            ) : (
              <div
                data-slot="usage-log-scroll"
                className="mt-3 max-h-[420px] overflow-auto rounded-lg border border-border/60"
                onScroll={(event) => {
                  const el = event.currentTarget
                  if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
                    setVisibleRows((current) => Math.min(pageRows.length, current + 20))
                  }
                }}
              >
              <table className="w-full table-fixed text-[11px] tabular-nums">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th scope="col" className="w-[18%] px-2 py-2 text-[10px] font-medium uppercase tracking-wide">
                    {t("usageReport.columnTime")}
                  </th>
                  <th scope="col" className="w-[28%] px-2 py-2 text-[10px] font-medium uppercase tracking-wide">
                    {t("usageReport.columnModel")}
                  </th>
                  <th scope="col" className="w-[13%] px-2 py-2 text-right text-[10px] font-medium uppercase tracking-wide">
                    {t("usageReport.columnInput")}
                  </th>
                  <th scope="col" className="w-[13%] px-2 py-2 text-right text-[10px] font-medium uppercase tracking-wide">
                    {t("usageReport.columnOutput")}
                  </th>
                  <th scope="col" className="w-[15%] px-2 py-2 text-right text-[10px] font-medium uppercase tracking-wide">
                    {t("usageReport.columnCacheHit")}
                  </th>
                  <th scope="col" className="w-[13%] px-2 py-2 text-right text-[10px] font-medium uppercase tracking-wide">
                    {t("usageReport.columnCost")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((turn, index) => {
                  const at = new Date(turn.at)
                  const stamp = Number.isNaN(at.getTime())
                    ? turn.at.slice(5, 16).replace("T", " ")
                    : `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(
                        at.getHours()
                      ).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
                  const utcHour = Number(turn.at.slice(11, 13))
                  const amount = costOf(
                    {
                      date: turn.date,
                      hour: Number.isFinite(utcHour) && utcHour >= 0 && utcHour < 24 ? utcHour : 0,
                      model: turn.model,
                      input: turn.input,
                      cached: turn.cached,
                      output: turn.output
                    },
                    prices,
                    usdToCny,
                    utcOffset
                  )
                  const read = turn.input + turn.cached
                  return (
                    <tr
                      key={`${turn.at}-${index}`}
                      className="border-t border-border/50 transition-colors hover:bg-muted/40"
                    >
                      <td className="px-2 py-2 whitespace-nowrap text-muted-foreground">{stamp}</td>
                      <td className="max-w-0 px-2 py-2 text-foreground">
                        <span className="truncate">{turn.model}</span>
                      </td>
                      <td className="px-2 py-2 text-right text-foreground/90">{exact(turn.input, locale)}</td>
                      <td className="px-2 py-2 text-right text-foreground/90">{exact(turn.output, locale)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground">
                        {percent(read === 0 ? 0 : turn.cached / read, locale)}
                      </td>
                      <td className="px-2 py-2 text-right font-medium text-foreground">
                        {amount === null ? "—" : money(amount, locale)}
                      </td>
                    </tr>
                  )
                })}
                </tbody>
              </table>
              {visibleRows < pageRows.length && (
                <p className="py-2 text-center text-[10px] text-muted-foreground">
                  {t("usageReport.loadMoreHint", { shown: visibleRows, total: pageRows.length })}
                </p>
              )}
              </div>
            )}
            {detailTurns.length > DETAIL_PAGE_SIZE && (
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[11px] text-muted-foreground">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => goToDetailPage(currentPage - 1)}
                >
                  {t("usageReport.pagePrev")}
                </Button>
                <div className="flex flex-wrap items-center justify-center gap-1">
                  {pageItems(currentPage, detailPages).map((entry, index) =>
                    entry === "gap" ? (
                      <span key={`gap-${index}`} className="px-1 text-muted-foreground">
                        …
                      </span>
                    ) : (
                      <Button
                        key={entry}
                        variant={entry === currentPage ? "default" : "ghost"}
                        size="sm"
                        className="h-7 min-w-7 px-1.5 tabular-nums"
                        aria-current={entry === currentPage ? "page" : undefined}
                        onClick={() => goToDetailPage(entry)}
                      >
                        {entry}
                      </Button>
                    )
                  )}
                </div>
                <span className="tabular-nums">
                  {t("usageReport.pageTotal", { total: detailTurns.length })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= detailPages}
                  onClick={() => goToDetailPage(currentPage + 1)}
                >
                  {t("usageReport.pageNext")}
                </Button>
              </div>
            )}
          </SettingsCard>

          <SettingsNote>
            {view.source !== ""
              ? t("usageReport.source", { path: view.source, scanned: view.scanned })
              : t("usageReport.note")}
          </SettingsNote>

          <SettingsDetails summary={t("usageReport.priceConfig")}>
            <p className="mb-3 text-xs leading-5 text-muted-foreground">{t("usageReport.priceConfigDesc")}</p>

            {/* One rate converts every USD-quoted vendor into RMB; the offset decides which wall
                clock the peak windows refer to. */}
            <div className="mb-4 grid gap-3 rounded-md border border-[color-mix(in_oklab,var(--border)_60%,transparent)] p-3 sm:grid-cols-2">
              <Field label={t("usageReport.exchangeRate")}>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">1 USD =</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={usdToCny}
                    onChange={(event) => setUsdToCny(Number(event.currentTarget.value))}
                    className="h-8 w-24 rounded-md border border-input bg-transparent px-2 text-xs tabular-nums shadow-xs outline-none focus-visible:border-ring"
                  />
                  <span className="text-[10px] text-muted-foreground">CNY</span>
                </div>
              </Field>
              <Field label={t("usageReport.priceTimezone")}>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">UTC+</span>
                  <input
                    type="number"
                    step="1"
                    min="-12"
                    max="14"
                    value={utcOffset}
                    onChange={(event) => setUtcOffset(Number(event.currentTarget.value))}
                    className="h-8 w-20 rounded-md border border-input bg-transparent px-2 text-xs tabular-nums shadow-xs outline-none focus-visible:border-ring"
                  />
                  <span className="truncate text-[10px] text-muted-foreground">
                    {t("usageReport.priceTimezoneHint")}
                  </span>
                </div>
              </Field>
            </div>

            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">{t("usageReport.priceUnit")}</span>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={exportPrices}>
                  {t("usageReport.exportPrices")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()}>
                  {t("usageReport.importPrices")}
                </Button>
                <Button variant="ghost" size="sm" onClick={addVendor}>
                  {t("usageReport.addVendor")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => resetPrices()}>
                  {t("usageReport.resetPrices")}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    if (file !== undefined) importPricesFromFile(file)
                    event.currentTarget.value = ""
                  }}
                />
              </div>
            </div>

            {updateState.status === "ok" && (
              <p className="mb-2 text-[11px] text-emerald-600 dark:text-emerald-400">{updateState.msg}</p>
            )}
            {updateState.status === "error" && (
              <p className="mb-2 text-[11px] text-destructive">{updateState.msg}</p>
            )}

            <div className="flex flex-col gap-3">
              {vendorGroups.map(([vendor, rows]) => (
                <div
                  // Keyed by the first row's index, not the vendor name: renaming a vendor must
                  // not remount the group and steal focus from the name input mid-typing.
                  key={rows[0]?.index ?? vendor}
                  className="overflow-hidden rounded-xl border border-border/60 bg-card/40"
                >
                  <div className="flex flex-wrap items-center gap-2 bg-muted/30 px-3 py-2">
                    <input
                      type="text"
                      value={vendor}
                      aria-label={t("usageReport.vendor")}
                      onChange={(event) => renameVendor(vendor, event.currentTarget.value)}
                      className="h-7 w-32 rounded-md border border-transparent bg-transparent px-1.5 text-sm font-semibold outline-none transition-colors hover:border-input focus-visible:border-ring"
                    />
                    <span className="rounded-full bg-background px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                      {t("usageReport.modelCount", { count: rows.length })}
                    </span>
                    <div className="ms-auto flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => addModel(vendor)}
                        className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                      >
                        {t("usageReport.addModel")}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeVendor(vendor)}
                        className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-destructive"
                      >
                        {t("usageReport.removeVendor")}
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 border-t border-border/50 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="url"
                        value={vendorSources[vendor]?.url ?? ""}
                        placeholder={t("usageReport.vendorUrlPlaceholder")}
                        onChange={(event) => setVendorSource(vendor, { url: event.currentTarget.value })}
                        className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-background/60 px-2 font-mono text-[11px] outline-none transition-colors focus-visible:border-ring"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={vendorStatus[vendor]?.status === "loading"}
                        onClick={() => void updateVendor(vendor)}
                      >
                        <RefreshCwIcon
                          className={cn(
                            "size-3.5",
                            vendorStatus[vendor]?.status === "loading" && "animate-spin"
                          )}
                          aria-hidden="true"
                        />
                        {vendorStatus[vendor]?.status === "loading"
                          ? t("usageReport.updating")
                          : t("usageReport.vendorUpdate")}
                      </Button>
                    </div>
                    <details>
                      <summary className="w-fit cursor-pointer list-none text-[10px] text-muted-foreground transition-colors hover:text-foreground">
                        ▸ {t("usageReport.vendorRule")}
                      </summary>
                      <div className="mt-2 flex flex-col gap-2 rounded-lg bg-muted/30 p-2">
                        {vendorSources[vendor]?.openrouter !== undefined ? (
                          <p className="text-[10px] leading-4 text-muted-foreground">
                            {t("usageReport.vendorOpenRouter", { prefix: vendorSources[vendor]?.openrouter })}
                          </p>
                        ) : (
                          <>
                            <textarea
                              value={vendorSources[vendor]?.regex ?? ""}
                              rows={3}
                              spellCheck={false}
                              onChange={(event) => setVendorSource(vendor, { regex: event.currentTarget.value })}
                              className="w-full rounded-md border border-border/60 bg-background/60 px-2 py-1.5 font-mono text-[10px] leading-4 outline-none focus-visible:border-ring"
                            />
                            <p className="text-[10px] leading-4 text-muted-foreground">
                              {t("usageReport.vendorRuleHint")}
                            </p>
                          </>
                        )}
                        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          {t("usageReport.vendorCurrency")}
                          <select
                            value={vendorSources[vendor]?.currency ?? "USD"}
                            onChange={(event) =>
                              setVendorSource(vendor, { currency: event.currentTarget.value as Currency })
                            }
                            className="h-6 rounded-md border border-border/60 bg-background/60 px-1.5 text-[10px] outline-none focus-visible:border-ring"
                          >
                            <option value="USD">USD</option>
                            <option value="CNY">CNY</option>
                          </select>
                        </label>
                      </div>
                    </details>
                  </div>
                  {vendorStatus[vendor]?.status !== undefined && vendorStatus[vendor]?.status !== "loading" && (
                    <div
                      className={cn(
                        "flex items-start gap-1.5 border-t border-border/50 px-3 py-1.5 text-[11px]",
                        vendorStatus[vendor]?.status === "ok"
                          ? "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
                          : "bg-destructive/10 text-destructive"
                      )}
                    >
                      <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-current" />
                      <span className="min-w-0 break-words">{vendorStatus[vendor]?.msg}</span>
                    </div>
                  )}
                  <div className="overflow-x-auto px-3 pb-2">
                    <table className="w-full table-fixed text-[11px] tabular-nums">
                      <thead>
                        <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                          <th className="w-[30%] py-2 font-medium">{t("usageReport.priceModel")}</th>
                          <th className="w-[12%] py-2 font-medium">{t("usageReport.priceCurrency")}</th>
                          <th className="w-[14%] py-2 text-right font-medium">{t("usageReport.priceInput")}</th>
                          <th className="w-[14%] py-2 text-right font-medium">{t("usageReport.priceCached")}</th>
                          <th className="w-[14%] py-2 text-right font-medium">{t("usageReport.priceOutput")}</th>
                          <th className="w-[10%] py-2 text-center font-medium">{t("usageReport.offPeak")}</th>
                          <th className="w-[6%] py-2 font-medium" />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(({ price, index }) => (
                          <Fragment key={`${vendor}-${index}`}>
                            <tr className="border-t border-border/50">
                              <td className="py-1.5 pr-2">
                                <input
                                  type="text"
                                  value={price.model}
                                  placeholder={t("usageReport.priceModelPlaceholder")}
                                  onChange={(event) => patchPrice(index, { model: event.currentTarget.value })}
                                  className="h-7 w-full rounded-md border border-border/50 bg-background/60 px-1.5 text-xs outline-none transition-colors focus-visible:border-ring"
                                />
                                {price.note !== "" && (
                                  <div
                                    className="mt-0.5 max-w-full truncate text-[9px] leading-3 text-muted-foreground"
                                    title={price.note}
                                  >
                                    {price.note}
                                  </div>
                                )}
                                {price.model !== "" && (
                                  <div className="mt-0.5">
                                    {usedModels.has(price.model) ? (
                                      <span className="rounded bg-emerald-600/15 px-1.5 py-0.5 text-[9px] text-emerald-600 dark:text-emerald-400">
                                        {t("usageReport.usedInRange")}
                                      </span>
                                    ) : (
                                      <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                                        {t("usageReport.unusedInRange")}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </td>
                              <td className="py-1.5 pr-2">
                                <select
                                  value={price.currency}
                                  aria-label={t("usageReport.priceCurrency")}
                                  onChange={(event) =>
                                    patchPrice(index, { currency: event.currentTarget.value as Currency })
                                  }
                                  className="h-7 w-full rounded-md border border-border/50 bg-background/60 px-1 text-[10px] outline-none transition-colors focus-visible:border-ring"
                                >
                                  <option value="USD">USD</option>
                                  <option value="CNY">CNY</option>
                                </select>
                              </td>
                              {(["input", "cached", "output"] as const).map((field) => (
                                <td key={field} className="py-1.5 pr-2">
                                  <input
                                    type="number"
                                    step="0.001"
                                    min="0"
                                    value={price[field]}
                                    onChange={(event) => updatePrice(index, field, event.currentTarget.value)}
                                    className="h-7 w-full rounded-md border border-border/50 bg-background/60 px-1.5 text-right text-xs outline-none transition-colors focus-visible:border-ring"
                                  />
                                </td>
                              ))}
                              <td className="py-1.5 text-center">
                                <input
                                  type="checkbox"
                                  checked={price.offPeak !== null}
                                  aria-label={t("usageReport.offPeak")}
                                  onChange={(event) => {
                                    if (event.currentTarget.checked) {
                                      patchPrice(index, {
                                        offPeak: {
                                          input: price.input / 2,
                                          cached: price.cached / 2,
                                          output: price.output / 2
                                        },
                                        peakWindows: price.peakWindows || "09:00-12:00,14:00-18:00",
                                        weekdaysOnly: true
                                      })
                                    } else {
                                      patchPrice(index, { offPeak: null })
                                    }
                                  }}
                                />
                              </td>
                              <td className="py-1.5 text-right">
                                <button
                                  type="button"
                                  onClick={() => removeModel(index)}
                                  className="text-[10px] text-muted-foreground hover:text-destructive"
                                >
                                  {t("usageReport.removeModel")}
                                </button>
                              </td>
                            </tr>
                            {price.offPeak !== null && (
                              <tr className="bg-muted/40">
                                <td colSpan={7} className="px-2 py-2">
                                  <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                                    <Field label={t("usageReport.peakWindows")}>
                                      <input
                                        type="text"
                                        value={price.peakWindows}
                                        placeholder="09:00-12:00,14:00-18:00"
                                        onChange={(event) =>
                                          patchPrice(index, { peakWindows: event.currentTarget.value })
                                        }
                                        className="h-7 w-44 rounded border border-input bg-transparent px-1.5 text-[11px] tabular-nums outline-none focus-visible:border-ring"
                                      />
                                    </Field>
                                    <label className="flex items-center gap-1.5 pb-1 text-[10px] text-muted-foreground">
                                      <input
                                        type="checkbox"
                                        checked={price.weekdaysOnly}
                                        onChange={(event) =>
                                          patchPrice(index, { weekdaysOnly: event.currentTarget.checked })
                                        }
                                      />
                                      {t("usageReport.weekdaysOnly")}
                                    </label>
                                    <span className="pb-1 text-[10px] text-muted-foreground">
                                      {t("usageReport.offPeakPrices")}
                                    </span>
                                    {(["input", "cached", "output"] as const).map((field) => (
                                      <Field
                                        key={field}
                                        label={t(
                                          `usageReport.offPeak${field === "input" ? "Input" : field === "cached" ? "Cached" : "Output"}`
                                        )}
                                      >
                                        <input
                                          type="number"
                                          step="0.001"
                                          min="0"
                                          value={price.offPeak?.[field] ?? 0}
                                          onChange={(event) => updateOffPeak(index, field, event.currentTarget.value)}
                                          className="h-7 w-20 rounded border border-input bg-transparent px-1.5 text-right text-[11px] tabular-nums outline-none focus-visible:border-ring"
                                        />
                                      </Field>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] leading-4 text-muted-foreground">{t("usageReport.priceHint")}</p>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{t("usageReport.costNote")}</p>
          </SettingsDetails>
            </>
          )}
        </>
      )}
    </>
  )
}
