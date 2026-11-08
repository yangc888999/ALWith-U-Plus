// Per-model price table that turns raw token counts into a money figure on the usage page.
//
// Why a front-end store and not the engine's settings: the engine has no idea what a custom
// provider charges, so pricing lives on the client. zustand's persist drops it in localStorage
// (same origin as the settings webview) so the user's edits survive relaunches.
//
// The table is grouped by vendor and each entry carries its own currency: DeepSeek / Kimi /
// Qwen / 智谱 publish prices in CNY, while OpenAI / Anthropic / Google / xAI publish in USD.
// A single global exchange rate converts the USD entries so the headline figure is always RMB.
//
// Vendors with time-of-day pricing (DeepSeek) get an optional off-peak tier plus the peak
// windows that select it. Windows are written as "HH:MM-HH:MM" pairs and interpreted in the
// user's chosen UTC offset (default +8, i.e. Beijing time). Everything outside the windows is
// billed at the off-peak price.
import { create } from "zustand"
import { persist } from "zustand/middleware"

export type Currency = "USD" | "CNY"

/** The three billable token classes. */
export type PriceTier = {
  /** Price per 1M tokens, uncached input. */
  input: number
  /** Price per 1M tokens, cache read. */
  cached: number
  /** Price per 1M tokens, output. */
  output: number
}

export type ModelPrice = PriceTier & {
  /** Display grouping only; matching still uses `model`. */
  vendor: string
  /** Matches `UsagePoint.model` (the bare name, or the part after `provider/`). */
  model: string
  /** Currency the three prices above are quoted in. */
  currency: Currency
  /** Discounted tier for off-peak hours; null = flat pricing. */
  offPeak: PriceTier | null
  /** Peak windows, comma separated, e.g. "09:00-12:00,14:00-18:00". Empty = always peak. */
  peakWindows: string
  /** Peak windows only apply Monday–Friday. */
  weekdaysOnly: boolean
  /** Billing condition worth keeping next to the number (long-context tier, cache write, …). */
  note: string
}

/** Where a vendor's official prices are fetched from, and how to pull them out of the page. */
export type VendorSource = {
  /** Official pricing page (or endpoint) URL. */
  url: string
  /** Regex applied to the fetched text. Named groups: `model`/`input`/`output`, optional `cached`
   *  (defaults 0), and an optional second model (`model2`/`input2`/`cached2`/`output2`) for rows
   *  that carry two models side by side (DeepSeek's peak/off-peak table). */
  regex: string
  /** Currency the extracted numbers are quoted in. */
  currency: Currency
  /** When set, the response is parsed as OpenRouter's `/api/v1/models` JSON and filtered to this
   *  vendor prefix (e.g. `anthropic`). The reliable path for pages that are JS-only or blocked. */
  openrouter?: string
}

export type PriceState = {
  prices: ModelPrice[]
  /** CNY per 1 USD, used for every entry quoted in USD. */
  usdToCny: number
  /** UTC offset (hours) used to interpret `peakWindows`. Default +8 (Beijing). */
  utcOffset: number
  /** Per-vendor fetch source (official pricing page + extraction regex). */
  vendorSources: Record<string, VendorSource>
  /** ISO timestamp of the last successful remote update, if any. */
  updatedAt: string | null
  setPrices: (prices: ModelPrice[]) => void
  setUsdToCny: (value: number) => void
  setUtcOffset: (value: number) => void
  setVendorSource: (vendor: string, patch: Partial<VendorSource>) => void
  resetPrices: () => void
}

/** Vendors that quote in RMB. Used only to pick a sensible default currency. */
const CNY_VENDORS = [
  "deepseek",
  "kimi",
  "moonshot",
  "qwen",
  "通义",
  "千问",
  "智谱",
  "glm",
  "zhipu",
  "minimax",
  "小米",
  "mimo"
]

function looksCny(vendor: string): boolean {
  const name = vendor.toLowerCase()
  return CNY_VENDORS.some((keyword) => name.includes(keyword))
}

