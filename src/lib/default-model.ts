/**
 * The model (and effort) a new conversation starts on when the user has not picked one.
 *
 * Per-chat selections still win: this is only the answer to "what should a brand-new chat use".
 * A gateway id (`gateway:<provider>:<model>`) or a native model id may be stored; `null` on either
 * side means "the built-in default". Kept beside the other chat preferences so the choice survives
 * restarts; the composer's model picker and the settings section read the same store.
 */
export interface DefaultModelChoice {
  /** Gateway or native model id, or null for the built-in default. */
  model: string | null
  /** Effort pinned for new conversations on that model, or null to follow the model's own default. */
  effort: string | null
  /**
   * GPT acceleration ("fast mode") for new conversations.
   *
   * Only models that publish a boolean `fast-mode` config honour it; the session applies it only
   * when that option is present, so a stale flag cannot break a model that lacks it.
   */
  fastMode?: boolean
}

const STORAGE_KEY = "alwith:default-model"
const listeners = new Set<() => void>()
let cache: DefaultModelChoice | null = null

function readChoice(value: unknown): DefaultModelChoice | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const entry = value as { model?: unknown; effort?: unknown; fastMode?: unknown }
  if (entry.model !== null && typeof entry.model !== "string") return null
  if (entry.effort !== null && typeof entry.effort !== "string") return null
  if (entry.fastMode !== undefined && typeof entry.fastMode !== "boolean") return null
  return {
    model: entry.model ?? null,
    effort: entry.effort ?? null,
    // Only store the flag when on: the common record keeps its original two-field shape.
    ...(entry.fastMode === true ? { fastMode: true } : {})
  }
}

function read(): DefaultModelChoice | null {
  if (cache !== null) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    cache = raw === null ? null : readChoice(JSON.parse(raw) as unknown)
  } catch {
    // A corrupt store must not block the app; the built-in default simply applies.
    cache = null
  }
  return cache
}

function sameChoice(left: DefaultModelChoice | null, right: DefaultModelChoice | null): boolean {
  if (left === null || right === null) return left === right
  return (
    left.model === right.model &&
    left.effort === right.effort &&
    (left.fastMode === true) === (right.fastMode === true)
  )
}

function write(next: DefaultModelChoice | null): void {
  // Storing the same choice again must not notify: surfaces re-save identical values often.
  if (sameChoice(cache, next)) return
  cache = next
  try {
    if (next === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage can be unavailable; the in-memory value still works for this launch.
  }
  for (const listener of listeners) listener()
}

/** The configured default, or null when the built-in default applies. */
export function defaultModelChoice(): DefaultModelChoice | null {
  return read()
}

/** Sets or clears the default. Clearing restores the built-in default. */
export function setDefaultModelChoice(value: DefaultModelChoice | null): void {
  const entry = value === null ? null : readChoice(value)
  if (value !== null && entry === null) throw new Error("Invalid default model configuration")
  write(entry)
}

export function subscribeDefaultModel(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** `useSyncExternalStore` snapshot; the stored object identity is stable until it changes. */
export function defaultModelSnapshot(): DefaultModelChoice | null {
  return read()
}
