// Automatic price refresh for the usage page.
//
// The per-vendor「更新」button already knows how to fetch a source and parse it; what was missing
// is everything around the click: a schedule, a shared fetch (five vendors read the same
// OpenRouter catalog — one request, not five), cross-vendor price propagation (the same model id
// is the same price no matter which gateway serves it), and a path for models that appear in the
// ledger but are not in the table yet.
//
// Design rules, in the order they matter:
// 1. Never wipe: a source that fails or parses to zero rows leaves that vendor's rows untouched.
// 2. Never zero: a field the page does not publish keeps its current value.
// 3. The reader's edits win: a row with a manual label/discount keeps them; only the three tier
//    numbers and the currency move.
// 4. One catalog fetch per run: OpenRouter-backed vendors share the response text.
// 5. Same id → same price: after a vendor refresh, its new numbers propagate to every other
//    vendor's row with the same folded model id (aggregator rows keep their own routing price
//    only when the id is a full `vendor/model` that no official row matches).
import { commands } from "@/bindings"

import {
  blankPrice,
  canonicalVendor,
  customModelVendor,
  displayModelName,
  guessVendor,
  modelPriceKey,
  parseOpenRouterPrices,
  parseVendorPrices,
  usePriceStore,
  type ModelPrice
} from "./price-store"

/** One refresh pass is cheap but not free; six hours keeps prices current without hammering. */
export const PRICE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
const LAST_RUN_KEY = "alwith:price-refresh/last-run"

export type VendorRefreshOutcome = {
  vendor: string
  status: "ok" | "error"
  updated: number
  /** Models the source publishes that the table does not track yet. */
  discovered: string[]
  error?: string
}

export type PriceRefreshResult = {
  outcomes: VendorRefreshOutcome[]
  /** Rows added for models that appear in the ledger but had no price row. */
  added: string[]
  /** Rows whose numbers were copied from the same model id under another vendor. */
  propagated: number
}

type FetchText = (url: string) => Promise<string>

/**
 * Refresh every configured vendor source once. `fetchText` is injectable for tests; production
 * reads through the Rust fetcher (browser UA, TLS fallback) the manual button already uses.
 */