/** Best-effort vendor for a persisted entry that predates the vendor column. */
export function guessVendor(model: string): string {
  const name = model.toLowerCase()
  if (name.includes("claude")) return "Anthropic"
  if (name.includes("gpt") || name.startsWith("o3") || name.startsWith("o4")) return "OpenAI"
  if (name.includes("gemini")) return "Google"
  if (name.includes("deepseek")) return "DeepSeek"
  if (name.includes("kimi") || name.includes("moonshot")) return "Kimi"
  if (name.includes("qwen")) return "Qwen"
  if (name.includes("glm")) return "智谱"
  if (name.includes("grok")) return "xAI"
  return "其他"
}

function entry(
  vendor: string,
  model: string,
  input: number,
  cached: number,
  output: number,
  extra: Partial<ModelPrice> = {}
): ModelPrice {
  return {
    vendor,
    model,
    currency: looksCny(vendor) ? "CNY" : "USD",
    input,
    cached,
    output,
    offPeak: null,
    peakWindows: "",
    weekdaysOnly: false,
    note: "",
    ...extra
  }
}

/** DeepSeek's discounted hours: off-peak everywhere except weekday 09–12 and 14–18 (Beijing). */
const DEEPSEEK_PEAK = "09:00-12:00,14:00-18:00"
const DEEPSEEK_NOTE = "工作日北京时间 09:00–12:00、14:00–18:00 为高峰；其余时段（含周末及法定节假日）按闲时价"
const OPENAI_NOTE = "Standard · 短上下文；长上下文另有定价"
const XAI_NOTE = "短上下文 <200K；≥200K 时输入/缓存/输出同步上调"

/**
 * Official standard API rates as of 2026-11-03, cross-checked against each vendor's pricing
 * page. The set follows the static `AI_Model_API_Pricing_2026-11-03.html` reference
 * (8 vendors / 25 model ids) and adds Xiaomi MiMo because it is a provider configured in this
 * app. Variants that share a model id collapse into one row: DeepSeek peak/off-peak becomes
 * `offPeak`, and length-tiered models keep their base tier with the higher tier in `note`.
 */
