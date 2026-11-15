import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"
import type { FreeUsage, ProviderQuota } from "@/lib/provider-quota"

import { ProviderUsageBlock } from "../provider-usage"

const invokeMock = vi.hoisted(() => vi.fn())
const openUrlMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock, openPath: vi.fn() }))

beforeAll(async () => {
  await initI18n("zh-CN")
})

beforeEach(() => {
  invokeMock.mockReset()
  openUrlMock.mockClear()
})

afterEach(() => {
  cleanup()
})

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

function quota(overrides: Partial<ProviderQuota> = {}): ProviderQuota {
  return {
    providerId: "openrouter",
    status: "ok",
    kind: "credits",
    remaining: 12.4,
    limit: 60,
    used: 47.6,
    unit: "usd",
    resetAt: null,
    expiresAt: null,
    plan: null,
    detail: null,
    unsupportedReason: null,
    fetchedAt: nowSeconds(),
    ...overrides
  }
}

/** Answers the three commands; `cached` is what the cache-first paint gets. */
function bridge(options: {
  cached?: ProviderQuota[]
  live?: ProviderQuota | Error
  free?: FreeUsage | Error
}): void {
  invokeMock.mockImplementation((command: string) => {
    if (command === "provider_quota_cached") return Promise.resolve(options.cached ?? [])
    if (command === "provider_quota_query") {
      const live = options.live
      if (live instanceof Error) return Promise.reject(live)
      return Promise.resolve(live ?? quota())
    }
    if (command === "openrouter_free_usage") {
      const free = options.free
      if (free === undefined) return Promise.reject(new Error("unsupported"))
      if (free instanceof Error) return Promise.reject(free)
      return Promise.resolve(free)
    }
    return Promise.resolve(null)
  })
}

test("a money window shows the balance against its limit plus when it resets", async () => {
  bridge({
    live: quota({
      resetAt: nowSeconds() + 3_600,
      expiresAt: nowSeconds() + 86_400,
      fetchedAt: nowSeconds()
    })
  })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  expect(view.getByText(/额度/)).toBeTruthy()
  expect(await view.findByText("$12.40 / $60.00")).toBeTruthy()
  expect(view.container.querySelector("[data-quota-reset]")?.textContent).toMatch(/重置于/)
  expect(view.container.querySelector("[data-quota-reset]")?.textContent).toMatch(/\d{2}:\d{2}:\d{2}/)
  expect(view.container.querySelector("[data-quota-expires]")?.textContent).toMatch(/有效期至/)
  expect(view.container.querySelector("[data-quota-fetched]")?.textContent).toMatch(/更新于/)
  // A live reading is not labelled as cached.
  expect(view.queryByText("缓存")).toBeNull()
})

test("a plan without a ceiling says so instead of printing a zero", async () => {
  bridge({ live: quota({ limit: null }) })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  expect(await view.findByText("$12.40 / 不限量")).toBeTruthy()
  expect(view.queryByText(/\$0\.00/)).toBeNull()
})

test("a counter unit keeps its own unit", async () => {
  bridge({ live: quota({ providerId: "qwen", unit: "requests", remaining: 812, limit: 1_000, used: 188 }) })
  const view = render(<ProviderUsageBlock providerId="qwen" active />)
  expect(await view.findByText(/剩余\s*812\s*requests/)).toBeTruthy()
})

test("a published limit with no published balance shows only the limit", async () => {
  bridge({ live: quota({ remaining: null, limit: 60, used: 47.6 }) })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  expect(await view.findByText("上限 $60.00")).toBeTruthy()
  // No figure block at all: 60 - 47.6 is arithmetic the vendor never stated.
  expect(view.container.querySelector("[data-quota-figure]")).toBeNull()
})

test("a console-only vendor names the console and opens it", async () => {
  bridge({ live: quota({ providerId: "qwen", status: "console", remaining: null, limit: null, used: null }) })
  const view = render(<ProviderUsageBlock providerId="qwen" active />)
  expect(await view.findByText("该供应商的套餐用量只能在控制台查看。")).toBeTruthy()
  fireEvent.click(view.getByRole("button", { name: /打开控制台/ }))
  await waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("https://bailian.console.aliyun.com/"))
  expect(view.container.querySelector("[data-quota-figure]")).toBeNull()
})