export async function refreshAllVendorPrices(
  fetchText: FetchText = (url) => commands.fetchText({ url })
): Promise<PriceRefreshResult> {
  const state = usePriceStore.getState()
  const sources = state.vendorSources
  let prices = state.prices
  const outcomes: VendorRefreshOutcome[] = []
  // One response per URL: the OpenRouter catalog backs five vendors at once.
  const cache = new Map<string, Promise<string>>()
  const textOf = (url: string): Promise<string> => {
    const hit = cache.get(url)
    if (hit !== undefined) return hit
    const task = fetchText(url)
    cache.set(url, task)
    return task
  }

  for (const [vendor, source] of Object.entries(sources)) {
    if (source.url.trim() === "") continue
    try {
      const text = await textOf(source.url.trim())
      const parsed =
        source.openrouter === undefined
          ? parseVendorPrices(text, source.regex)
          : parseOpenRouterPrices(text, source.openrouter)
      const byModel = new Map(parsed.map((row) => [modelPriceKey(row.model), row]))
      const existing = prices.filter((price) => price.vendor === vendor)
      let updated = 0
      if (existing.length === 0) {
        // A brand-new vendor takes the whole parsed list.
        const added = parsed.map((row) => ({
          ...blankPrice(vendor),
          model: row.model,
          currency: source.currency,
          free: row.model.toLowerCase().endsWith(":free"),
          input: row.input ?? 0,
          cached: row.cached ?? 0,
          output: row.output ?? 0
        }))
        prices = [...prices, ...added]
        updated = added.length
      } else {
        prices = prices.map((price) => {
          if (price.vendor !== vendor) return price
          const hit = byModel.get(modelPriceKey(price.model))
          if (hit === undefined) return price
          updated += 1
          return {
            ...price,
            currency: source.currency,
            input: hit.input ?? price.input,
            cached: hit.cached ?? price.cached,
            output: hit.output ?? price.output
          }
        })
      }
      const tracked = new Set(prices.filter((price) => price.vendor === vendor).map((price) => modelPriceKey(price.model)))
      const discovered = parsed.filter((row) => !tracked.has(modelPriceKey(row.model))).map((row) => row.model)
      outcomes.push({ vendor, status: "ok", updated, discovered })
    } catch (error) {
      outcomes.push({
        vendor,
        status: "error",
        updated: 0,
        discovered: [],
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const propagated = propagateSharedPrices(prices)
  usePriceStore.getState().setPrices(prices)
  return { outcomes, added: [], propagated }
}

/**
 * The same model id is the same price, whichever gateway serves it. After the per-vendor pass,
 * copy the freshest official numbers onto every other row with the same folded id.
 *
 * "Official" = a bare id under a non-aggregator vendor. A full `vendor/model` id (the OpenRouter
 * group) is a routing quote, not the vendor's list price, so it never overwrites an official row;
 * it only receives numbers when no official row exists for that id.
 */
export function propagateSharedPrices(prices: ModelPrice[]): number {
  const official = new Map<string, ModelPrice>()
  for (const price of prices) {
    if (price.model.includes("/")) continue
    const key = modelPriceKey(price.model)
    if (key === "") continue
    if (!(price.input > 0 || price.cached > 0 || price.output > 0)) continue
    // First official row wins; the curated table lists each id once.
    if (!official.has(key)) official.set(key, price)
  }
  let changed = 0
  for (let i = 0; i < prices.length; i += 1) {
    const price = prices[i]
    const bare = modelPriceKey(price.model.includes("/") ? price.model.split("/").pop() ?? "" : price.model)
    const source = official.get(bare)
    if (source === undefined || source === price) continue
    // An aggregator row keeps its own routing price when it already has one — the whole point of
    // the OpenRouter group is that its quote can differ from the vendor's list price.
    if (price.model.includes("/") && (price.input > 0 || price.output > 0)) continue
    const nonWorkdays = price.nonWorkdays?.trim() === "" ? source.nonWorkdays : price.nonWorkdays
    if (
      price.input === source.input &&
      price.cached === source.cached &&
      price.output === source.output &&
      price.currency === source.currency &&
      price.nonWorkdays === nonWorkdays
    )
      continue
    prices[i] = {
      ...price,
      input: source.input,
      cached: source.cached,
      output: source.output,
      currency: source.currency,
      nonWorkdays
    }
    changed += 1
  }
  return changed
}

/**
 * Models that appear in the ledger but have no price row: classify each by the configured
 * provider catalog first (the gateway that served it knows its vendor), then by the id's own
 * shape, and add a row so the next refresh pass can fill its numbers.
 */
export function addUnpricedModels(
  usedModels: Iterable<string>,
  vendorForModel: ReadonlyMap<string, string>
): string[] {
  const state = usePriceStore.getState()
  // Track both shapes: a bare ledger id is already priced when a full `vendor/model` row covers
  // it (matchesModel folds the same way), and vice versa.
  const tracked = new Set<string>()
  for (const price of state.prices) {
    tracked.add(modelPriceKey(price.model))
    if (price.model.includes("/")) tracked.add(modelPriceKey(price.model.split("/").pop() ?? ""))
  }
  const added: string[] = []
  let prices = state.prices
  for (const model of usedModels) {
    const key = modelPriceKey(model)
    if (key === "" || tracked.has(key)) continue
    const bare = model.includes("/") ? modelPriceKey(model.split("/").pop() ?? "") : key
    if (tracked.has(bare)) continue
    // The provider catalog's group name ("Qwen") folds onto the price table's vendor group
    // ("千问 Qwen") so the new row lands in the card that already has a price source.
    const vendor = customModelVendor(model) ?? canonicalVendor(vendorForModel.get(key) ?? guessVendor(model))
    const normalizedModel = displayModelName(model)
    prices = [...prices, { ...blankPrice(vendor), model: normalizedModel, free: model.toLowerCase().endsWith(":free") }]
    tracked.add(key)
    added.push(normalizedModel)
  }
  if (added.length > 0) usePriceStore.getState().setPrices(prices)
  return added
}

type RefreshOptions = {
  storage?: Pick<Storage, "getItem" | "setItem">
  now?: () => number
  fetchText?: FetchText
  /** Skip the interval gate (the manual "refresh everything" path). */
  force?: boolean
}

/**
 * The scheduled pass: at most one run per interval, deduplicated across windows by localStorage.
 * Failures are silent by design — the page shows per-vendor state when the reader opens it, and
 * a background refresh must never toast over whatever the reader is doing.
 */
export async function refreshPricesIfDue(options: RefreshOptions = {}): Promise<PriceRefreshResult | null> {
  const storage = options.storage ?? localStorage
  const now = (options.now ?? Date.now)()
  if (options.force !== true) {
    const last = Number(storage.getItem(LAST_RUN_KEY) ?? "0")
    if (Number.isFinite(last) && now - last < PRICE_REFRESH_INTERVAL_MS) return null
  }
  storage.setItem(LAST_RUN_KEY, String(now))
  return refreshAllVendorPrices(options.fetchText)
}

/** Mount once in the app shell: refresh on start when due, then every interval while running. */
export function startPriceRefresh(): () => void {
  const run = (): void => {
    void refreshPricesIfDue().catch(() => undefined)
  }
  run()
  const timer = window.setInterval(run, PRICE_REFRESH_INTERVAL_MS)
  const onVisible = (): void => {
    if (document.visibilityState === "visible") run()
  }
  document.addEventListener("visibilitychange", onVisible)
  return () => {
    window.clearInterval(timer)
    document.removeEventListener("visibilitychange", onVisible)
  }
}