export const DEFAULT_PRICES: ModelPrice[] = [
  // OpenAI — USD.
  entry("OpenAI", "gpt-6-astra", 10, 1, 50, { note: OPENAI_NOTE }),
  entry("OpenAI", "gpt-6.1-sol", 2, 0.1, 10, { note: OPENAI_NOTE }),
  entry("OpenAI", "gpt-6.1-terra", 1, 0.05, 5, { note: OPENAI_NOTE }),
  entry("OpenAI", "gpt-6-luna", 0.1, 0.01, 0.5, { note: OPENAI_NOTE }),

  // Claude — USD. `cached` is the cache-read price; cache writes are billed separately.
  entry("Claude", "claude-fable-5-1", 10, 0.25, 50, { note: "5 分钟缓存写入另计 $12.50/MTok" }),
  entry("Claude", "claude-opus-5-5", 4, 0.2, 20, { note: "5 分钟缓存写入另计 $5/MTok" }),
  entry("Claude", "claude-sonnet-5-5", 2, 0.1, 10, { note: "5 分钟缓存写入另计 $2.50/MTok" }),
  entry("Claude", "claude-haiku-5-5", 0.1, 0.01, 0.5, {
    note: "≤100K Token；超过 100K：输入 $0.50、缓存 $0.05、输出 $2.50"
  }),

  // DeepSeek — RMB, half price outside the weekday peak windows.
  entry("DeepSeek", "deepseek-v4-pro", 9, 0.3, 27, {
    offPeak: { input: 4.5, cached: 0.15, output: 13.5 },
    peakWindows: DEEPSEEK_PEAK,
    weekdaysOnly: true,
    note: DEEPSEEK_NOTE
  }),
  entry("DeepSeek", "deepseek-flash", 2, 0.04, 8, {
    offPeak: { input: 1, cached: 0.02, output: 4 },
    peakWindows: DEEPSEEK_PEAK,
    weekdaysOnly: true,
    note: `对应 DeepSeek-V4.1-Flash-1017；${DEEPSEEK_NOTE}`
  }),

  // 千问 Qwen — RMB, implicit cache-hit price.
  entry("千问 Qwen", "qwen3.8-max", 12, 1.5, 36, { note: "隐式缓存命中；显式缓存命中 ¥1.00/MTok" }),
  entry("千问 Qwen", "qwen3.8-27b", 3, 0.6, 12, { note: "隐式缓存命中；显式缓存命中 ¥0.30/MTok" }),
  entry("千问 Qwen", "qwen3.8-flash", 0.8, 0.1, 2.7, { note: "隐式 / 显式缓存命中价均为 ¥0.10/MTok" }),

  // Kimi — RMB.
  entry("Kimi", "kimi-k3.1-pro", 13, 1.3, 68, { note: "按量计费；缓存写入 ¥13/MTok" }),
  entry("Kimi", "kimi-k3.1-pro-highspeed", 26, 1.3, 136, { note: "按量计费；缓存写入 ¥26/MTok" }),
  entry("Kimi", "kimi-k3", 20, 2, 100, { note: "仍在售；缓存写入 ¥20/MTok" }),

  // 智谱 GLM — RMB.
  entry("智谱 GLM", "GLM-5.3", 8, 2, 28, { note: "缓存存储限时免费" }),
  entry("智谱 GLM", "GLM-5.3-Flash", 0.8, 0.23, 2.8, { note: "缓存存储限时免费" }),
  entry("智谱 GLM", "GLM-5.3-FlashX", 2, 0.57, 7, { note: "高速档；缓存存储限时免费" }),

  // xAI — USD.
  entry("xAI", "grok-4.7", 2, 0.5, 6, { note: XAI_NOTE }),
  entry("xAI", "grok-build-0.1", 1, 0.2, 2, { note: XAI_NOTE }),
  entry("xAI", "grok-4.6", 2, 0.5, 6, { note: XAI_NOTE }),
  entry("xAI", "grok-4.3", 1.25, 0.2, 2.5, { note: XAI_NOTE }),

  // MiniMax — RMB. M3 keeps its ≤512K tier; the >512K tier lives in `note`.
  entry("MiniMax", "MiniMax-M3.1-Flash", 1, 0.1, 4, { note: "标准定价" }),
  entry("MiniMax", "MiniMax-M3", 2.1, 0.42, 8.4, {
    note: "单次输入 ≤512K Token；>512K：输入 ¥4.2、缓存 ¥0.84、输出 ¥16.8"
  }),

  // 小米 MiMo — domestic RMB for Pro/Flash; UltraSpeed only publishes USD.
  entry("小米 MiMo", "mimo-v2.6-pro", 3, 0.025, 6, {
    note: "国内人民币价；海外 $0.435 / $0.0036 / $0.87"
  }),
  entry("小米 MiMo", "mimo-v2.6-flash", 1, 0.02, 2, {
    note: "国内人民币价；海外 $0.14 / $0.0028 / $0.28"
  }),
  entry("小米 MiMo", "mimo-v2.6-pro-ultraspeed", 4.35, 0.036, 8.7, {
    note: "海外美元价；国内人民币价未公布"
  })
]

export const DEFAULT_USD_TO_CNY = 7.2
export const DEFAULT_UTC_OFFSET = 8

/** A blank row a vendor group can append without inheriting another vendor's prices. */
export function blankPrice(vendor: string): ModelPrice {
  return entry(vendor, "", 0, 0, 0)
}

/**
 * Normalize a raw JSON array (from the auto-update URL or a manual import) into `ModelPrice[]`.
 * Shared by the remote updater and the local file importer so both accept the same shape and the
 * same fallbacks: unknown currencies default to USD, a missing model id is dropped, and the peak
 * tier is optional. Returns only the valid rows.
 */
export function parsePriceArray(parsed: unknown): ModelPrice[] {
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array")
  return parsed
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => {
      const vendor = String(item.vendor ?? "其他")
      return {
        vendor,
        model: String(item.model ?? ""),
        currency: (String(item.currency ?? "").toUpperCase() === "CNY" ? "CNY" : "USD") as Currency,
        input: Number(item.input) || 0,
        cached: Number(item.cached) || 0,
        output: Number(item.output) || 0,
        offPeak:
          item.offPeak !== null && typeof item.offPeak === "object"
            ? {
                input: Number((item.offPeak as Record<string, unknown>).input) || 0,
                cached: Number((item.offPeak as Record<string, unknown>).cached) || 0,
                output: Number((item.offPeak as Record<string, unknown>).output) || 0
              }
            : null,
        peakWindows: String(item.peakWindows ?? ""),
        weekdaysOnly: Boolean(item.weekdaysOnly),
        note: String(item.note ?? "")
      } satisfies ModelPrice
    })
    .filter((item) => item.model !== "")
}

