import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { dayKey } from "@/features/settings/usage-data"

const native = vi.hoisted(() => ({
  report: vi.fn(),
  refresh: vi.fn(),
  providers: vi.fn(),
  fetchText: vi.fn(),
  // The page reads the provider snapshot through this hook (which subscribes to native events),
  // so the fixture is served here rather than through the raw command.
  snapshot: { value: null as unknown },
  // The reset card reads the main window's `account/rateLimits` over the settings bridge; the
  // bridge itself is covered by its own tests, so this file only needs a controllable snapshot.
  account: { value: null as unknown },
  requestAccountRefresh: vi.fn(async () => {})
}))

vi.mock("@/bindings", () => ({
  commands: {
    usageReport: native.report,
    // The refresh button forces an incremental rebuild and reports what the delta added.
    usageReportRefresh: native.refresh,
    // The usage page now reads the provider catalog to show the user's own model labels.
    providersRead: native.providers,
    // One-click vendor price updates fetch the vendor's public pricing page through this.
    fetchText: native.fetchText
  },
  events: {
    "providers:changed": {
      name: "providers:changed",
      listen: vi.fn(async () => () => {})
    }
  }
}))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }))
vi.mock("@/lib/use-providers", () => ({ useProviders: () => native.snapshot.value }))
vi.mock("@/lib/settings-bridge", () => ({
  useSettingsAccount: () => native.account.value,
  requestAccountRefresh: native.requestAccountRefresh
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options === undefined ? key : `${key}${JSON.stringify(options)}`),
    i18n: { language: "en" }
  })
}))

import { UsageSection } from "../usage-section"
import { blankPrice, usePriceStore } from "../../price-store"

const today = dayKey(new Date())
const yesterday = dayKey(new Date(Date.now() - 86_400_000))

function report(overrides: Record<string, unknown> = {}) {
  return {
    points: [
      {
        date: today,
        provider: "kimi",
        model: "kimi-k2.6",
        requests: 2,
        input: 60_000,
        cached: 840_000,
        output: 10_000,
        reasoning: 0,
        tokens: 900_000
      },
      {
        date: yesterday,
        provider: "codex",
        model: "gpt-6-luna",
        requests: 1,
        input: 40_000,
        cached: 560_000,
        output: 5_000,
        reasoning: 0,
        tokens: 600_000
      }
    ],
    recent: [
      {
        at: `${today}T10:05:00.000Z`,
        date: today,
        provider: "kimi",
        model: "kimi-k2.6",
        input: 50_000,
        cached: 650_000,
        output: 10_000,
        tokens: 750_000
      }
    ],
    sessions: 1,
    scanned: 3,
    first: today,
    last: today,
    source: "<CODEX_HOME>/sessions",
    ...overrides
  }
}

beforeEach(() => {
  native.report.mockResolvedValue(report())
  native.refresh.mockResolvedValue(report())
  native.providers.mockResolvedValue({ providers: {}, customProviders: [], builtInModels: {}, revision: 0 })
  native.snapshot.value = null
  native.account.value = null
  native.requestAccountRefresh.mockClear()
  // 外部调用统计默认开着；某个用例关掉之后必须复位，否则会污染后面的用例。
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

/**
 * The page mounts charts, then the log, in later frames so the overview paints first. Tests that
 * assert on those cards have to wait for all three stages, not just for the overview's first text.
 *
 * The timeout is explicit and generous on purpose. `waitFor`'s 1s default is measured against a
 * worker that is running this file alongside 290 others, and the deferred stages land through
 * layout effects plus a chunk of chart mounting — under full-suite load the last stage has been
 * observed arriving after the default window, which failed a test that passes in isolation. This
 * waits on our own scheduling, not on a network or a timer we control, so a longer ceiling costs
 * nothing when things are fast and stops the suite from failing on machine load instead of on a
 * regression.
 */
async function waitForStagedCards(): Promise<void> {
  await waitFor(
    () => {
      expect(screen.getByRole("combobox", { name: "usageReport.group" })).toBeInTheDocument()
      expect(screen.getByLabelText("usageReport.detailFrom")).toBeInTheDocument()
    },
    { timeout: 5_000 }
  )
}

/** Opens the top-level 调用范围 Select and picks one of its three options. */
async function chooseScope(label: string): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: "usageReport.scopeLabel" }))
  const option = await screen.findByRole("option", { name: label })
  fireEvent.pointerDown(option, { pointerType: "mouse" })
  fireEvent.click(option)
}

