import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { dayKey } from "@/features/settings/usage-data"

const native = vi.hoisted(() => ({
  report: vi.fn()
}))

vi.mock("@/bindings", () => ({
  commands: {
    usageReport: native.report,
    // The refresh button forces a rebuild; the fake serves the same fixture either way.
    usageReportRefresh: native.report,
    // The usage page now reads the provider catalog to show the user's own model labels.
    providersRead: vi.fn(async () => ({ providers: {}, customProviders: [], builtInModels: {}, revision: 0 }))
  },
  events: {
    "providers:changed": {
      name: "providers:changed",
      listen: vi.fn(async () => () => {})
    }
  }
}))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options === undefined ? key : `${key}${JSON.stringify(options)}`),
    i18n: { language: "en" }
  })
}))

import { UsageSection } from "../usage-section"

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
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

/**
 * The page mounts charts, then the log, in later frames so the overview paints first. Tests that
 * assert on those cards have to wait for all three stages, not just for the overview's first text.
 */
async function waitForStagedCards(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "usageReport.group" })).toBeInTheDocument()
    expect(screen.getByLabelText("usageReport.detailFrom")).toBeInTheDocument()
  })
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
  expect(screen.getByRole("combobox", { name: "usageReport.rangeLabel" })).toHaveTextContent("usageReport.range.30d")
  expect(screen.getByRole("combobox", { name: "usageReport.metric" })).toBeInTheDocument()
  // "All" is the default grouping; the metric stays on Token.
  expect(screen.getByRole("combobox", { name: "usageReport.group" })).toHaveTextContent("usageReport.groupAll")
  expect(screen.getByRole("combobox", { name: "usageReport.metric" })).toHaveTextContent("usageReport.metricTokens")
  expect(native.report).toHaveBeenCalledOnce()
})

test("an empty ledger explains itself instead of showing zeros", async () => {
  native.report.mockResolvedValue(report({ points: [], recent: [] }))
  render(<UsageSection />)
  expect(await screen.findByText("usageReport.empty")).toBeInTheDocument()
  expect(screen.queryByText("usageReport.tokens")).toBeNull()
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
