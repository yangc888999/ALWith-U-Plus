// New-free-model watch for OpenRouter.
//
// OpenRouter's `/api/v1/models` is public (no API key needed) and lists every model with its id;
// the free ones carry a `:free` suffix. Instead of adding a Rust command, this reuses the generic
// `fetch_text` command already used by the usage page's price refresh.
//
// Only *newly appeared* ids trigger a notification. The first successful check stores a baseline
// and stays silent — otherwise enabling the switch would fire one notification with every free
// model already on the platform. Polling runs in the main window, so it lives as long as the app
// is open (the Settings window does not have to stay open).

import { commands } from "@/bindings"
import i18n from "@/lib/i18n"
import { notifyConversation, notifyFreeModels } from "@/lib/notify"
import { settingsStore } from "@/lib/settings-store"

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"

export const FREE_MODEL_WATCH_SETTING = "providers.freeModelWatch"
const KNOWN_KEY = "alwith:free-model-watch/known"
// One hour on average, with a random jitter so several copies of the app (or a restart inside
// the same hour) do not all hammer the catalog at the same second. The jitter is bounded: a
// 59-65 minute cycle still reads as "about an hour", and a user who opens the app at a random
// minute should not wait 90 minutes for the first check.
const CHECK_INTERVAL_MS = 60 * 60_000
const CHECK_JITTER_MS = 6 * 60_000
const FIRST_CHECK_MS = 60_000
const RETRY_MS = 5 * 60_000
const MAX_KNOWN = 2000

export function isFreeModelId(id: string): boolean {
  return id.trim().toLowerCase().endsWith(":free")
}

/** Throws on a non-catalog response so the caller backs off instead of recording an empty baseline. */
export function parseFreeModelIds(text: string): string[] {
  const parsed: unknown = JSON.parse(text)
  const rows =
    typeof parsed === "object" && parsed !== null && "data" in parsed
      ? (parsed as { data: unknown }).data
      : undefined
  if (!Array.isArray(rows)) throw new Error("OpenRouter model catalog has no data array")
  const ids = new Set<string>()
  for (const row of rows) {
    if (typeof row !== "object" || row === null || !("id" in row)) continue
    const id = (row as { id: unknown }).id
    if (typeof id === "string" && isFreeModelId(id)) ids.add(id)
  }
  if (ids.size === 0) throw new Error("OpenRouter model catalog has no free models")
  return [...ids].sort()
}

export function newFreeModels(known: readonly string[], current: readonly string[]): string[] {
  const seen = new Set(known)
  return current.filter((id) => !seen.has(id))
}

function readKnown(store: Pick<Storage, "getItem" | "setItem">): string[] | null {
  try {
    const raw = store.getItem(KNOWN_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) return null
    return parsed as string[]
  } catch {
    return null
  }
}

function writeKnown(ids: readonly string[], store: Pick<Storage, "getItem" | "setItem">): void {
  try {
    store.setItem(KNOWN_KEY, JSON.stringify(ids.slice(-MAX_KNOWN)))
  } catch {
    // Storage is best effort; a failed write only means the next start re-baselines.
  }
}

/** Language-neutral on purpose: this string is a notification body, shown even before i18n loads. */
export function formatNewFreeModels(ids: readonly string[]): string {
  const preview = ids.slice(0, 3).join("、")
  return ids.length > 3 ? `${preview} … +${ids.length - 3}` : preview
}

export function notifyNewFreeModels(ids: readonly string[]): void {
  if (ids.length === 0) return
  const title = i18n.t("provider.freeWatchNotifyTitle", { count: ids.length })
  const body = i18n.t("provider.freeWatchNotifyBody", { models: formatNewFreeModels(ids) })
  // The OS notification is a background surface; the toast makes the same event visible to someone
  // sitting in another window. Voice was intentionally removed.
  void notifyConversation(title, body)
  notifyFreeModels(title, body)
}

export type FreeModelCheckOptions = {
  fetcher?: () => Promise<string>
  onNew?: (ids: string[]) => void
  storage?: Pick<Storage, "getItem" | "setItem">
}

/** One check. Returns the ids that appeared since the previous check (empty for the baseline). */
export async function checkFreeModels(options: FreeModelCheckOptions = {}): Promise<string[]> {
  const fetcher = options.fetcher ?? (() => commands.fetchText({ url: OPENROUTER_MODELS_URL }))
  const current = parseFreeModelIds(await fetcher())
  const store = options.storage ?? localStorage
  const known = readKnown(store)
  writeKnown(current, store)
  const fresh = known === null ? [] : newFreeModels(known, current)
  if (fresh.length > 0) {
    if (options.onNew) options.onNew(fresh)
    else notifyNewFreeModels(fresh)
  }
  return fresh
}

/** Main-window scheduler. Only active while the persisted switch is on. */
export function startFreeModelWatch(): () => void {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let checking = false
  let failures = 0
  const enabled = (): boolean => settingsStore.get<boolean>(FREE_MODEL_WATCH_SETTING) === true

  const nextInterval = (): number => CHECK_INTERVAL_MS + Math.floor(Math.random() * CHECK_JITTER_MS)

  const schedule = (delay: number): void => {
    if (disposed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!enabled() || checking) {
        schedule(nextInterval())
        return
      }
      checking = true
      void checkFreeModels()
        .then(() => {
          failures = 0
        })
        .catch(() => {
          failures += 1
        })
        .finally(() => {
          checking = false
          schedule(failures === 0 ? nextInterval() : Math.min(RETRY_MS * 2 ** Math.min(failures, 3), CHECK_INTERVAL_MS))
        })
    }, delay)
  }

  const stopSettings = settingsStore.subscribe((keys) => {
    if (!keys.includes(FREE_MODEL_WATCH_SETTING)) return
    if (enabled()) schedule(FIRST_CHECK_MS)
    else if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  })
  if (enabled()) schedule(FIRST_CHECK_MS)

  return () => {
    disposed = true
    if (timer !== null) clearTimeout(timer)
    stopSettings()
  }
}