test("reads the ledger once and shows the totals for the current range", async () => {
  render(<UsageSection />)
  expect(await screen.findByText("usageReport.tokens")).toBeInTheDocument()
  await waitForStagedCards()
  expect(native.report).toHaveBeenCalledOnce()
  // 1.5M tokens (K/M/B/T ladder, one decimal), 3 calls, cached 1.4M of 1.5M reads.
  expect(screen.getByText("1.5M")).toBeInTheDocument()
  expect(screen.getByText("93.3%")).toBeInTheDocument()
  // The heaviest model is named in the summary, the ranking and the table.
  expect(screen.getAllByText("kimi-k2.6").length).toBeGreaterThan(1)
})

test("the range control filters in place instead of re-reading the disk", async () => {
  render(<UsageSection />)
  await screen.findByText("usageReport.tokens")
  await waitForStagedCards()
  expect(screen.getByRole("combobox", { name: "usageReport.rangeLabel" })).toHaveTextContent("usageReport.range.30d")
  expect(screen.getByRole("combobox", { name: "usageReport.metric" })).toBeInTheDocument()
  // 模型 is the default grouping; the metric stays on Token and the chart on 饼图.
  expect(screen.getByRole("combobox", { name: "usageReport.group" })).toHaveTextContent("usageReport.byModel")
  expect(screen.getByRole("combobox", { name: "usageReport.metric" })).toHaveTextContent("usageReport.metricTokens")
  expect(screen.getByRole("button", { name: "usageReport.chartPie" })).toHaveAttribute("aria-pressed", "true")
  expect(native.report).toHaveBeenCalledOnce()
})

test("the pie carries a legend centred below the chart", async () => {
  render(<UsageSection />)
  await waitForStagedCards()
  // The pie used to have no legend at all; it now shares the one below every chart.
  const legend = document.querySelector("[data-usage-legend]")
  expect(legend).not.toBeNull()
  expect(legend?.className).toContain("justify-center")
  expect(legend?.textContent).toContain("kimi-k2.6")
})

test("choosing 今日 restores the model / Token / pie defaults", async () => {
  render(<UsageSection />)
  await waitForStagedCards()
  // Change the chart by hand, then pick 今日: the daily-composition default comes back.
  fireEvent.click(screen.getByRole("button", { name: "usageReport.chartLine" }))
  expect(screen.getByRole("button", { name: "usageReport.chartLine" })).toHaveAttribute("aria-pressed", "true")
  fireEvent.click(screen.getByRole("button", { name: "usageReport.range.1d" }))
  expect(screen.getByRole("button", { name: "usageReport.chartPie" })).toHaveAttribute("aria-pressed", "true")
  expect(screen.getByRole("combobox", { name: "usageReport.group" })).toHaveTextContent("usageReport.byModel")
  expect(screen.getByRole("combobox", { name: "usageReport.metric" })).toHaveTextContent("usageReport.metricTokens")
})

test("an empty ledger explains itself instead of showing zeros", async () => {
  native.report.mockResolvedValue(report({ points: [], recent: [] }))
  render(<UsageSection />)
  expect(await screen.findByText("usageReport.empty")).toBeInTheDocument()
  expect(screen.queryByText("usageReport.tokens")).toBeNull()
  // 「全部」视图用的是普通空态文案，外部未接入的提示不能出现在这里。
  expect(screen.getByText("usageReport.emptyHint")).toBeInTheDocument()
  expect(screen.queryByText("usageReport.externalNotConnected")).toBeNull()
})

test("the top filter offers exactly 全部 / 内部 / 外部 and defaults to 全部", async () => {
  render(<UsageSection />)
  await waitForStagedCards()
  const trigger = screen.getByRole("combobox", { name: "usageReport.scopeLabel" })
  expect(trigger).toHaveTextContent("usageReport.scopeAll")
  fireEvent.click(trigger)
  expect(await screen.findByRole("option", { name: "usageReport.scopeAll" })).toBeInTheDocument()
  expect(screen.getByRole("option", { name: "usageReport.scopeInternal" })).toBeInTheDocument()
  expect(screen.getByRole("option", { name: "usageReport.scopeExternal" })).toBeInTheDocument()
  expect(screen.getAllByRole("option")).toHaveLength(3)
  // WorkBuddy / 千问办公 / 其他 Agent 只是明细里的来源标识，不再是顶部一级筛选项。
  expect(screen.queryByRole("option", { name: "usageReport.clientWorkbuddy" })).toBeNull()
  expect(screen.queryByRole("option", { name: "usageReport.clientQwen" })).toBeNull()
  expect(screen.queryByRole("option", { name: "usageReport.clientOther" })).toBeNull()
})

