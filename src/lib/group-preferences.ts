/**
 * How a group talks, set once and applied to every new discussion.
 *
 * Two knobs, both of which used to be hard-coded: how many rounds the roster goes around, and what
 * the moderator has to hand back at the end of each round. The second one is a template rather
 * than a fixed prompt because the shape of a useful summary differs by team — 结论/待办/说明 is
 * the default, not the law.
 */
export interface GroupPreferences {
  /** Rounds a discussion runs by default (also the value a new group is created with). */
  rounds: number
  /** The moderator's per-round summary skeleton; its headings are kept verbatim. */
  summaryTemplate: string
}

export const DEFAULT_SUMMARY_TEMPLATE = `结论：
- 

待办：
- 

说明：`

const STORAGE_KEY = "alwith:group-preferences"
const DEFAULTS: GroupPreferences = { rounds: 2, summaryTemplate: DEFAULT_SUMMARY_TEMPLATE }
const listeners = new Set<() => void>()
let cached: GroupPreferences | null = null

function clampRounds(value: unknown): number {
  const rounds = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULTS.rounds
  return Math.max(1, Math.min(5, rounds))
}

function read(): GroupPreferences {
  if (cached !== null) return cached
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Partial<GroupPreferences>
    cached = {
      rounds: clampRounds(record.rounds),
      summaryTemplate:
        typeof record.summaryTemplate === "string" && record.summaryTemplate.trim() !== ""
          ? record.summaryTemplate
          : DEFAULTS.summaryTemplate
    }
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}

/** The stored pair, for readers outside React (the discussion runner, group creation). */
export function groupPreferences(): GroupPreferences {
  return read()
}

export function setGroupPreferences(patch: Partial<GroupPreferences>): void {
  const next: GroupPreferences = { ...read(), ...patch }
  next.rounds = clampRounds(next.rounds)
  if (next.summaryTemplate.trim() === "") next.summaryTemplate = DEFAULTS.summaryTemplate
  cached = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage can be unavailable; the in-memory value still applies for this launch.
  }
  for (const listener of listeners) listener()
}

export function subscribeGroupPreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
