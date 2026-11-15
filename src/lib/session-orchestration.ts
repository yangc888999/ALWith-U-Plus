/**
 * Per-conversation model split: an expensive planner frames the work and a cheaper worker executes.
 *
 * Kept beside the other chat preferences so a conversation keeps its pair across restarts. The
 * client reads it when a prompt is sent; the composer renders a small control from the same store.
 */

import { groupByDirectory } from "@/lib/groups"
import { isTemporaryChatDir } from "@/lib/quick-chat"

export interface SessionOrchestration {
  /** The model that only produces the plan, paired with its own effort selection. */
  planner: OrchestrationRoleConfig
  /** The model that executes the approved plan, paired with its own effort selection. */
  worker: OrchestrationRoleConfig
}

export interface OrchestrationRoleConfig {
  model: string
  /** Explicit effort, or null to resolve the selected model's own catalog default. */
  effort: string | null
  /** GPT acceleration for this role. Only models publishing `fast-mode` honour it. */
  fastMode?: boolean
}

const STORAGE_KEY = "alwith:session-orchestration"
const listeners = new Set<() => void>()
let cache: Record<string, SessionOrchestration> | null = null

function readRole(value: unknown): OrchestrationRoleConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const role = value as { model?: unknown; effort?: unknown; fastMode?: unknown }
  if (typeof role.model !== "string" || role.model === "") return null
  if (!("effort" in role)) return null
  if (role.effort !== null && typeof role.effort !== "string") return null
  if (role.fastMode !== undefined && typeof role.fastMode !== "boolean") return null
  return {
    model: role.model,
    effort: role.effort === "" ? null : role.effort,
    // Only store the flag when on: older records and the common case stay unchanged.
    ...(role.fastMode === true ? { fastMode: true } : {})
  }
}

function readEntry(value: unknown): SessionOrchestration | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const entry = value as { planner?: unknown; worker?: unknown }
  const planner = readRole(entry.planner)
  const worker = readRole(entry.worker)
  return planner === null || worker === null ? null : { planner, worker }
}

function readAll(): Record<string, SessionOrchestration> {
  if (cache !== null) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>)
    const entries: Record<string, SessionOrchestration> = {}
    for (const [sessionId, value] of Object.entries(parsed)) {
      const entry = readEntry(value)
      if (entry !== null) entries[sessionId] = entry
    }
    cache = entries
  } catch {
    cache = {}
  }
  return cache
}

function writeAll(next: Record<string, SessionOrchestration>): void {
  cache = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage can be unavailable; the in-memory value still works for this launch.
  }
  for (const listener of listeners) listener()
}

/** Returns the active pair, or null when either side is missing. */
export function orchestrationFor(sessionId: string): SessionOrchestration | null {
  return readAll()[sessionId] ?? null
}

/** Enables the split for a conversation, or clears it with null. */
export function setOrchestration(sessionId: string, value: SessionOrchestration | null): void {
  const all = { ...readAll() }
  if (value === null) delete all[sessionId]
  else {
    const entry = readEntry(value)
    if (entry === null) throw new Error("Invalid orchestration configuration")
    all[sessionId] = entry
  }
  writeAll(all)
}

export function subscribeOrchestration(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** `useSyncExternalStore` snapshot; the stored object identity is stable until it changes. */
export function orchestrationSnapshot(sessionId: string): SessionOrchestration | null {
  return orchestrationFor(sessionId)
}

/**
 * Whether a conversation may run the plan → execute split at all.
 *
 * 分工 and 拉会 are mutually exclusive (a product decision, not a preference): a group discussion
 * drives the same session by switching its model once per speaker, and the split would switch that
 * same model again per role inside the turn — two orchestrators writing one selection, with no
 * defined outcome. A quick-chat folder has no 分工 button in its composer either, so a plan started
 * there could never be approved: the "dead plan" path.
 *
 * Both classifications reuse the app's existing tests — `isTemporaryChatDir` is what the composer
 * already uses to tell a chat from a project, and `groupByDirectory` is what the sidebar, the group
 * panel and the client's own row diversion use to recognise a group. The client checks this before
 * entering the planner, which is the single source of truth; the composer only uses it to decide
 * whether to render the control.
 *
 * A stored split is never deleted here: it is the user's configuration, and ignoring it is enough
 * to keep the two flows apart.
 */
export function orchestrationAllowedFor(cwd: string | null | undefined): boolean {
  if (isTemporaryChatDir(cwd)) return false
  return groupByDirectory(cwd) === null
}