test("全部 / 内部 / 外部 scope filters the overview, analysis and the call log", async () => {
  const base = report()
  native.report.mockResolvedValue(
    report({
      points: [
        // 无 clientSource 的历史行按 ALWith L 内部调用处理：900K tokens。
        { ...base.points[0], model: "internal-model" },
        { ...base.points[1], model: "external-model", clientSource: "workbuddy" }
      ],
      recent: [
        { ...base.recent[0], model: "internal-log" },
        { ...base.recent[0], model: "external-log", clientSource: "qwen_office", at: `${today}T11:00:00.000Z` }
      ]
    })
  )
  render(<UsageSection />)
  await waitForStagedCards()

  // 全部：900K + 600K = 1.5M，图表图例与明细里两类调用都在。
  expect(screen.getByText("1.5M")).toBeInTheDocument()
  expect(document.querySelector("[data-usage-legend]")?.textContent).toContain("internal-model")
  expect(document.querySelector("[data-usage-legend]")?.textContent).toContain("external-model")
  expect(screen.getByText("internal-log")).toBeInTheDocument()
  expect(screen.getByText("external-log")).toBeInTheDocument()

  await chooseScope("usageReport.scopeInternal")
  await waitFor(() => expect(screen.getAllByText("900.0K").length).toBeGreaterThan(0))
  expect(screen.getByRole("combobox", { name: "usageReport.scopeLabel" })).toHaveTextContent("usageReport.scopeInternal")
  expect(screen.queryByText("1.5M")).toBeNull()
  expect(document.querySelector("[data-usage-legend]")?.textContent).not.toContain("external-model")
  expect(screen.getByText("internal-log")).toBeInTheDocument()
  expect(screen.queryByText("external-log")).toBeNull()

  await chooseScope("usageReport.scopeExternal")
  await waitFor(() => expect(screen.getAllByText("600.0K").length).toBeGreaterThan(0))
  expect(screen.getByRole("combobox", { name: "usageReport.scopeLabel" })).toHaveTextContent("usageReport.scopeExternal")
  expect(screen.queryByText("900.0K")).toBeNull()
  expect(document.querySelector("[data-usage-legend]")?.textContent).not.toContain("internal-model")
  expect(screen.getByText("external-log")).toBeInTheDocument()
  expect(screen.queryByText("internal-log")).toBeNull()

  // 回到全部：数字与明细都恢复，切换筛选不会重新读盘。
  await chooseScope("usageReport.scopeAll")
  await waitFor(() => expect(screen.getByText("1.5M")).toBeInTheDocument())
  expect(screen.getByText("internal-log")).toBeInTheDocument()
  expect(screen.getByText("external-log")).toBeInTheDocument()
  expect(native.report).toHaveBeenCalledOnce()
})

test("切「调用范围」时日历热力图与 24 小时热力图的单元格数值一起变", async () => {
  const base = report()
  native.report.mockResolvedValue(
    report({
      points: [
        // 同一天、不同 UTC 小时：内部 900K / 2 次，外部 600K / 1 次。日期相同，时间窗口
        // 无法替筛选把两行分开——只有真正按 clientSource 过滤才会让单元格数值变化。
        { ...base.points[0], hour: 3, model: "own-model", clientSource: "alwith_l" },
        { ...base.points[1], date: today, hour: 15, model: "wb-model", clientSource: "workbuddy" }
      ],
      recent: [
        { ...base.recent[0], model: "own-log", clientSource: "alwith_l" },
        { ...base.recent[0], model: "wb-log", clientSource: "workbuddy", at: `${today}T11:00:00.000Z` }
      ]
    })
  )
  render(<UsageSection />)
  await waitForStagedCards()

  // 日历热力图单元格 title = 「YYYY-MM-DD · tokens · 调用数」；24 小时时间带单元格 title =
  // 「YYYY-MM-DD HH:mm · tokens · 调用数」。按数值断言单元格，而不是只断言卡片在不在。
  const titles = (pattern: RegExp): string[] =>
    Array.from(document.querySelectorAll("span[title]"))
      .map((node) => node.getAttribute("title") ?? "")
      .filter((title) => pattern.test(title))
  const calendarTitles = (): string[] => titles(/^\d{4}-\d{2}-\d{2} · /)
  const hourTitles = (): string[] => titles(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} · /)
  const has = (list: string[], value: string): boolean => list.some((title) => title.includes(value))

  // 「全部」：日历格合并成 1.5M · 3；24 小时带按小时分开，两个数值都在。
  expect(calendarTitles().length).toBeGreaterThan(0)
  expect(hourTitles().length).toBeGreaterThan(0)
  expect(has(calendarTitles(), "1.5M · 3")).toBe(true)
  expect(has(calendarTitles(), "900.0K · 2")).toBe(false)
  expect(has(calendarTitles(), "600.0K · 1")).toBe(false)
  expect(has(hourTitles(), "900.0K · 2")).toBe(true)
  expect(has(hourTitles(), "600.0K · 1")).toBe(true)

  await chooseScope("usageReport.scopeInternal")
  await waitFor(() => expect(has(calendarTitles(), "1.5M · 3")).toBe(false))
  expect(has(calendarTitles(), "900.0K · 2")).toBe(true)
  expect(has(calendarTitles(), "600.0K · 1")).toBe(false)
  expect(has(hourTitles(), "900.0K · 2")).toBe(true)
  expect(has(hourTitles(), "600.0K · 1")).toBe(false)

  await chooseScope("usageReport.scopeExternal")
  await waitFor(() => expect(has(calendarTitles(), "900.0K · 2")).toBe(false))
  expect(has(calendarTitles(), "600.0K · 1")).toBe(true)
  expect(has(calendarTitles(), "1.5M · 3")).toBe(false)
  expect(has(hourTitles(), "600.0K · 1")).toBe(true)
  expect(has(hourTitles(), "900.0K · 2")).toBe(false)
})

