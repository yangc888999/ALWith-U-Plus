// Public catalog cache only: never mutates configured providers or model selections.
import { commands } from "@/bindings"
import i18n from "@/lib/i18n"
import { notifyConversation, notifyFreeModels } from "@/lib/notify"
import { settingsStore } from "@/lib/settings-store"

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
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
export function parseFreeModels(text: string): CachedFreeModel[] {
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

function readCache(store: Store): Cache | null {
  try {
    const raw = store.getItem(CACHE_KEY)
    if (raw !== null) {
      const cache = JSON.parse(raw) as Cache
      if (Array.isArray(cache.rows) && cache.rows.every((row) => row && typeof row.id === "string") &&
          strings(cache.seen) && strings(cache.pending) && (cache.successDate === null || typeof cache.successDate === "string")) {
        return { ...cache, newIds: strings(cache.newIds) ? cache.newIds : cache.pending }
      }
    }
  } catch { /* Fall back to migrating the old baseline. */ }
  try {
    const known: unknown = JSON.parse(store.getItem(KNOWN_KEY) ?? "null")
    if (strings(known)) return { ...emptyCache(), seen: known }
  } catch { /* A corrupt baseline must stay silent. */ }
  return null
}

function publish(): void {
  for (const listener of listeners) listener()
}

function writeCache(cache: Cache, store: Store): void {
  store.setItem(CACHE_KEY, JSON.stringify(cache))
  publish()
}

/** Metadata from the last successful public catalog fetch; safe to render without a key. */
export function getCachedFreeModels(storage: Store = localStorage): CachedFreeModel[] {
  return readCache(storage)?.rows ?? []
}

export function getPendingNewFreeModelIds(storage: Store = localStorage): string[] {
  return readCache(storage)?.pending ?? []
}

/** IDs retain their marker until the catalog no longer lists them. */
export function getNewFreeModelIds(storage: Store = localStorage): string[] {
  return readCache(storage)?.newIds ?? []
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

export function notifyNewFreeModels(ids: readonly string[]): void {
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

/** No hourly timer: retry failed checks on the next foreground, even on the same date. */
export function startFreeModelWatch(): () => void {
  const check = (): void => { void checkFreeModels().catch(() => undefined) }
  const onVisible = (): void => { if (document.visibilityState === "visible") check() }
  window.addEventListener("focus", check)
  document.addEventListener("visibilitychange", onVisible)
  check()
  return () => {
    window.removeEventListener("focus", check)
    document.removeEventListener("visibilitychange", onVisible)
  }
}
