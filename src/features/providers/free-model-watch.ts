// Public catalog cache only: never mutates configured providers or model selections.
import { commands } from "@/bindings"
import i18n from "@/lib/i18n"
import { notifyConversation, notifyFreeModels } from "@/lib/notify"
import { settingsStore } from "@/lib/settings-store"

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
export const FREE_MODEL_WATCH_SETTING = "providers.freeModelWatch"
const KNOWN_KEY = "alwith:free-model-watch/known"
const CACHE_KEY = "alwith:free-model-watch/cache-v1"
type Store = Pick<Storage, "getItem" | "setItem">
export type CachedFreeModel = {
  id: string
  name?: string
  context_length?: number
  pricing?: Record<string, unknown>
  [key: string]: unknown
}
type Cache = {
  rows: CachedFreeModel[]
  seen: string[]
  /** Newly discovered catalogue rows remain marked New after their notification is acknowledged. */
  newIds: string[]
  /** Notification queue; acknowledgement affects this only, never the persistent New marker. */
  pending: string[]
  successDate: string | null
}
const listeners = new Set<() => void>()
const inFlight = new WeakMap<Store, Promise<string[]>>()
const emptyCache = (): Cache => ({ rows: [], seen: [], newIds: [], pending: [], successDate: null })
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === "string")

export function isFreeModelId(id: string): boolean {
  return id.trim().toLowerCase().endsWith(":free")
}

function validZero(value: unknown): boolean {
  return (typeof value === "number" && value === 0) ||
    (typeof value === "string" && /^(?:0+(?:\.0*)?|\.0+)$/.test(value.trim()))
}

