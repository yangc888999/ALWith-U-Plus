// The automatic price refresh: shared fetch, never-wipe/never-zero merges, cross-vendor price
// propagation, ledger-driven row creation, and the due gate. All network access is injected.
import { beforeEach, expect, test, vi } from "vitest"

import {
  addUnpricedModels,
  PRICE_REFRESH_INTERVAL_MS,
  propagateSharedPrices,
  refreshAllVendorPrices,
  refreshPricesIfDue
} from "../price-refresh"
import { blankPrice, DEFAULT_PRICES, modelMatchKey, usePriceStore } from "../price-store"

beforeEach(() => {
  usePriceStore.setState({ prices: DEFAULT_PRICES.map((price) => ({ ...price })), updatedAt: null })
})

const openrouterCatalog = JSON.stringify({
  data: [
    { id: "anthropic/claude-opus-5-5", pricing: { prompt: "0.000004", completion: "0.00002", input_cache_read: "0.0000002" } },
    { id: "x-ai/grok-4.7", pricing: { prompt: "0.000002", completion: "0.000006", input_cache_read: "0.0000005" } },
    { id: "xiaomi/mimo-v2.6-pro", pricing: { prompt: "0.000000435", completion: "0.00000087", input_cache_read: "0.0000000036" } }
  ]
})

test("one catalog fetch backs every OpenRouter vendor; official rows update in place", async () => {
  const fetchText = vi.fn(async (url: string) => {
    if (url.includes("openrouter")) return openrouterCatalog
    throw new Error("offline")
  })
  const result = await refreshAllVendorPrices(fetchText)
  // Claude / xAI / 小米 / OpenRouter all read the same URL — exactly one request for it.
  const openrouterCalls = fetchText.mock.calls.filter(([url]) => url.includes("openrouter"))
  expect(openrouterCalls).toHaveLength(1)
  const claude = result.outcomes.find((outcome) => outcome.vendor === "Claude")
  expect(claude?.status).toBe("ok")
  const prices = usePriceStore.getState().prices
  const opus = prices.find((price) => price.vendor === "Claude" && price.model === "claude-opus-5-5")
  expect(opus?.input).toBe(4)
  expect(opus?.output).toBe(20)
  // A vendor whose page is unreachable keeps its curated numbers — never wiped, never zeroed.
  const deepseek = prices.find((price) => price.model === "deepseek-v4-pro")
  expect(deepseek?.input).toBe(9)
  expect(result.outcomes.find((outcome) => outcome.vendor === "DeepSeek")?.status).toBe("error")
})

test("the same model id under two vendors converges to the official price", () => {
  const prices = [
    { ...blankPrice("Claude"), model: "claude-opus-5-5", input: 4, cached: 0.2, output: 20 },
    // A second gateway's row for the same id, stale numbers.
    { ...blankPrice("某网关"), model: "claude-opus-5.5", input: 1, cached: 0, output: 1 },
    // An aggregator row with its own routing quote keeps it.
    { ...blankPrice("OpenRouter"), model: "anthropic/claude-opus-5-5", input: 3.9, cached: 0.19, output: 19.5 }
  ]
  const changed = propagateSharedPrices(prices)
  expect(changed).toBe(1)
  expect(prices[1].input).toBe(4)
  expect(prices[1].output).toBe(20)
  expect(prices[2].input).toBe(3.9)
})

test("an aggregator row with no price of its own receives the official numbers", () => {
  const prices = [
    { ...blankPrice("Kimi"), model: "kimi-k3", input: 20, cached: 2, output: 100, currency: "CNY" as const },
    { ...blankPrice("OpenRouter"), model: "moonshotai/kimi-k3", input: 0, cached: 0, output: 0 }
  ]
  expect(propagateSharedPrices(prices)).toBe(1)
  expect(prices[1].input).toBe(20)
  expect(prices[1].currency).toBe("CNY")
})

test("ledger models without a row are classified and added once", () => {
  const vendors = new Map([[modelMatchKey("gateway-x/new-model"), "某网关"]])
  const added = addUnpricedModels(["gateway-x/new-model", "claude-opus-5-5", "gpt-9-turbo"], vendors)
  // claude-opus-5-5 is already tracked; the other two get rows.
  expect(added).toEqual(["gateway-x/new-model", "gpt-9-turbo"])
  const prices = usePriceStore.getState().prices
  expect(prices.find((price) => price.model === "gateway-x/new-model")?.vendor).toBe("某网关")
  expect(prices.find((price) => price.model === "gpt-9-turbo")?.vendor).toBe("OpenAI")
  // A second pass adds nothing.
  expect(addUnpricedModels(["gateway-x/new-model", "gpt-9-turbo"], vendors)).toEqual([])
})

// Regression: the provider catalog calls the vendor "Qwen" while the price table's group (and its
// aliyun price source) is "千问 Qwen". Auto-adding a new qwen model must land in the existing card,
// not mint a second "Qwen" card with no URL.
test("a ledger model from the Qwen provider lands in the 千问 Qwen card", () => {
  const vendors = new Map([[modelMatchKey("qwen5-max"), "Qwen"]])
  const added = addUnpricedModels(["qwen5-max"], vendors)
  expect(added).toEqual(["qwen5-max"])
  const prices = usePriceStore.getState().prices
  const row = prices.find((price) => price.model === "qwen5-max")
  expect(row?.vendor).toBe("千问 Qwen")
  expect(prices.filter((price) => price.vendor === "Qwen")).toHaveLength(0)
})

test("a custom gateway model lands in Finture under its bare model id", () => {
  const id = "custom-example/deepseek-V4.1-flash-enterprise"
  const added = addUnpricedModels([id], new Map([[modelMatchKey("deepseek-V4.1-flash"), "DeepSeek"]]))
  expect(added).toEqual(["deepseek-V4.1-flash-enterprise"])
  const row = usePriceStore.getState().prices.find((price) => price.model === "deepseek-V4.1-flash-enterprise")
  expect(row?.vendor).toBe("Finture")
})

test("a bare id already tracked under a full vendor/model id is not added twice", () => {
  usePriceStore.setState({
    prices: [{ ...blankPrice("OpenRouter"), model: "moonshotai/kimi-k3", input: 1, cached: 0, output: 1 }]
  })
  expect(addUnpricedModels(["kimi-k3"], new Map())).toEqual([])
})

test("the due gate runs at most once per interval unless forced", async () => {
  const memory = new Map<string, string>()
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value) }
  const fetchText = vi.fn(async () => openrouterCatalog)
  const now = 1_000_000_000_000
  const first = await refreshPricesIfDue({ storage, now: () => now, fetchText })
  expect(first).not.toBeNull()
  // Same instant: gated.
  expect(await refreshPricesIfDue({ storage, now: () => now + 1000, fetchText })).toBeNull()
  // Past the interval: runs again.
  expect(await refreshPricesIfDue({ storage, now: () => now + PRICE_REFRESH_INTERVAL_MS + 1, fetchText })).not.toBeNull()
  // Forced: runs regardless.
  expect(await refreshPricesIfDue({ storage, now: () => now + PRICE_REFRESH_INTERVAL_MS + 2, fetchText, force: true })).not.toBeNull()
})