test("an empty 外部 view explains that no external client is connected yet", async () => {
  const base = report()
  native.report.mockResolvedValue(
    report({
      points: [{ ...base.points[0], model: "own-model" }],
      recent: [{ ...base.recent[0], model: "own-log" }]
    })
  )
  render(<UsageSection />)
  // 默认「全部」有数据：既不是空态，也不该出现外部未接入提示。
  expect(await screen.findByText("usageReport.tokens")).toBeInTheDocument()
  expect(screen.queryByText("usageReport.emptyHint")).toBeNull()
  expect(screen.queryByText("usageReport.externalNotConnected")).toBeNull()

  await chooseScope("usageReport.scopeExternal")
  await waitFor(() => expect(screen.getByText("usageReport.externalNotConnected")).toBeInTheDocument())
  expect(screen.getByText("usageReport.empty")).toBeInTheDocument()
  expect(screen.queryByText("usageReport.emptyHint")).toBeNull()
  expect(screen.queryByText("usageReport.tokens")).toBeNull()

  // 切回「内部」恢复正常数字，外部提示随之消失。
  await chooseScope("usageReport.scopeInternal")
  await waitFor(() => expect(screen.getByText("usageReport.tokens")).toBeInTheDocument())
  expect(screen.queryByText("usageReport.externalNotConnected")).toBeNull()
})

test("an empty 内部 view keeps the ordinary empty hint", async () => {
  const base = report()
  native.report.mockResolvedValue(
    report({
      points: [{ ...base.points[0], model: "wb-model", clientSource: "workbuddy" }],
      recent: [{ ...base.recent[0], model: "wb-log", clientSource: "qwen_office" }]
    })
  )
  render(<UsageSection />)
  expect(await screen.findByText("usageReport.tokens")).toBeInTheDocument()
  await chooseScope("usageReport.scopeInternal")
  await waitFor(() => expect(screen.getByText("usageReport.empty")).toBeInTheDocument())
  expect(screen.getByText("usageReport.emptyHint")).toBeInTheDocument()
  expect(screen.queryByText("usageReport.externalNotConnected")).toBeNull()
})

test("a failing read surfaces the message and offers a retry", async () => {
  native.report.mockRejectedValueOnce(new Error("sessions unreadable"))
  render(<UsageSection />)
  expect(await screen.findByRole("alert")).toHaveTextContent("sessions unreadable")
  native.report.mockResolvedValue(report())
  fireEvent.click(screen.getByRole("button", { name: "usageReport.refresh" }))
  await waitFor(() => expect(screen.getByText("usageReport.tokens")).toBeInTheDocument())
})

