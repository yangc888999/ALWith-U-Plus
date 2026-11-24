/**
 * Per-model GPT acceleration ("fast mode").
 *
 * The model list owns one switch per GPT model; selecting that model in a conversation applies
 * the same value. Kept beside the other chat preferences so both windows see one source of truth.
 *
 * Three states are distinct and must stay that way:
 *   * key present, `true`  — explicitly on  → the turn sends `service_tier=priority`
 *   * key present, `false` — explicitly off → the turn must send the normal-speed value rather
 *                            than omitting the field (omitting it is not the same request)
 *   * key absent           — never specified → leave the engine's own default alone
 *
 * Dropping the key on "off" collapsed the last two into one, so "I turned acceleration off" and
 * "I never touched it" produced identical requests and the explicit choice was silently lost.
 */
const STORAGE_KEY = "alwith:model-fast-mode"
const listeners = new Set<() => void>()
let cache: Record<string, boolean> | null = null

function read(): Record<string, boolean> {
  if (cache !== null) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      cache = {}
    } else {
      const entries: Record<string, boolean> = {}
      for (const [model, enabled] of Object.entries(parsed)) {
        // Both explicit values are meaningful; only non-booleans are noise.
        if (enabled === true || enabled === false) entries[model] = enabled
      }
      cache = entries
    }
  } catch {
    cache = {}
  }
  return cache
}

function write(next: Record<string, boolean>): void {
  // Read first so a write before any consumer has taken a snapshot cannot skip the diff.
  const current = read()
  const same =
    Object.keys(current).length === Object.keys(next).length &&
    Object.entries(next).every(([model, enabled]) => current[model] === enabled)
  if (same) return
  cache = next
  try {
    if (Object.keys(next).length === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage can be unavailable; the in-memory value still works for this launch.
  }
  for (const listener of listeners) listener()
}

/** True when the model was switched on in 设置 → 大模型 → 可用模型. */
export function modelFastModeFor(model: string | null | undefined): boolean {
  return model !== null && model !== undefined && read()[model] === true
}

/**
 * The stored choice, or `null` when the user never touched this model's switch.
 *
 * Callers that must send a different request for "off" than for "unspecified" read this instead of
 * `modelFastModeFor`, whose `false` conflates the two.
 */
export function modelFastModeChoiceFor(model: string | null | undefined): boolean | null {
  if (model === null || model === undefined) return null
  const value = read()[model]
  return value === true || value === false ? value : null
}

export function setModelFastMode(model: string, enabled: boolean): void {
  if (model.trim() === "") return
  const current = read()
  if (current[model] === enabled) return
  // Keep the key for BOTH explicit values: an explicit "off" is a decision the sender has to
  // honour, not an absence of one.
  write({ ...current, [model]: enabled })
}

export function subscribeModelFastMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** `useSyncExternalStore` snapshot: the record identity is stable until a switch changes. */
export function modelFastModeSnapshot(): Record<string, boolean> {
  return read()
}
