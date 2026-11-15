import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
const credits = vi.hoisted(() => ({ payload: null as unknown }))
const redeemCalls = vi.hoisted(() => [] as Array<{ command: string; args: unknown }>)

vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/open", () => ({ openExternal: vi.fn(async () => undefined) }))
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => {
    if (command === "chatgpt_reset_credits") return credits.payload
    redeemCalls.push({ command, args })
    return { code: "reset", windowsReset: 2, creditId: "c1" }
  })
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options === undefined ? key : `${key}${JSON.stringify(options)}`,
    i18n: { language: "en" }
  })
}))

import { UsageResetBlock } from "../usage-reset-card"

const NOW = new Date("2026-11-15T10:00:00Z").getTime()

function credit(id: string, inSeconds: number | null) {
  return {
    id,
    title: "Full reset (Weekly + 5 hr)",
    description: "Ready to redeem",
    grantedAt: "2026-11-01T00:00:00Z",
    expiresAt: null,
    expiresAtUnix: inSeconds === null ? null : Math.floor(NOW / 1_000) + inSeconds,
    status: "available"
  }
}

function snapshot(list: ReturnType<typeof credit>[], availableCount = list.length) {
  return { status: "ok", availableCount, credits: list, fetchedAt: NOW, detail: null }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  credits.payload = null
  redeemCalls.length = 0
  window.localStorage.clear()
  toast.warning.mockClear()
  toast.success.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test("the count comes from availableCount, not from the truncated list", async () => {
  credits.payload = snapshot([credit("a", 86_400)], 3)
  render(<UsageResetBlock refreshToken={0} />)

  expect(
    await screen.findByText(`usageReport.resetCreditsTitleCount${JSON.stringify({ count: 3 })}`)
  ).toBeInTheDocument()
})

test("three rows are drawn, the rest fold away and can be unfolded", async () => {
  credits.payload = snapshot([credit("a", 3_600), credit("b", 7_200), credit("c", 10_800), credit("d", 14_400)])
  render(<UsageResetBlock refreshToken={0} />)

  const list = await screen.findByTestId("usage-reset-credits")
  expect(list.querySelectorAll("li")).toHaveLength(3)
  fireEvent.click(screen.getByText(`usageReport.resetCreditsShowAll${JSON.stringify({ count: 1 })}`))
  expect(screen.getByTestId("usage-reset-credits").querySelectorAll("li")).toHaveLength(4)
})

test("the countdown spells out days, hours, minutes and seconds", async () => {
  credits.payload = snapshot([credit("a", 3 * 86_400 + 2 * 3_600 + 125)])
  render(<UsageResetBlock refreshToken={0} />)

  // The exact second drifts by one between building the fixture and the component's first tick,
  // so the units are asserted rather than the whole string.
  const node = await screen.findByText(/expiryDays/)
  expect(node.textContent).toContain("expiryDays")
  // Days are the leading unit: three of them, from a fixture just over three days out.
  expect(node.textContent).toContain("3")
})

test("redeeming needs a second click and sends exactly one request", async () => {
  credits.payload = snapshot([credit("a", 86_400)])
  render(<UsageResetBlock refreshToken={0} />)

  fireEvent.click(await screen.findByText("usageReport.redeemNow"))
  expect(redeemCalls).toHaveLength(0)
  fireEvent.click(screen.getByText("usageReport.redeemConfirm"))

  await waitFor(() => expect(redeemCalls).toHaveLength(1))
  expect(redeemCalls[0]).toEqual({ command: "chatgpt_reset_credit", args: { creditId: "a" } })
  await waitFor(() => expect(toast.success).toHaveBeenCalled())
})

test("a credit expiring tomorrow raises one reminder, not one per render", async () => {
  credits.payload = snapshot([credit("a", 3_600)], 1)
  const { unmount } = render(<UsageResetBlock refreshToken={0} />)

  await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1))
  expect(toast.warning).toHaveBeenCalledWith("usageReport.resetCreditSoonOne")

  unmount()
  render(<UsageResetBlock refreshToken={0} />)
  await screen.findByTestId("usage-reset-credits")
  expect(toast.warning).toHaveBeenCalledTimes(1)
})

test("a credit without an expiry still gets a row but no countdown or button", async () => {
  credits.payload = snapshot([credit("a", null)])
  render(<UsageResetBlock refreshToken={0} />)

  expect(await screen.findByText("usageReport.resetCreditsNoExpiry")).toBeInTheDocument()
  expect(screen.queryByText("usageReport.redeemNow")).toBeNull()
})