test("the request table pages through rows instead of growing without bound", async () => {
  const recent = Array.from({ length: 120 }, (_, index) => ({
    at: `${today}T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
    date: today,
    provider: "codex",
    model: `model-${index}`,
    input: 1000,
    cached: 0,
    output: 100,
    tokens: 1100
  }))
  native.report.mockResolvedValue(report({ recent }))
  const { container } = render(<UsageSection />)
  // 100 rows a page, 20 on screen: 120 calls are two pages, and the table never renders more
  // than the first screenful of the page it is showing.
  // The footer lists page numbers instead of "page 1/2", at most ten of them.
  expect(await screen.findByRole("button", { name: "1" })).toHaveAttribute("aria-current", "page")
  expect(screen.getByRole("button", { name: "2" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "usageReport.pagePrev" })).toBeDisabled()
  expect(screen.getByText("model-0")).toBeInTheDocument()
  expect(screen.getByText("model-19")).toBeInTheDocument()
  expect(screen.queryByText("model-20")).toBeNull()
  expect(screen.queryByText("model-100")).toBeNull()

  // Scrolling to the bottom of the table appends the next screenful instead of paging.
  const scroller = container.querySelector('[data-slot="usage-log-scroll"]')
  if (scroller === null) throw new Error("missing scroll container")
  for (let step = 0; step < 5; step += 1) fireEvent.scroll(scroller)
  expect(screen.getByText("model-99")).toBeInTheDocument()
  expect(screen.queryByText("model-100")).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: "2" }))
  expect(screen.getByRole("button", { name: "2" })).toHaveAttribute("aria-current", "page")
  expect(screen.getByText("model-100")).toBeInTheDocument()
  expect(screen.queryByText("model-0")).toBeNull()
  expect(screen.getByRole("button", { name: "usageReport.pageNext" })).toBeDisabled()
})

test("a long log collapses its page numbers", async () => {
  const recent = Array.from({ length: 1250 }, (_, index) => ({
    at: `${today}T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
    date: today,
    provider: "codex",
    model: `model-${index}`,
    input: 1000,
    cached: 0,
    output: 100,
    tokens: 1100
  }))
  native.report.mockResolvedValue(report({ recent }))
  render(<UsageSection />)
  // 1250 calls are 13 pages; only ten number buttons may appear, with the collapsed runs as gaps.
  const first = await screen.findByRole("button", { name: "1" })
  expect(first).toHaveAttribute("aria-current", "page")
  expect(screen.getByRole("button", { name: "13" })).toBeInTheDocument()
  // 10..12 fall inside the collapsed run before the last page.
  expect(screen.queryByRole("button", { name: "11" })).toBeNull()
  expect(screen.getAllByText("…").length).toBeGreaterThan(0)
})

test("the request table opens on the whole history and 今日 narrows it", async () => {
  const old = dayKey(new Date(Date.now() - 9 * 86_400_000))
  const recent = [
    { at: `${today}T10:00:00.000Z`, date: today, provider: "kimi", model: "recent-model", input: 1, cached: 0, output: 1, tokens: 2 },
    { at: `${old}T10:00:00.000Z`, date: old, provider: "kimi", model: "stale-model", input: 1, cached: 0, output: 1, tokens: 2 }
  ]
  native.report.mockResolvedValue(report({ recent }))
  render(<UsageSection />)
  expect(await screen.findByText("recent-model")).toBeInTheDocument()
  // History is visible without touching the dates: the log used to open on three days and hide it.
  expect(screen.getByText("stale-model")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "usageReport.rangeToday" }))
  expect(screen.queryByText("stale-model")).toBeNull()
})

test("a call filed under yesterday's UTC day still counts as today, in 分析 and in the log", async () => {
  // The engine writes `date` from the UTC timestamp. At 01:00 local (UTC+8) that is the previous
  // UTC day, so a local "今日" window used to find nothing while 近 3 天 still did.
  const localMorning = new Date()
  localMorning.setHours(1, 0, 0, 0)
  const at = localMorning.toISOString()
  const utcDay = at.slice(0, 10)
  const utcHour = Number(at.slice(11, 13))
  const call = {
    at,
    date: utcDay,
    provider: "codex",
    model: "early-bird",
    input: 100,
    cached: 0,
    output: 10,
    tokens: 110
  }
  native.report.mockResolvedValue(
    report({
      points: [{ ...call, hour: utcHour, requests: 1, reasoning: 0 }],
      recent: [call],
      first: utcDay,
      last: utcDay
    })
  )
  render(<UsageSection />)
  expect(await screen.findByText("usageReport.tokens")).toBeInTheDocument()
  await waitForStagedCards()

  // 分析 reuses the overview range; on "今日" it must still have a point to draw.
  fireEvent.click(screen.getByRole("button", { name: "usageReport.range.1d" }))
  expect(screen.getByText("usageReport.analysis")).toBeInTheDocument()

  // The log's own "今日" window and a custom date of today must keep the same call.
  fireEvent.click(screen.getByRole("button", { name: "usageReport.rangeToday" }))
  expect(screen.getAllByText("early-bird").length).toBeGreaterThan(0)
  fireEvent.change(screen.getByLabelText("usageReport.detailFrom"), { target: { value: today } })
  fireEvent.change(screen.getByLabelText("usageReport.detailTo"), { target: { value: today } })
  fireEvent.click(screen.getByRole("button", { name: "usageReport.query" }))
  expect(screen.getAllByText("early-bird").length).toBeGreaterThan(0)
})

