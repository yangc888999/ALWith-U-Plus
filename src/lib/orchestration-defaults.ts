/**
 * The planner/worker pair a conversation starts from when 分工 is switched on.
 *
 * This is the settings-level default; a conversation may still change either role in its own
 * 分工 menu. Kept in the same storage family as the other chat preferences so the choice survives
 * restarts and both windows read the same value.
 */
export interface OrchestrationRoleDefault {
  model: string
  /** Explicit effort, or null to follow the model's own catalog default. */
  effort: string | null
  /** GPT acceleration for this role; ignored by models without a `fast-mode` config. */
  fastMode?: boolean
}

export interface OrchestrationDefaults {
  planner: OrchestrationRoleDefault
  worker: OrchestrationRoleDefault
}

const STORAGE_KEY = "alwith:orchestration-defaults"
const listeners = new Set<() => void>()
let cache: OrchestrationDefaults | null | undefined

function readRole(value: unknown): OrchestrationRoleDefault | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const role = value as { model?: unknown; effort?: unknown; fastMode?: unknown }
  if (typeof role.model !== "string" || role.model === "") return null
  if (role.effort !== null && typeof role.effort !== "string") return null
  if (role.fastMode !== undefined && typeof role.fastMode !== "boolean") return null
  return {
    model: role.model,
    effort: role.effort ?? null,
    ...(role.fastMode === true ? { fastMode: true } : {})
  }
}

function readEntry(value: unknown): OrchestrationDefaults | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const entry = value as { planner?: unknown; worker?: unknown }
  const planner = readRole(entry.planner)
  const worker = readRole(entry.worker)
  return planner === null || worker === null ? null : { planner, worker }
}

function read(): OrchestrationDefaults | null {
  if (cache !== undefined) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    cache = raw === null ? null : readEntry(JSON.parse(raw) as unknown)
  } catch {
    // A corrupt store must not block a conversation; the built-in pair simply applies.
    cache = null
  }
  return cache
}

function sameDefaults(left: OrchestrationDefaults | null, right: OrchestrationDefaults | null): boolean {
  if (left === null || right === null) return left === right
  return (
    left.planner.model === right.planner.model &&
    left.planner.effort === right.planner.effort &&
    (left.planner.fastMode === true) === (right.planner.fastMode === true) &&
    left.worker.model === right.worker.model &&
    left.worker.effort === right.worker.effort &&
    (left.worker.fastMode === true) === (right.worker.fastMode === true)
  )
}

function write(next: OrchestrationDefaults | null): void {
  // Read first: clearing must also work before any consumer has taken a snapshot.
  if (sameDefaults(read(), next)) return
  cache = next
  try {
    if (next === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage can be unavailable; the in-memory value still works for this launch.
  }
  for (const listener of listeners) listener()
}

/** The configured split defaults, or null when the built-in planner/worker pair applies. */
export function orchestrationDefaultsSnapshot(): OrchestrationDefaults | null {
  return read()
}

/** Sets or clears the split defaults. Clearing restores the built-in pair. */
export function setOrchestrationDefaults(value: OrchestrationDefaults | null): void {
  if (value === null) {
    write(null)
    return
  }
  const entry = readEntry(value)
  if (entry === null) throw new Error("Invalid orchestration defaults")
  write(entry)
}

export function subscribeOrchestrationDefaults(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
