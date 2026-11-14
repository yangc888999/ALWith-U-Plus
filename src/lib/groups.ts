/**
 * Groups: a named set of roles that discuss one problem in one project of its own.
 *
 * A group owns a directory under `~/Documents/ALWith/groups/` and a `group.md` that every member
 * reads. The discussion itself runs in a regular conversation rooted at that directory, so the
 * group is a project like any other — its files, its memory and its transcript all live together.
 */
export interface GroupConfig {
  id: string
  name: string
  /** Role ids in speaking order. */
  roles: string[]
  /** How many times the roster goes around before the moderator closes the discussion. */
  rounds: number
  /** The group's own project directory. */
  directory: string
  /** The group's document (group.md). */
  document: string
  /** The single question the discussion answers; written into the group document. */
  topic: string
  /**
   * The analysis direction for this group — how to look at the topic, kept separate from the topic
   * itself so one folder can host several angles over time. Injected into member and summary
   * prompts when set; empty means no extra framing.
   */
  focus: string
  /**
   * Folders outside the group's own directory whose files the discussion may cite. The document
   * carries an index of them (names + sizes), not their contents — members read what they need.
   */
  materialFolders: string[]
  /** The conversation that hosts the discussion. */
  sessionId: string | null
  /** Whether a user turn starts the roster automatically. Off = the group is a plain project. */
  autoDiscuss: boolean
}

const STORAGE_KEY = "alwith:groups"
const listeners = new Set<() => void>()

function readGroup(value: unknown): GroupConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const group = value as Partial<GroupConfig>
  if (typeof group.id !== "string" || group.id === "") return null
  // An empty name is a group mid-rename, not a broken record: dropping it here made renaming a
  // group delete it (the field clears before the new name is typed).
  if (typeof group.name !== "string") return null
  // A group may exist before its directory is created: the folder is only materialised once the
  // meeting name is set, so an empty directory is valid (the panel just cannot open/start it yet).
  if (typeof group.directory !== "string") return null
  const roles = Array.isArray(group.roles)
    ? group.roles.filter((role): role is string => typeof role === "string" && role !== "")
    : []
  const rounds = typeof group.rounds === "number" && Number.isFinite(group.rounds) ? group.rounds : 1
  return {
    id: group.id,
    name: group.name,
    roles,
    rounds: Math.max(1, Math.min(5, Math.round(rounds))),
    directory: group.directory,
    document: typeof group.document === "string" ? group.document : "",
    topic: typeof group.topic === "string" ? group.topic : "",
    // v2 fields: groups written before this version simply have no direction and no material folders.
    // A whitespace-only focus is no focus at all — the prompt injection checks emptiness after trim.
    focus: typeof group.focus === "string" ? group.focus.trim() : "",
    materialFolders: Array.isArray(group.materialFolders)
      ? group.materialFolders.filter((folder): folder is string => typeof folder === "string" && folder.trim() !== "").map((folder) => folder.trim())
      : [],
    sessionId: typeof group.sessionId === "string" ? group.sessionId : null,
    // Older records predate the switch; they were written when the discussion was automatic.
    autoDiscuss: group.autoDiscuss !== false
  }
}

/**
 * The parsed list, kept in step with the stored string.
 *
 * `groups()` feeds `useSyncExternalStore`, which compares snapshots by identity: returning a freshly
 * parsed array on every call made React see a new value on every render and re-render forever —
 * React #185, caught by the error boundary as "出了问题" the moment the 群 panel opened. Parsing only
 * when the stored string actually changed keeps the reference stable and the read cheap.
 */
let cached: GroupConfig[] = []
let cachedRaw: string | null = null

function storedRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function parse(raw: string | null): GroupConfig[] {
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as unknown[]
    const groups: GroupConfig[] = []
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const group = readGroup(entry)
        if (group !== null) groups.push(group)
      }
    }
    return groups
  } catch {
    return []
  }
}

/** The stored list, re-read only when another window changed it. */
function readAll(): GroupConfig[] {
  const raw = storedRaw()
  if (raw === cachedRaw) return cached
  cachedRaw = raw
  cached = parse(raw)
  return cached
}

function writeAll(next: GroupConfig[]): void {
  const raw = JSON.stringify(next)
  try {
    localStorage.setItem(STORAGE_KEY, raw)
  } catch {
    // Storage can be unavailable; the in-memory list still works for this launch.
  }
  // Parse what was actually written: the readers clamp (rounds, unknown fields), and caching the
  // caller's objects would hand them values the stored list would never produce.
  cached = parse(raw)
  cachedRaw = raw
  for (const listener of listeners) listener()
}

export function groups(): GroupConfig[] {
  return readAll()
}

export function groupFor(id: string): GroupConfig | null {
  return readAll().find((group) => group.id === id) ?? null
}

/**
 * The group a conversation belongs to, matched by its project directory.
 *
 * The paths come from two places — the group definition and the engine's own record of where a
 * conversation lives — so they are compared the way the file system does: no trailing slash, and
 * case-insensitive on macOS.
 */
export function groupByDirectory(directory: string | null | undefined): GroupConfig | null {
  if (directory === null || directory === undefined || directory === "") return null
  const target = normalizeDirectory(directory)
  return readAll().find((group) => normalizeDirectory(group.directory) === target) ?? null
}

function normalizeDirectory(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "")
  // macOS file systems are case-insensitive by default; matching exactly would miss a group
  // whose directory was typed with a different case.
  return isMac() ? trimmed.toLowerCase() : trimmed
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent)
}

export function setGroup(group: GroupConfig): GroupConfig[] {
  const groups = readAll()
  const index = groups.findIndex((entry) => entry.id === group.id)
  const next = index < 0 ? [...groups, group] : groups.map((entry, position) => (position === index ? group : entry))
  writeAll(next)
  return next
}

export function removeGroup(id: string): GroupConfig[] {
  const next = readAll().filter((group) => group.id !== id)
  writeAll(next)
  return next
}

export function subscribeGroups(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function newGroupId(): string {
  return `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}