// ---- Per-vendor one-click update ------------------------------------------------------

/** A row the regex pulls out of a vendor's pricing page. Prices are per 1M tokens.
 *  A field the regex did not capture stays `undefined` so an update never zeroes a price the
 *  page simply does not publish (Qwen's cache price lives in a separate table, for example). */
export type ParsedModelPrice = { model: string; input?: number; cached?: number; output?: number }

const PRICE_NUM = "\\d+(?:\\.\\d+)?"

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Strip $ / ¥ / ￥ / thousand separators, then parse; an absent or unparseable group is undefined. */
function toPrice(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw.replace(/[$¥￥,\s]/g, ""))
  return Number.isFinite(value) ? value : undefined
}

/** Matching key that folds dots/dashes and case, so `claude-opus-5.5` and `claude-opus-5-5` agree. */
export function modelMatchKey(model: string): string {
  return model.trim().toLowerCase().replace(/[\s.]/g, "-")
}

/**
 * Run a vendor's regex over the fetched page text. One match = one model row; a match may also
 * carry a second model (`model2`/`input2`/`cached2`/`output2`) for two-model rows. `cached`
 * defaults to 0 when the group is absent. Duplicate ids and all-zero rows are dropped; an empty
 * result throws so a bad regex can never silently wipe a vendor's table.
 */
