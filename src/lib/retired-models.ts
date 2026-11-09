/**
 * Model ids the gateway itself refused to serve.
 *
 * 「可用模型」 is a saved list, so it outlives the catalog it was written from: the provider can
 * retire an id (`gpt-6.1-terra`), while the local row keeps offering it. Sending that id fails with
 * a wall of English alternatives, and because the rejection carries no usable shape the old code
 * treated it as an unknown failure — the switch was lost and the picker offered the same dead model
 * again on the next turn.
 *
 * This is the tombstone: when the agent says an id is not in its catalog, remember it, substitute a
 * live sibling, and keep the row out of the picker until the engine offers it again (or the entry
 * ages out, so a provider that re-adds a model is believed eventually).
 */
const STORAGE_KEY = "alwith:retired-models"

/** A provider that changes its mind should be believed again without a manual cache purge. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000

let cache: Record<string, number> = {}
/** The raw string the cache was parsed from, so clearing storage or another window's write is seen. */
let cachedRaw: string | null = null

function readAll(): Record<string, number> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    // Storage can be unavailable (private mode, tests): fall back to memory only.
    return cache
  }
  if (raw === cachedRaw) return cache
  cachedRaw = raw
  const entries: Record<string, number> = {}
  try {
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof at === "number" && Number.isFinite(at)) entries[id] = at
      }
    }
  } catch {
    // A corrupt entry must not disable the feature: an empty map just retries the model once.
  }
  cache = entries
  return cache
}

function writeAll(next: Record<string, number>): void {
  cache = next
  try {
    cachedRaw = JSON.stringify(next)
    localStorage.setItem(STORAGE_KEY, cachedRaw)
  } catch {
    // Storage can be unavailable; the in-memory tombstone still covers this launch.
    cachedRaw = null
  }
}

/** True when the agent refused this id and it has not aged out yet. */
export function isModelRetired(id: string): boolean {
  const at = readAll()[id]
  return at !== undefined && Date.now() - at < TTL_MS
}

/** Records a refusal. A repeated rejection refreshes the timestamp instead of leaving it stale. */
export function retireModel(id: string): void {
  if (id.trim() === "") return
  const all = readAll()
  const at = Date.now()
  if (all[id] !== undefined && at - all[id] < TTL_MS) {
    all[id] = at
    writeAll(all)
    return
  }
  writeAll({ ...all, [id]: at })
}

/**
 * Drops every tombstone the engine's own catalog still lists.
 *
 * The catalog — not this saved list — is the source of truth for what can run. A provider that
 * withdrew an id for an hour and put it back used to stay hidden for the whole TTL, because only
 * a successful write to that exact model revived it. One catalog refresh is enough to believe it.
 * Catalog ids are passed in by the caller: this module never guesses which list is authoritative.
 */
export function reviveCatalogModels(ids: Iterable<string>): void {
  const all = readAll()
  let rest: Record<string, number> | null = null
  for (const id of ids) {
    if (all[id] === undefined) continue
    rest ??= { ...all }
    delete rest[id]
  }
  if (rest !== null) writeAll(rest)
}

/** Drops a tombstone — used once the model is written successfully again. */
export function reviveModel(id: string): void {
  reviveCatalogModels([id])
}