test("a console-only vendor without a known URL gets the sentence and no button", async () => {
  bridge({ live: quota({ providerId: "hakimi", status: "console", remaining: null, limit: null, used: null }) })
  const view = render(<ProviderUsageBlock providerId="hakimi" active />)
  expect(await view.findByText("该供应商的套餐用量只能在控制台查看。")).toBeTruthy()
  expect(view.queryByRole("button", { name: /打开控制台/ })).toBeNull()
})

test("a vendor with no usage endpoint says so and shows no numbers", async () => {
  bridge({ live: quota({ status: "unsupported", remaining: null, limit: null, used: null, unit: null }) })
  const view = render(<ProviderUsageBlock providerId="hakimi" active />)
  expect(await view.findByText("该供应商没有公开的额度接口。")).toBeTruthy()
  expect(view.container.querySelector("[data-quota-figure]")).toBeNull()
})

/**
 * The three `unsupported` states are not interchangeable: two of them are the reader's to fix, and
 * telling someone their vendor "has no quota API" when they simply switched it off is wrong.
 */
test("each unsupported reason gets its own sentence", async () => {
  const cases = [
    { reason: "noApi", text: "该供应商没有公开的额度接口。" },
    { reason: "disabled", text: "该供应商已关闭，未查询额度。" },
    { reason: "noBaseUrl", text: "该供应商没有配置接口地址，无法查询额度。" },
    // An unrecognised or missing token must fall back rather than invent one.
    { reason: null, text: "该供应商没有公开的额度接口。" },
    { reason: "somethingElse", text: "该供应商没有公开的额度接口。" }
  ]
  for (const { reason, text } of cases) {
    bridge({
      live: quota({
        status: "unsupported",
        remaining: null,
        limit: null,
        used: null,
        unit: null,
        unsupportedReason: reason
      })
    })
    const view = render(<ProviderUsageBlock providerId="kimi" active />)
    expect(await view.findByText(text), `reason ${String(reason)}`).toBeTruthy()
    view.unmount()
  }
})

test("a rejected key is said plainly", async () => {
  bridge({ live: quota({ status: "unauthorized", remaining: null, limit: null, used: null }) })
  const view = render(<ProviderUsageBlock providerId="qwen" active />)
  expect(await view.findByText("密钥无效或已过期。")).toBeTruthy()
})

test("a failed refresh keeps the cached figures and labels them", async () => {
  // The cache holds yesterday's reading; the live read fails. The reader still gets the numbers,
  // with the badge that says why they may be old.
  bridge({
    cached: [quota({ status: "ok", fetchedAt: nowSeconds() - 600 })],
    live: new Error("unreachable")
  })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  expect(await view.findByText("暂时查不到额度。")).toBeTruthy()
  expect(view.getByText("$12.40 / $60.00")).toBeTruthy()
  expect(view.getByText("缓存")).toBeTruthy()
})

test("a provider that has never answered says it cannot read the quota", async () => {
  bridge({ cached: [], live: new Error("unreachable") })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  expect(await view.findByText("暂时查不到额度。")).toBeTruthy()
  expect(view.container.querySelector("[data-quota-figure]")).toBeNull()
})

test("the cache paints first and the refresh button is disabled while the read is in flight", async () => {
  let release: (value: ProviderQuota) => void = () => {}
  invokeMock.mockImplementation((command: string) => {
    if (command === "provider_quota_cached") return Promise.resolve([quota({ remaining: 5, limit: 10 })])
    if (command === "provider_quota_query") return new Promise<ProviderQuota>((resolve) => (release = resolve))
    return Promise.resolve(null)
  })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  // The cached reading is on screen before the network answers...
  expect(await view.findByText("$5.00 / $10.00")).toBeTruthy()
  expect(view.getByText("缓存")).toBeTruthy()
  const button = view.getByRole("button", { name: /刷新/ })
  expect(button).toBeDisabled()
  // ...and the live answer replaces it and clears the badge.
  await act(async () => {
    release(quota({ remaining: 7, limit: 10 }))
  })
  await waitFor(() => expect(view.getByText("$7.00 / $10.00")).toBeTruthy())
  expect(view.queryByText("缓存")).toBeNull()
  expect(view.getByRole("button", { name: /刷新/ })).not.toBeDisabled()
})