test("changing the dates brings an older call back into the table", async () => {
  const old = dayKey(new Date(Date.now() - 9 * 86_400_000))
  const recent = [
    { at: `${today}T10:00:00.000Z`, date: today, provider: "kimi", model: "recent-model", input: 1, cached: 0, output: 1, tokens: 2 },
    { at: `${old}T10:00:00.000Z`, date: old, provider: "kimi", model: "stale-model", input: 1, cached: 0, output: 1, tokens: 2 }
  ]
  native.report.mockResolvedValue(report({ recent }))
  render(<UsageSection />)
  await screen.findByText("recent-model")
  // Start from 今日, which hides the older call. The default range is the whole history.
  fireEvent.click(screen.getByRole("button", { name: "usageReport.rangeToday" }))
  expect(screen.queryByText("stale-model")).toBeNull()
  fireEvent.change(screen.getByLabelText("usageReport.detailFrom"), { target: { value: old } })
  // Editing a date is only a draft now: a half-chosen range must not repaint the log.
  expect(screen.queryByText("stale-model")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "usageReport.query" }))
  expect(screen.getByText("stale-model")).toBeInTheDocument()
})

test("a custom end date only takes effect after 查询", async () => {
  native.report.mockResolvedValue(
    report({
      recent: [
        {
          at: `${today}T10:00:00.000Z`,
          date: today,
          provider: "kimi",
          model: "log-only-model",
          input: 1,
          cached: 0,
          output: 1,
          tokens: 2
        }
      ]
    })
  )
  render(<UsageSection />)
  await screen.findByText("log-only-model")
  fireEvent.change(screen.getByLabelText("usageReport.detailTo"), { target: { value: "1999-01-01" } })
  expect(screen.getByText("log-only-model")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "usageReport.query" }))
  expect(screen.queryByText("log-only-model")).toBeNull()
  expect(screen.getByText("usageReport.detailEmpty")).toBeInTheDocument()
})

/** Opens the price configuration disclosure; it is collapsed by default like any other detail. */
function openPriceConfig(): void {
  const summary = screen.getByText("usageReport.priceConfig")
  const details = summary.closest("details")
  if (details === null) throw new Error("missing price details")
  details.open = true
}

test("the refresh button reports how many new calls the incremental sync brought in", async () => {
  render(<UsageSection />)
  await waitForStagedCards()
  expect(native.refresh).not.toHaveBeenCalled()
  // The rebuild found two extra calls; the page says so instead of looking like a dead button.
  const grown = report()
  grown.points[0].requests = 4
  native.refresh.mockResolvedValue(grown)
  fireEvent.click(screen.getByRole("button", { name: "usageReport.refresh" }))
  await waitFor(() => expect(screen.getByTestId("usage-sync-note")).toHaveTextContent("usageReport.syncAdded"))
  expect(native.refresh).toHaveBeenCalledOnce()

  // Nothing new on disk → an explicit "already current", still exactly one call per click.
  native.refresh.mockResolvedValue(grown)
  fireEvent.click(screen.getByRole("button", { name: "usageReport.refresh" }))
  await waitFor(() => expect(screen.getByTestId("usage-sync-note")).toHaveTextContent("usageReport.syncUpToDate"))
  expect(native.refresh).toHaveBeenCalledTimes(2)
})

test("price vendors start collapsed and only the opened one renders its table", async () => {
  render(<UsageSection />)
  await waitForStagedCards()
  openPriceConfig()
  const vendors = screen.getAllByTestId("price-vendor")
  expect(vendors.length).toBeGreaterThan(1)
  // Every vendor is a closed header: no price inputs on screen until one is opened.
  for (const vendor of vendors) {
    expect(vendor.querySelector("button[aria-expanded]")).toHaveAttribute("aria-expanded", "false")
  }
  expect(screen.queryByLabelText("usageReport.priceModelId")).toBeNull()
  expect(screen.queryByPlaceholderText("usageReport.vendorUrlPlaceholder")).toBeNull()

  const openai = vendors.find((node) => node.getAttribute("data-vendor") === "OpenAI")!
  fireEvent.click(openai.querySelector("button[aria-expanded]")!)
  expect(openai.querySelector("button[aria-expanded]")).toHaveAttribute("aria-expanded", "true")
  expect(screen.getAllByLabelText("usageReport.priceModelId").length).toBeGreaterThan(0)
  // Another vendor stays closed, so opening one does not flood the page.
  const deepseek = screen.getAllByTestId("price-vendor").find((node) => node.getAttribute("data-vendor") === "DeepSeek")!
  expect(deepseek.querySelector("button[aria-expanded]")).toHaveAttribute("aria-expanded", "false")
})