/** Missing, empty, negative, nonnumeric and partially zero prices are not free. */
function parseFreeModels(text: string): CachedFreeModel[] {
  const parsed: unknown = JSON.parse(text)
  const data = typeof parsed === "object" && parsed !== null && "data" in parsed ? parsed.data : undefined
  if (!Array.isArray(data)) throw new Error("OpenRouter model catalog has no data array")
  const rows = new Map<string, CachedFreeModel>()
  for (const row of data) {
    if (typeof row !== "object" || row === null || typeof row.id !== "string" || !row.id.trim()) continue
    const pricing = row.pricing
    const zero = pricing && typeof pricing === "object" && validZero(pricing.prompt) && validZero(pricing.completion) &&
      Object.values(pricing).every(validZero)
    if (isFreeModelId(row.id) || zero) rows.set(row.id, { ...row })
  }
  if (!rows.size) throw new Error("OpenRouter model catalog has no free models")
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function parseFreeModelIds(text: string): string[] {
  return parseFreeModels(text).map((row) => row.id)
}

export function newFreeModels(known: readonly string[], current: readonly string[]): string[] {
  const seen = new Set(known)
  return current.filter((id) => !seen.has(id))
}

function parseCache(raw: string | null, rawKnown: string | null): Cache | null {
  try {
    if (raw !== null) {
      const cache = JSON.parse(raw) as Cache
      if (Array.isArray(cache.rows) && cache.rows.every((row) => row && typeof row.id === "string") &&
          strings(cache.seen) && strings(cache.pending) && (cache.successDate === null || typeof cache.successDate === "string")) {
        return { ...cache, newIds: strings(cache.newIds) ? cache.newIds : cache.pending }
      }
    }
  } catch { /* Fall back to migrating the old baseline. */ }
  try {
    const known: unknown = JSON.parse(rawKnown ?? "null")
    if (strings(known)) return { ...emptyCache(), seen: known }
  } catch { /* A corrupt baseline must stay silent. */ }
  return null
}

/**
 * The parsed cache, kept in step with the stored strings.
 *
 * These getters feed `useSyncExternalStore`, which compares snapshots by identity: re-parsing on
 * every call handed React a fresh object and fresh arrays on every render, so the provider pane
 * never settled ("The result of getSnapshot should be cached to avoid an infinite loop", then a
 * Maximum-update-depth crash). Parsing only when the stored strings actually changed keeps the
 * references stable while still seeing the other window's writes.
 */
const memo = new WeakMap<Store, { signature: string; cache: Cache | null }>()

function stored(store: Store, key: string): string | null {
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

function readCache(store: Store): Cache | null {
  const raw = stored(store, CACHE_KEY)
  const rawKnown = stored(store, KNOWN_KEY)
  const signature = `${raw ?? "\u0000"}\u0001${rawKnown ?? "\u0000"}`
  const hit = memo.get(store)
  if (hit !== undefined && hit.signature === signature) return hit.cache
  const cache = parseCache(raw, rawKnown)
  memo.set(store, { signature, cache })
  return cache
}

function publish(): void {
  for (const listener of listeners) listener()
}

function writeCache(cache: Cache, store: Store): void {
  store.setItem(CACHE_KEY, JSON.stringify(cache))
  publish()
}

/** Shared empty snapshots: `?? []` would hand React a new array on every read and loop. */
const NO_MODELS: readonly CachedFreeModel[] = Object.freeze([])
const NO_IDS: readonly string[] = Object.freeze([])

/** Metadata from the last successful public catalog fetch; safe to render without a key. */
export function getCachedFreeModels(storage: Store = localStorage): readonly CachedFreeModel[] {
  return readCache(storage)?.rows ?? NO_MODELS
}

export function getPendingNewFreeModelIds(storage: Store = localStorage): readonly string[] {
  return readCache(storage)?.pending ?? NO_IDS
}

/** IDs retain their marker until the catalog no longer lists them. */
export function getNewFreeModelIds(storage: Store = localStorage): readonly string[] {
  return readCache(storage)?.newIds ?? NO_IDS
}

/** Call with the ids actually displayed, never merely on navigation or toast click. */
export function acknowledgeFreeModels(ids: readonly string[], storage: Store = localStorage): void {
  const cache = readCache(storage)
  if (!cache) return
  const displayed = new Set(ids)
  const pending = cache.pending.filter((id) => !displayed.has(id))
  if (pending.length !== cache.pending.length) writeCache({ ...cache, pending }, storage)
}

/** Includes updates written by the main window while Settings is already open. */
export function subscribeFreeModels(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent): void => {
    if (event.key === CACHE_KEY || event.key === null) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

export function formatNewFreeModels(ids: readonly string[]): string {
  const preview = ids.slice(0, 3).join("、")
  return ids.length > 3 ? `${preview} … +${ids.length - 3}` : preview
}

function notifyNewFreeModels(ids: readonly string[]): void {
  if (!ids.length) return
  const title = i18n.t("provider.freeWatchNotifyTitle", { count: ids.length })
  const body = i18n.t("provider.freeWatchNotifyBody", { models: formatNewFreeModels(ids) })
  void notifyConversation(title, body)
  notifyFreeModels(title, body)
}

export type FreeModelCheckOptions = {
  fetcher?: () => Promise<string>
  onNew?: (ids: string[]) => void
  storage?: Store
  now?: () => Date
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/** Startup/foreground check, deduplicated by successful local calendar date and in-flight request. */
export function checkFreeModels(options: FreeModelCheckOptions = {}): Promise<string[]> {
  const store = options.storage ?? localStorage
  const running = inFlight.get(store)
  if (running) return running
  const today = localDate((options.now ?? (() => new Date()))())
  const previous = readCache(store)
  if (previous?.successDate === today) return Promise.resolve([])
  const task = (async () => {
    const rows = parseFreeModels(await (options.fetcher ?? (() => commands.fetchText({ url: OPENROUTER_MODELS_URL })))())
    // Re-read to preserve acknowledgements made while the request was in flight.
    const cache = readCache(store) ?? previous
    const ids = rows.map((row) => row.id)
    const fresh = cache === null ? [] : newFreeModels(cache.seen, ids)
    writeCache({
      rows,
      seen: [...new Set([...(cache?.seen ?? []), ...ids])],
      newIds: [...new Set([...(cache?.newIds ?? []).filter((id) => ids.includes(id)), ...fresh])],
      pending: [...new Set([...(cache?.pending ?? []), ...fresh])],
      successDate: today
    }, store)
    if (fresh.length) {
      if (options.onNew) options.onNew(fresh)
      else if (settingsStore.get<boolean>(FREE_MODEL_WATCH_SETTING) === true) notifyNewFreeModels(fresh)
    }
    return fresh
  })()
  inFlight.set(store, task)
  void task.finally(() => inFlight.delete(store)).catch(() => undefined)
  return task
}

export function startFreeModelWatch(): () => void {
  const check = (): void => { void checkFreeModels().catch(() => undefined) }
  const onVisible = (): void => { if (document.visibilityState === "visible") check() }
  // The catalogue only needs one successful read per local calendar day, and the user wants that
  // read after the first launch of the day has settled. Wait one minute before the first check;
  // `checkFreeModels` deduplicates later launches and retries by `successDate`, so focus/online/
  // visibility can recover a failed check without turning into periodic polling. Staying open
  // past midnight does not schedule another read; the next launch is the next day's first open.
  let launched = false
  const timer = window.setTimeout(() => {
    launched = true
    check()
  }, 60_000)
  const onFocus = (): void => { if (launched) check() }
  const onOnline = (): void => { if (launched) check() }
  const onVisibleAfterLaunch = (): void => { if (launched) onVisible() }
  window.addEventListener("focus", onFocus)
  window.addEventListener("online", onOnline)
  document.addEventListener("visibilitychange", onVisibleAfterLaunch)
  return () => {
    window.clearTimeout(timer)
    window.removeEventListener("focus", onFocus)
    window.removeEventListener("online", onOnline)
    document.removeEventListener("visibilitychange", onVisibleAfterLaunch)
  }
}