test("the refresh button reads again", async () => {
  bridge({ live: quota() })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  await view.findByText("$12.40 / $60.00")
  const queries = (): number =>
    invokeMock.mock.calls.filter(([command]) => command === "provider_quota_query").length
  expect(queries()).toBe(1)
  fireEvent.click(view.getByRole("button", { name: /刷新/ }))
  await waitFor(() => expect(queries()).toBe(2))
})

/** The vendor's allowance lives on the same payload as this machine's tally — see `FreeUsage`. */
function freeUsage(overrides: Partial<FreeUsage> = {}): FreeUsage {
  return {
    date: "2026-01-02",
    calls: 0,
    limit: null,
    remaining: null,
    resetAt: null,
    resetSource: null,
    blocked: false,
    ...overrides
  }
}

test("the free line keeps the vendor's allowance and this machine's tally apart", async () => {
  bridge({
    live: quota({ status: "unsupported", remaining: null, limit: null, used: null }),
    free: freeUsage({ calls: 3, limit: 1_000, remaining: 988, resetAt: nowSeconds() + 82_800, resetSource: "vendor" })
  })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  expect(await view.findByText("今日免费额度")).toBeTruthy()
  // The ratio is the vendor's own pair, one source on both sides of the slash.
  expect(view.container.querySelector("[data-free-allowance]")?.textContent).toBe("988 / 1000")
  // The local tally is its own labelled figure and never enters that ratio.
  expect(view.getByText("本机今日调用")).toBeTruthy()
  expect(view.container.querySelector("[data-free-calls]")?.textContent).toBe("3")
  expect(view.container.textContent).not.toContain("3 / 1000")
  expect(view.queryByText(/已用完/)).toBeNull()
})

test("a spent allowance is a balance, not an enforced block", async () => {
  // `remaining: 0` from the key endpoint means the published budget is gone; it does not mean the
  // vendor refused a call (`blocked` is the only evidence of that).
  bridge({
    live: quota({ status: "unsupported", remaining: null, limit: null, used: null }),
    free: freeUsage({ calls: 0, limit: 50, remaining: 0, resetSource: null })
  })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  const allowance = await waitFor(() => {
    const node = view.container.querySelector("[data-free-allowance]")
    expect(node?.textContent).toBe("0 / 50")
    return node as HTMLElement
  })
  expect(view.queryByText(/已用完/)).toBeNull()
  expect(allowance.className).not.toContain("text-destructive")
})

test("an enforced 429 is red even though the allowance still has credit", async () => {
  // The short-window case: the vendor says 988 of 1000 are left and still rejected the call.
  bridge({
    live: quota({ status: "unsupported", remaining: null, limit: null, used: null }),
    free: freeUsage({
      calls: 12,
      limit: 1_000,
      remaining: 988,
      resetAt: nowSeconds() + 3_600,
      resetSource: "vendor",
      blocked: true
    })
  })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  expect(await view.findByText("今日免费额度已用完")).toBeTruthy()
  expect(view.container.querySelector("[data-free-allowance]")?.textContent).toBe("988 / 1000")
  expect(view.container.querySelector("[data-free-blocked]")?.className).toContain("text-destructive")
})

test("a published limit with an undisclosed remainder is stated in words", async () => {
  bridge({
    live: quota({ status: "unsupported", remaining: null, limit: null, used: null }),
    free: freeUsage({ calls: 3, limit: 1_000, remaining: null })
  })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  expect(await view.findByText("上限 1000（剩余未知）")).toBeTruthy()
  // No arithmetic in place of the vendor's silence, and no `?` either.
  expect(view.container.textContent).not.toContain("?")
  expect(view.container.querySelector("[data-free-allowance]")?.textContent).not.toContain("0 /")
})

test("a rolled-over day with nothing known draws a dash rather than a zero", async () => {
  bridge({
    live: quota({ status: "unsupported", remaining: null, limit: null, used: null }),
    free: freeUsage({ calls: 0, limit: null, remaining: null })
  })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  const allowance = await waitFor(() => {
    const node = view.container.querySelector("[data-free-allowance]")
    expect(node?.textContent).toBe("—")
    return node as HTMLElement
  })
  expect(allowance.className).not.toContain("text-destructive")
  expect(view.container.querySelector("[data-free-reset]")).toBeNull()
})