test("unpriced models sit on top, ordered by usage, and one click inserts a matching row", async () => {
  // Two models the ledger used; neither has a price. The heavier one must come first.
  native.report.mockResolvedValue(
    report({
      points: [
        { date: today, hour: 3, provider: "custom", model: "deepseek-x9-sample", requests: 3, input: 900_000, cached: 0, output: 100_000, reasoning: 0, tokens: 1_000_000 },
        { date: today, hour: 4, provider: "custom", model: "tiny-model", requests: 1, input: 100, cached: 0, output: 10, reasoning: 0, tokens: 110 }
      ]
    })
  )
  render(<UsageSection />)
  await waitForStagedCards()
  openPriceConfig()
  const list = screen.getByTestId("unpriced-models")
  const ids = Array.from(list.querySelectorAll(".font-mono")).map((node) => node.textContent)
  expect(ids).toEqual(["deepseek-x9-sample", "tiny-model"])

  // Inserting lands in the vendor the id implies, opens it, and keeps the raw id for matching.
  fireEvent.click(screen.getAllByRole("button", { name: "usageReport.addPriceForModel" })[0])
  const deepseek = screen.getAllByTestId("price-vendor").find((node) => node.getAttribute("data-vendor") === "DeepSeek")!
  expect(deepseek.querySelector("button[aria-expanded]")).toHaveAttribute("aria-expanded", "true")
  const inputs = Array.from(deepseek.querySelectorAll('input[aria-label="usageReport.priceModelId"]')) as HTMLInputElement[]
  expect(inputs.map((input) => input.value)).toContain("deepseek-x9-sample")
})

test("a model marked free stops being unpriced, and a typed name replaces the id", async () => {
  native.report.mockResolvedValue(
    report({
      points: [
        { date: today, hour: 3, provider: "custom", model: "deepseek-x9-sample", requests: 3, input: 900_000, cached: 0, output: 100_000, reasoning: 0, tokens: 1_000_000 }
      ]
    })
  )
  render(<UsageSection />)
  await waitForStagedCards()
  openPriceConfig()
  expect(screen.getByTestId("unpriced-models")).toBeTruthy()

  // Insert the row for the model that was used, then mark it free instead of typing prices.
  fireEvent.click(screen.getAllByRole("button", { name: "usageReport.addPriceForModel" })[0])
  const deepseek = screen.getAllByTestId("price-vendor").find((node) => node.getAttribute("data-vendor") === "DeepSeek")!
  const ids = Array.from(deepseek.querySelectorAll('input[aria-label="usageReport.priceModelId"]')) as HTMLInputElement[]
  const row = ids.find((input) => input.value === "deepseek-x9-sample")!.closest("tr")!
  const free = row.querySelector('input[aria-label="usageReport.priceFree"]') as HTMLInputElement
  expect(free.checked).toBe(false)
  fireEvent.click(free)
  // Free is a real price: the model leaves the "未定价" list and its paid inputs lock.
  await waitFor(() => expect(screen.queryByTestId("unpriced-models")).toBeNull())
  const paid = row.querySelector('input[type="number"]') as HTMLInputElement
  expect(paid.disabled).toBe(true)

  // A name typed on the price row is what the report shows; the id stays on the element.
  const name = row.querySelector('input[aria-label="usageReport.priceName"]') as HTMLInputElement
  fireEvent.change(name, { target: { value: "自用 DS 闪电" } })
  const renamed = await screen.findAllByText("自用 DS 闪电")
  expect(renamed.length).toBeGreaterThan(0)
  expect(renamed.some((node) => node.getAttribute("title") === "deepseek-x9-sample")).toBe(true)
})

test("the per-row discount input edits the percentage and is independent of off-peak", async () => {
  // The price store is a module singleton; earlier tests may have mutated it. Start clean.
  usePriceStore.getState().resetPrices()
  render(<UsageSection />)
  await waitForStagedCards()
  openPriceConfig()
  // Open the OpenAI vendor so its price rows (and discount inputs) are on screen.
  const openai = screen.getAllByTestId("price-vendor").find((node) => node.getAttribute("data-vendor") === "OpenAI")!
  fireEvent.click(openai.querySelector("button[aria-expanded]")!)
  expect(openai.querySelector("button[aria-expanded]")).toHaveAttribute("aria-expanded", "true")

  const discountInputs = Array.from(
    openai.querySelectorAll('input[aria-label="usageReport.priceDiscount"]')
  ) as HTMLInputElement[]
  expect(discountInputs.length).toBeGreaterThan(0)
  // A paid row's discount field starts at 0 and is editable.
  expect(discountInputs[0].value).toBe("0")
  expect(discountInputs[0].disabled).toBe(false)
  fireEvent.change(discountInputs[0], { target: { value: "25" } })
  // The input shows the percentage; the store keeps the 0–1 fraction.
  expect((openai.querySelectorAll('input[aria-label="usageReport.priceDiscount"]')[0] as HTMLInputElement).value).toBe("25")
})