export function parseVendorPrices(text: string, regex: string): ParsedModelPrice[] {
  let re: RegExp
  try {
    re = new RegExp(regex, "g")
  } catch (cause) {
    throw new Error(`invalid regex: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const rows: ParsedModelPrice[] = []
  const seen = new Set<string>()
  const push = (model: string, input: number | undefined, cached: number | undefined, output: number | undefined) => {
    const key = model.trim().toLowerCase()
    if (key === "" || seen.has(key)) return
    // A row with no price at all is a stray match (a header, a nav item), not a model.
    if (input === undefined && output === undefined) return
    seen.add(key)
    rows.push({
      model: model.trim(),
      ...(input === undefined ? {} : { input }),
      ...(cached === undefined ? {} : { cached }),
      ...(output === undefined ? {} : { output })
    })
  }
  for (const match of text.matchAll(re)) {
    const groups = match.groups ?? {}
    push(String(groups.model ?? ""), toPrice(groups.input), toPrice(groups.cached), toPrice(groups.output))
    if (groups.model2 !== undefined) {
      push(String(groups.model2), toPrice(groups.input2), toPrice(groups.cached2), toPrice(groups.output2))
    }
  }
  if (rows.length === 0) throw new Error("regex matched no models")
  return rows
}

/**
 * Parse OpenRouter's `/api/v1/models` JSON, filtered to one vendor prefix (e.g. `anthropic`).
 *
 * The reliable source for vendors whose own pages are JS-only, RSC, or unreachable from this
 * machine. OpenRouter quotes USD per token, so each number is scaled to per-1M; the bare model id
 * (after the prefix) is kept, and variant ids (`:batch`, `:free`, …) are skipped.
 */
export function parseOpenRouterPrices(text: string, prefix: string): ParsedModelPrice[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("OpenRouter response was not JSON")
  }
  const data = (parsed as { data?: unknown }).data
  if (!Array.isArray(data)) throw new Error("OpenRouter response has no models")
  const rows: ParsedModelPrice[] = []
  const seen = new Set<string>()
  const perMillion = (value: unknown): number | undefined => {
    const amount = Number(value)
    if (!Number.isFinite(amount) || amount < 0) return undefined
    // Round to 6 decimals: 0.0000004 * 1e6 lands on 0.39999999999999997 in float.
    return Math.round(amount * 1_000_000 * 1_000_000) / 1_000_000
  }
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue
    const model = entry as { id?: unknown; pricing?: Record<string, unknown> }
    if (typeof model.id !== "string" || !model.id.startsWith(`${prefix}/`)) continue
    const bare = model.id.slice(prefix.length + 1)
    if (bare === "" || bare.includes(":")) continue
    const key = bare.toLowerCase()
    if (seen.has(key)) continue
    const pricing = model.pricing ?? {}
    const input = perMillion(pricing.prompt)
    const output = perMillion(pricing.completion)
    const cached = perMillion(pricing.input_cache_read)
    if (input === undefined && output === undefined) continue
    seen.add(key)
    rows.push({
      model: bare,
      ...(input === undefined ? {} : { input }),
      ...(cached === undefined ? {} : { cached }),
      ...(output === undefined ? {} : { output })
    })
  }
  if (rows.length === 0) throw new Error(`no ${prefix} models in the OpenRouter response`)
  return rows
}

/** Build a best-effort flat regex: model id, then input / cached / output prices in order. */
function flatSource(url: string, currency: Currency, models: string[]): VendorSource {
  const alts = models.map(escapeRegex).join("|")
  const symbol = "[$¥￥]?\\s*"
  return {
    url,
    currency,
    regex: `(?<model>${alts})[\\s\\S]{0,600}?${symbol}(?<input>${PRICE_NUM})[\\s\\S]{0,200}?${symbol}(?<cached>${PRICE_NUM})[\\s\\S]{0,200}?${symbol}(?<output>${PRICE_NUM})`
  }
}

/** One reachable JSON endpoint that quotes every major vendor; used where the vendor's own page
 *  is JS-only, RSC, or blocked. Prices are USD per token and scaled to per-1M by the parser. */
const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models"

/**
 * Pricing sources, keyed by vendor: a URL plus either a regex (HTML pages) or an OpenRouter prefix.
 * Official pages are HTML and change without notice, so the regex is editable in the UI and should
 * be tested with the vendor's "更新" button. Verified against the live page: OpenAI, DeepSeek, Kimi,
 * Qwen, MiniMax (M3.1-Flash). Claude / 智谱 / xAI read from OpenRouter.
 */
export const DEFAULT_VENDOR_SOURCES: Record<string, VendorSource> = {
  // OpenAI: platform.openai.com 301-redirects here, and that redirect is what a transparent
  // proxy tends to break. The page embeds each row as [0,"model"],[0,in],[0,cache],[0,write],[0,out],
  // which is stable enough to pull with one regex (verified against the live page).
  OpenAI: {
    url: "https://developers.openai.com/api/docs/pricing",
    currency: "USD",
    regex:
      "\\[0,&quot;(?<model>[^&]+)&quot;\\],\\[0,(?<input>[0-9.]+)\\],\\[0,(?<cached>[0-9.]+)\\],\\[0,(?:[0-9.]+|&quot;-&quot;)\\],\\[0,(?<output>[0-9.]+)\\]"
  },
  // Anthropic / 智谱 / xAI: their own pages are an RSC payload, a JS-only shell, and an id format
  // (`grok-4-7`) no flat table exposes. OpenRouter's JSON is reachable and quotes every one of them,
  // so these read from it (USD per token → per-1M).
  Claude: { url: OPENROUTER_MODELS, currency: "USD", regex: "", openrouter: "anthropic" },
  DeepSeek: {
    url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
    currency: "CNY",
    // Two models share one table, columns = models, "高峰时段" rows = peak prices. Captures both
    // models in one match (model/model2), off-peak stays manual (it is exactly half of peak).
    regex:
      "(?<model>deepseek-flash)<sup>\\(1\\)</sup></td><td>(?<model2>deepseek-v4-pro)</td>[\\s\\S]*?高峰时段</td><td>(?<cached>\\d+(?:\\.\\d+)?)元</td><td>(?<cached2>\\d+(?:\\.\\d+)?)元</td></tr>[\\s\\S]*?<tr><td>高峰时段</td><td>(?<input>\\d+(?:\\.\\d+)?)元</td><td>(?<input2>\\d+(?:\\.\\d+)?)元</td></tr>[\\s\\S]*?<tr><td>高峰时段</td><td>(?<output>\\d+(?:\\.\\d+)?)元</td><td>(?<output2>\\d+(?:\\.\\d+)?)元</td></tr>"
  },
  // Qwen: the model catalogue carries no prices; the billing page does. Verified 12/36, 0.8/2.7,
  // 3/12. Cache prices live in a separate table, so `cached` is left untouched by an update.
  "千问 Qwen": {
    url: "https://help.aliyun.com/zh/model-studio/billing-for-model-studio",
    currency: "CNY",
    regex:
      "<p>(?<model>qwen3\\.8-[a-z0-9-]+)</p>[\\s\\S]{0,1200}?<p>(?<input>[\\d.]+)<span class=\"help-letter-space\"></span>元</p>[\\s\\S]{0,260}?<p>(?<output>[\\d.]+)<span class=\"help-letter-space\"></span>元</p>"
  },
  // Kimi: a JS `rows:` array — model, then input / output / cache-read, in ¥ per MTok. Verified
  // 13/68/1.30, 26/136/1.30, 20/100/2.00.
  Kimi: {
    url: "https://platform.moonshot.cn/docs/pricing",
    currency: "CNY",
    regex:
      "children:`(?<model>kimi-k[0-9.]+[a-z-]*)`\\}\\),`¥(?<input>[\\d.]+) / MTok`,`¥(?<output>[\\d.]+) / MTok`,`¥(?<cached>[\\d.]+) / MTok`"
  },
  // 智谱 stays on its own page on purpose: OpenRouter's `z-ai/glm-5.3` quotes 0.08 USD/M while the
  // official standard rate is 8 CNY/M (~1.1 USD) — a different tier, so switching would understate
  // cost by ~14×. Needs a 智谱 JSON source, not OpenRouter.
  "智谱 GLM": flatSource("https://open.bigmodel.cn/pricing", "CNY", [
    "GLM-5.3",
    "GLM-5.3-Flash",
    "GLM-5.3-FlashX"
  ]),
  xAI: { url: OPENROUTER_MODELS, currency: "USD", regex: "", openrouter: "x-ai" },
  // MiniMax: a plain HTML table — model, input, output, cache-read (元/百万). Verified for
  // M3.1-Flash (1/4/0.10); M3's tiered rows carry a <del> list price and may need a tweak.
  MiniMax: {
    url: "https://platform.minimaxi.com/document/price",
    currency: "CNY",
    regex:
      "(?<model>MiniMax-[^<]+)</strong></td><td[^>]*>(?:<del>[^<]*</del>\\s*)?(?<input>[\\d.]+)</td><td[^>]*>(?:<del>[^<]*</del>\\s*)?(?<output>[\\d.]+)</td><td[^>]*>(?:<del>[^<]*</del>\\s*)?(?<cached>[\\d.]+)</td>"
  },
  "小米 MiMo": flatSource("https://platform.xiaomi.com/mimo/pricing", "CNY", [
    "mimo-v2.6-pro",
    "mimo-v2.6-flash",
    "mimo-v2.6-pro-ultraspeed"
  ])
}

export const usePriceStore = create<PriceState>()(
  persist(
    (set) => ({
      prices: DEFAULT_PRICES,
      usdToCny: DEFAULT_USD_TO_CNY,
      utcOffset: DEFAULT_UTC_OFFSET,
      vendorSources: DEFAULT_VENDOR_SOURCES,
      updatedAt: null,
      setPrices: (prices) => set({ prices, updatedAt: new Date().toISOString() }),
      setUsdToCny: (usdToCny) => set({ usdToCny: Number.isFinite(usdToCny) && usdToCny > 0 ? usdToCny : DEFAULT_USD_TO_CNY }),
      setUtcOffset: (utcOffset) => set({ utcOffset: Number.isFinite(utcOffset) ? utcOffset : DEFAULT_UTC_OFFSET }),
      setVendorSource: (vendor, patch) =>
        set((state) => {
          const current = state.vendorSources[vendor] ?? { url: "", regex: "", currency: looksCny(vendor) ? "CNY" : "USD" }
          return { vendorSources: { ...state.vendorSources, [vendor]: { ...current, ...patch } } }
        }),
      resetPrices: () =>
        set({ prices: DEFAULT_PRICES, usdToCny: DEFAULT_USD_TO_CNY, utcOffset: DEFAULT_UTC_OFFSET, updatedAt: null })
    }),
    {
      name: "alwith-settings-prices",
      version: 4,
      migrate: (persisted) => {
        const state = (persisted ?? {}) as Partial<PriceState>
        // v4 keeps the user's edited table and rate/timezone; it only adds the per-vendor
        // fetch sources (and drops the retired single top-level update-URL). Earlier migrations
        // already swapped in the hand-checked 25-model snapshot, so don't reset prices again.
        return {
          ...state,
          prices: state.prices ?? DEFAULT_PRICES,
          usdToCny: state.usdToCny ?? DEFAULT_USD_TO_CNY,
          utcOffset: state.utcOffset ?? DEFAULT_UTC_OFFSET,
          vendorSources: state.vendorSources ?? DEFAULT_VENDOR_SOURCES,
          updatedAt: state.updatedAt ?? null
        } as PriceState
      }
    }
  )
)

/** Case-insensitive match; a configured `vendor/model` also matches the bare model name. */
export function matchesModel(price: ModelPrice, model: string): boolean {
  const configured = price.model.trim().toLowerCase()
  const actual = model.trim().toLowerCase()
  if (configured === "" || actual === "") return false
  if (configured === actual) return true
  const bare = configured.includes("/") ? configured.split("/").pop() ?? "" : configured
  return bare === actual
}

export function findPrice(prices: ModelPrice[], model: string): ModelPrice | undefined {
  return prices.find((price) => matchesModel(price, model))
}

function minutesOf(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 24 || minutes > 59) return null
  return (hours % 24) * 60 + minutes
}

/** "09:00-12:00,14:00-18:00" → [[540,720],[840,1080]]. Bad pairs are ignored. */
export function parseWindows(value: string): Array<[number, number]> {
  return value
    .split(",")
    .map((part) => {
      const [start, end] = part.split("-")
      const from = minutesOf(start ?? "")
      const to = minutesOf(end ?? "")
      return from === null || to === null ? null : ([from, to] as [number, number])
    })
    .filter((window): window is [number, number] => window !== null)
}

function withinWindow(minute: number, [start, end]: [number, number]): boolean {
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end
}

/** Local wall-clock hour and weekday for a UTC (date, hour) bucket. */
export function localClock(date: string, hour: number, utcOffset: number): { hour: number; weekday: number } {
  const stamp = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(stamp)) return { hour, weekday: 1 }
  const shifted = new Date(stamp + (hour + utcOffset) * 3_600_000)
  return { hour: shifted.getUTCHours(), weekday: shifted.getUTCDay() }
}

/** Whether a bucket falls inside the model's peak windows. Empty windows mean "always peak". */
export function isPeak(date: string, hour: number, price: ModelPrice, utcOffset: number): boolean {
  const windows = parseWindows(price.peakWindows)
  if (windows.length === 0) return true
  const clock = localClock(date, hour, utcOffset)
  if (price.weekdaysOnly && (clock.weekday === 0 || clock.weekday === 6)) return false
  const minute = clock.hour * 60
  return windows.some((window) => withinWindow(minute, window))
}

/**
 * Amount in CNY for one usage bucket, or `null` when the model has no price configured.
 * USD-quoted entries are converted with `usdToCny`; RMB entries are used as-is.
 */
export function costOf(
  point: { date: string; hour: number; model: string; input: number; cached: number; output: number },
  prices: ModelPrice[],
  usdToCny: number,
  utcOffset: number
): number | null {
  const price = findPrice(prices, point.model)
  if (price === undefined) return null
  const tier = price.offPeak !== null && !isPeak(point.date, point.hour, price, utcOffset) ? price.offPeak : price
  const amount =
    (point.input / 1_000_000) * tier.input +
    (point.cached / 1_000_000) * tier.cached +
    (point.output / 1_000_000) * tier.output
  return price.currency === "CNY" ? amount : amount * usdToCny
}