test("the vendor's reset is stated plainly, the computed UTC rollover as a rule", async () => {
  bridge({
    live: quota({ status: "unsupported", remaining: null, limit: null, used: null }),
    free: freeUsage({ limit: 1_000, remaining: 988, resetAt: nowSeconds() + 82_800, resetSource: "vendor" })
  })
  const vendor = render(<ProviderUsageBlock providerId="openrouter" active />)
  const vendorLabel = await waitFor(() => {
    const node = vendor.container.querySelector("[data-free-reset]")
    expect(node).not.toBeNull()
    return node as HTMLElement
  })
  expect(vendorLabel.textContent).toMatch(/后重置/)
  expect(vendorLabel.textContent).not.toContain("每日 UTC 0 点")

  cleanup()
  bridge({
    live: quota({ status: "unsupported", remaining: null, limit: null, used: null }),
    free: freeUsage({ limit: 1_000, remaining: 988, resetAt: nowSeconds() + 82_800, resetSource: "utcDay" })
  })
  const computed = render(<ProviderUsageBlock providerId="openrouter" active />)
  const computedLabel = await waitFor(() => {
    const node = computed.container.querySelector("[data-free-reset]")
    expect(node).not.toBeNull()
    return node as HTMLElement
  })
  // A midnight we derive ourselves must not be presented as an instant the vendor sent.
  expect(computedLabel.textContent).toContain("每日 UTC 0 点")
})

test("a replayed snapshot is labelled cached even though its status says ok", async () => {
  bridge({ live: quota({ detail: "stale", fetchedAt: nowSeconds() - 3_600 }) })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  expect(await view.findByText("$12.40 / $60.00")).toBeTruthy()
  expect(view.getByText("缓存")).toBeTruthy()
})

test("a plan with no ceiling says unlimited instead of drawing nothing", async () => {
  bridge({ live: quota({ remaining: null, limit: null, used: null, detail: "unlimited" }) })
  const view = render(<ProviderUsageBlock providerId="openrouter" active />)
  expect(await view.findByText("不限量")).toBeTruthy()
  expect(view.container.querySelector("[data-quota-figure]")).toBeNull()
  expect(view.container.querySelector("[data-quota-limit]")).toBeNull()
})

test("an unmetered gateway shows its plan and expiry and none of its quota units", async () => {
  // Verbatim shape of the 哈基米 gateway: `unlimited_quota: true`, so nothing is metered and the
  // plan figure is a 1.7e10 New API quota unit with no denominator — a number nobody can act on.
  bridge({
    live: quota({
      providerId: "hakimi",
      kind: "newapi",
      remaining: null,
      limit: null,
      used: 17_173_006_779,
      unit: "credits",
      plan: "套餐-Claude 半年卡|hybrid|10800|200",
      detail: "unlimited",
      resetAt: null,
      expiresAt: 1_799_565_597,
      fetchedAt: nowSeconds()
    })
  })
  const view = render(<ProviderUsageBlock providerId="hakimi" active />)
  expect(await view.findByText("不限量")).toBeTruthy()

  // The plan is printed verbatim, pipes and all, and is truncated by CSS rather than in the DOM.
  const plan = view.container.querySelector("[data-quota-plan]")
  expect(plan?.textContent).toBe("套餐 套餐-Claude 半年卡|hybrid|10800|200")
  expect(plan?.getAttribute("title")).toBe("套餐-Claude 半年卡|hybrid|10800|200")
  expect(plan?.className).toContain("truncate")

  // None of the `used` figure reaches the DOM, in any phrasing or grouping.
  const text = view.container.textContent ?? ""
  expect(text).not.toContain("17173006779")
  expect(text).not.toContain("17,173,006,779")
  expect(text).not.toContain("17.2")
  expect(view.container.querySelector("[data-quota-figure]")).toBeNull()
  expect(view.container.querySelector("[data-quota-limit]")).toBeNull()

  // A plan that ends is an expiry, never a reset — the two readings must not share wording.
  expect(view.container.querySelector("[data-quota-expires]")?.textContent).toMatch(/有效期至/)
  expect(view.container.querySelector("[data-quota-reset]")).toBeNull()
  expect(text).not.toMatch(/重置于/)
})

test("a card that is not the visible tab reads nothing and draws nothing", () => {
  bridge({ live: quota() })
  const view = render(<ProviderUsageBlock providerId="openrouter" active={false} />)
  expect(view.container.textContent).toBe("")
  expect(invokeMock).not.toHaveBeenCalled()
})