test("the per-row discount input locks while the model is marked free", async () => {
  native.report.mockResolvedValue(
    report({
      points: [
        { date: today, hour: 3, provider: "custom", model: "deepseek-x9-sample", requests: 3, input: 900_000, cached: 0, output: 100_000, reasoning: 0, tokens: 1_000_000 }
      ]
    })
  )
  // The price store is a module singleton; an earlier test may have priced this model already.
  usePriceStore.getState().resetPrices()
  render(<UsageSection />)
  await waitForStagedCards()
  openPriceConfig()
  fireEvent.click(screen.getAllByRole("button", { name: "usageReport.addPriceForModel" })[0])
  const deepseek = screen.getAllByTestId("price-vendor").find((node) => node.getAttribute("data-vendor") === "DeepSeek")!
  const row = (Array.from(deepseek.querySelectorAll('input[aria-label="usageReport.priceModelId"]')) as HTMLInputElement[])
    .find((input) => input.value === "deepseek-x9-sample")!
    .closest("tr")!
  const free = row.querySelector('input[aria-label="usageReport.priceFree"]') as HTMLInputElement
  fireEvent.click(free)
  await waitFor(() => expect((row.querySelector('input[aria-label="usageReport.priceDiscount"]') as HTMLInputElement).disabled).toBe(true))
})

test("the log and the price table show the custom model name while matching stays on the id", async () => {
  native.snapshot.value = {
    providers: {},
    customProviders: [
      {
        id: "custom_company",
        name: "Finture",
        baseUrl: "https://gateway.test/v1",
        apiKey: "k",
        models: [{ label: "公司 DS 闪电", api_id: "kimi-k2.6" }]
      }
    ],
    builtInModels: {},
    managedProviders: [],
    revision: 1
  }
  render(<UsageSection />)
  await waitForStagedCards()
  // The reader's own name is what the log shows; the id stays available as the tooltip.
  const named = await screen.findAllByText("公司 DS 闪电")
  expect(named.length).toBeGreaterThan(0)
  const cell = named.find((node) => node.getAttribute("title") === "kimi-k2.6")
  expect(cell).toBeTruthy()
})

test("a vendor update surfaces untracked models as one-click candidates", async () => {
  usePriceStore.getState().resetPrices()
  // One tracked model for the vendor under test.
  usePriceStore.getState().setPrices([{ ...blankPrice("Acme"), model: "acme-alpha", input: 1, output: 2 }])
  usePriceStore.getState().setVendorSource("Acme", {
    url: "https://acme.test/prices",
    currency: "USD",
    regex: "model (?<model>\\S+) price (?<input>[0-9.]+)/(?<output>[0-9.]+)"
  })
  // The fetched page lists the tracked model plus two the table does not track yet.
  native.fetchText.mockResolvedValue(
    "model acme-alpha price 1/2 model acme-beta price 3/4 model acme-gamma price 5/6"
  )

  render(<UsageSection />)
  await waitForStagedCards()
  openPriceConfig()

  const acme = screen.getAllByTestId("price-vendor").find((node) => node.getAttribute("data-vendor") === "Acme")!
  fireEvent.click(acme.querySelector("button[aria-expanded]")!)
  fireEvent.click(within(acme).getByRole("button", { name: "usageReport.vendorUpdate" }))

  // The update refreshes the tracked model and lists the two new ones as candidates.
  await waitFor(() =>
    expect(screen.getByText('usageReport.newModelsFound{"count":2}')).toBeInTheDocument()
  )
  expect(screen.getByRole("button", { name: "acme-beta" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "acme-gamma" })).toBeInTheDocument()
  // The already-tracked model is not offered as a candidate.
  expect(screen.queryByRole("button", { name: "acme-alpha" })).toBeNull()

  // One click adds the candidate to the table and removes it from the list.
  fireEvent.click(screen.getByRole("button", { name: "acme-beta" }))
  await waitFor(() => expect(screen.getByDisplayValue("acme-beta")).toBeInTheDocument())
  expect(screen.queryByRole("button", { name: "acme-beta" })).toBeNull()
  expect(screen.getByRole("button", { name: "acme-gamma" })).toBeInTheDocument()
})

test("额度重置不再挂在用量页：它属于 ChatGPT 账户卡", async () => {
  native.account.value = {
    account: { account: { type: "chatgpt", email: "a@b.c", planType: "pro" }, authConfigured: true },
    rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: null }
  }
  render(<UsageSection />)
  await waitForStagedCards()

  // Moved to `codex-provider-section.tsx`: the window it describes is the account's own, so the
  // usage report must not repeat it a page away from the account card.
  expect(screen.queryByText("usageReport.resetCardTitle")).toBeNull()
  expect(screen.queryByTestId("usage-reset-windows")).toBeNull()
  expect(screen.queryByRole("button", { name: "usageReport.resetCardRefresh" })).toBeNull()
})
