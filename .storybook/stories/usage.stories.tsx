import type { Meta, StoryObj } from "@storybook/react-vite"
import { mockIPC } from "@tauri-apps/api/mocks"
import "../../src/features/settings/settings.css"

import type { UsagePoint, UsageReport, UsageTurn } from "../../src/bindings"
import { UsageSection } from "../../src/features/settings/sections/usage-section"
import { dayKey } from "../../src/features/settings/usage-data"

/** Dates are relative to today so the 30-day range always keeps the whole sample in view. */
function dateDaysAgo(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return dayKey(date)
}

type Row = [days: number, provider: string, model: string, requests: number, input: number, cached: number, output: number, tokens: number]

// Shaped like the machine's real ledger: one very heavy day, a long quiet tail, and the same
// handful of models rotated between the account engine and the custom providers.
const ROWS: Row[] = [
  [0, "codex", "gpt-6.1-sol", 12, 320_000, 3_900_000, 88_000, 4_308_000],
  [0, "kimi", "kimi-k2.6", 5, 90_000, 720_000, 21_000, 831_000],
  [1, "codex", "gpt-6.1-sol", 38, 610_000, 9_400_000, 140_000, 10_150_000],
  [2, "codex", "gpt-6-luna", 9, 180_000, 2_100_000, 46_000, 2_326_000],
  [4, "deepseek", "deepseek-flash", 22, 260_000, 4_800_000, 61_000, 5_121_000],
  [5, "codex", "gpt-6.1-sol", 15, 210_000, 3_200_000, 58_000, 3_468_000],
  [5, "kimi", "kimi-k2.6", 4, 60_000, 640_000, 14_000, 714_000],
  [7, "codex", "gpt-6-astra", 11, 150_000, 1_900_000, 39_000, 2_089_000],
  [9, "hakimi", "claude-sonnet-5-5", 6, 95_000, 1_100_000, 27_000, 1_222_000],
  [12, "codex", "gpt-6.1-sol", 17, 240_000, 3_600_000, 63_000, 3_903_000],
  [12, "deepseek", "deepseek-flash", 8, 85_000, 1_300_000, 22_000, 1_407_000],
  [15, "codex", "gpt-6-luna", 7, 120_000, 1_500_000, 31_000, 1_651_000],
  [18, "qwen", "qwen3.8-max", 3, 48_000, 520_000, 11_000, 579_000],
  [19, "codex", "gpt-6.1-sol", 140, 2_400_000, 60_000_000, 380_000, 62_780_000],
  [19, "kimi", "kimi-k2.6", 90, 900_000, 25_000_000, 120_000, 26_020_000],
  [19, "codex", "gpt-6-astra", 45, 700_000, 8_400_000, 96_000, 9_196_000],
  // The window before the default 30 days, so the period-over-period lines have something to say.
  [34, "codex", "gpt-6.1-sol", 62, 780_000, 11_000_000, 150_000, 11_930_000],
  [36, "kimi", "kimi-k2.6", 24, 300_000, 3_400_000, 62_000, 3_762_000],
  [41, "deepseek", "deepseek-flash", 31, 380_000, 5_100_000, 74_000, 5_554_000],
  [47, "codex", "gpt-6-luna", 12, 180_000, 2_200_000, 44_000, 2_424_000],
  // Older still, so the month grid has colour in the two months before this one.
  [53, "deepseek", "deepseek-flash", 19, 240_000, 3_100_000, 52_000, 3_392_000],
  [61, "codex", "gpt-6.1-sol", 27, 420_000, 6_200_000, 96_000, 6_716_000],
  [68, "kimi", "kimi-k2.6", 13, 160_000, 1_700_000, 38_000, 1_898_000],
  [74, "codex", "gpt-6-luna", 8, 130_000, 1_600_000, 33_000, 1_763_000],
  [88, "deepseek", "deepseek-flash", 21, 290_000, 4_100_000, 58_000, 4_448_000]
]

const POINTS: UsagePoint[] = ROWS.map(([days, provider, model, requests, input, cached, output, tokens]) => ({
  date: dateDaysAgo(days),
  hour: 12,
  provider,
  model,
  requests,
  input,
  cached,
  output,
  reasoning: Math.round(output * 0.6),
  tokens
}))

const RECENT: UsageTurn[] = POINTS.filter((point) => point.date >= dateDaysAgo(2)).flatMap((point, index) =>
  Array.from({ length: Math.min(6, point.requests) }, (_, offset) => {
    const share = 1 / Math.min(6, point.requests)
    return {
      at: `${point.date}T${String(22 - index - offset).padStart(2, "0")}:${String(12 + offset * 7).padStart(2, "0")}:00.000Z`,
      date: point.date,
      provider: point.provider,
      model: point.model,
      input: Math.round(point.input * share),
      cached: Math.round(point.cached * share),
      output: Math.round(point.output * share),
      tokens: Math.round(point.tokens * share)
    }
  })
)

const REPORT: UsageReport = {
  points: POINTS,
  prompts: [],
  recent: RECENT,
  sessions: 13,
  scanned: 54,
  first: dateDaysAgo(88),
  last: dateDaysAgo(0),
  source: "<CODEX_HOME>/sessions"
}

/** `mockIPC` provides the transport but not the flag the page guards on, so set both. */
function installMock(report: UsageReport): void {
  ;(globalThis as { isTauri?: boolean }).isTauri = true
  mockIPC((command) => {
    if (command === "plugin:log|log" || command === "plugin:event|unlisten") return
    if (command === "plugin:event|listen") return 1
    if (command === "usage_report") return report
    return
  })
}

const EMPTY: UsageReport = {
  points: [],
  prompts: [],
  recent: [],
  sessions: 0,
  scanned: 0,
  first: null,
  last: null,
  source: "<CODEX_HOME>/sessions"
}

const meta = {
  title: "Settings/Usage",
  component: () => <UsageSection />,
  globals: { locale: "zh-CN" },
  beforeEach: () => installMock(REPORT),
  decorators: [
    (Story) => (
      <div className="settings-content" style={{ maxWidth: 780, margin: "0 auto", padding: 24 }}>
        <Story />
      </div>
    )
  ]
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Filled: Story = {}

export const NoSessionsYet: Story = {
  beforeEach: () => installMock(EMPTY)
}
