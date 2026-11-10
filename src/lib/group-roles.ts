/**
 * Role definitions for groups.
 *
 * A role is a name, a model, and the instructions that make that model behave like that role.
 * The instructions come from one of three places, all of them plain text the user owns:
 * text written in the settings, a markdown file on disk, or one of the Codex skills.
 */

/** Where a role's persona comes from: written in the settings, or a markdown file the user owns. */
export type RolePersona = { kind: "inline"; text: string } | { kind: "file"; path: string }

export interface GroupRole {
  id: string
  /** What the role is called in the discussion ("架构师"). */
  name: string
  /** The model this role speaks with. */
  model: string
  /** Explicit effort, or null to let the model decide. */
  effort: string | null
  /** GPT acceleration, for the models that publish a fast mode. */
  fastMode?: boolean
  /** The persona: what this role is responsible for and how it looks at a problem. */
  persona: RolePersona
  /** A Codex skill appended after the persona, or null for none. */
  skill: string | null
  /** The role closes the discussion with one agreed plan instead of adding another opinion. */
  moderator: boolean
}

const STORAGE_KEY = "alwith:group-roles"
const listeners = new Set<() => void>()

function readPersona(value: unknown): RolePersona | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const persona = value as { kind?: unknown; text?: unknown; path?: unknown }
  if (persona.kind === "inline" && typeof persona.text === "string") {
    return { kind: "inline", text: persona.text }
  }
  if (persona.kind === "file" && typeof persona.path === "string" && persona.path !== "") {
    return { kind: "file", path: persona.path }
  }
  return null
}

/**
 * The shape a role had before the persona/skill split: one definition that was text, a file, or a
 * skill. A stored role must never be dropped by a rename of its own fields.
 */
function readLegacyDefinition(value: unknown): { persona: RolePersona; skill: string | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const definition = value as { kind?: unknown; text?: unknown; path?: unknown; id?: unknown }
  if (definition.kind === "inline" && typeof definition.text === "string")
    return { persona: { kind: "inline", text: definition.text }, skill: null }
  if (definition.kind === "file" && typeof definition.path === "string" && definition.path !== "")
    return { persona: { kind: "file", path: definition.path }, skill: null }
  if (definition.kind === "skill" && typeof definition.id === "string" && definition.id !== "")
    return { persona: { kind: "inline", text: "" }, skill: definition.id }
  return null
}

function readRole(value: unknown): GroupRole | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const role = value as Partial<GroupRole> & { definition?: unknown }
  if (typeof role.id !== "string" || role.id === "") return null
  // Same rename hazard as groups: an empty name is the field mid-edit, not a broken role.
  if (typeof role.name !== "string") return null
  if (typeof role.model !== "string" || role.model === "") return null
  const persona = readPersona(role.persona)
  const legacy = persona === null ? readLegacyDefinition(role.definition) : null
  const resolved = persona ?? legacy?.persona ?? { kind: "inline" as const, text: "" }
  const skill =
    typeof role.skill === "string" && role.skill !== "" ? role.skill : (legacy?.skill ?? null)
  return {
    id: role.id,
    name: role.name,
    model: role.model,
    effort: typeof role.effort === "string" ? role.effort : null,
    ...(role.fastMode === true ? { fastMode: true } : {}),
    persona: migratePersona(resolved),
    skill,
    moderator: role.moderator === true
  }
}

/**
 * The parsed list, kept in step with the stored string.
 *
 * The list feeds `useSyncExternalStore`, which compares snapshots by identity — re-parsing on every
 * call handed React a new array each render and looped (React #185). Parsing only when the stored
 * string changed keeps the reference stable while still seeing the other window's writes.
 */
let cached: GroupRole[] = []
let cachedRaw: string | null = null

function storedRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function parse(raw: string | null): GroupRole[] {
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as unknown[]
    const roles: GroupRole[] = []
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const role = readRole(entry)
        if (role !== null) roles.push(role)
      }
    }
    return roles
  } catch {
    return []
  }
}

function readAll(): GroupRole[] {
  const raw = storedRaw()
  if (raw === cachedRaw) return cached
  cachedRaw = raw
  cached = parse(raw)
  return cached
}

function writeAll(next: GroupRole[]): void {
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

/**
 * The roster this app ships with: the operator personas, one folder and one main `skill-*.md` each.
 *
 * Seeded once, the first time the group section is opened. Deleting a role is respected — the
 * default never comes back on its own; the explicit "restore" action re-adds what is missing
 * without clearing the roles the user kept.
 */
const DEFAULT_ROLES: ReadonlyArray<Omit<GroupRole, "id" | "persona" | "skill"> & { bot: string }> = [
  // No roles ship any more: the user asked for the built-in personas to be gone. A fresh install
  // starts with an empty roster, and the three that used to be seeded are retired below.
]

/** Bots that used to ship by default. Their seeded roles are removed the next time the page loads. */
const RETIRED_DEFAULT_IDS = new Set([
  "role-default-leo",
  "role-default-wee",
  "role-default-joey",
  "role-default-liz",
  "role-default-meryl",
  // The last three bundled personas: removed on the next page load, and not seeded again.
  "role-default-elsa",
  "role-default-matt",
  "role-default-donny"
])

function dropRetiredDefaults(): GroupRole[] {
  const current = readAll()
  const kept = current.filter((role) => !RETIRED_DEFAULT_IDS.has(role.id))
  if (kept.length !== current.length) writeAll(kept)
  return kept
}

/** Where the app releases the bundled personas: `$CODEX_HOME/rob_models`, next to `skills/`. */
const PERSON_SKILLS = "~/.codex/rob_models"

/** The persona path for one bot: `<root>/<bot>/skill-<bot>.md`. */
function personaPath(bot: string): string {
  return `${PERSON_SKILLS}/${bot}/skill-${bot}.md`
}

/** The bot folder a role's persona lives in, or null for a hand-written / custom path. */
export function roleBot(role: GroupRole): string | null {
  if (role.persona.kind !== "file") return null
  const prefix = `${PERSON_SKILLS}/`
  if (!role.persona.path.startsWith(prefix)) return null
  const segments = role.persona.path.slice(prefix.length).split("/")
  return segments.length >= 2 && segments[0] !== "" ? segments[0] : null
}

/**
 * Folds a bundled `skill-*.md` persona onto `<root>/<bot>/skill-<bot>.md`, whatever older layout
 * it came from (the old Skill/skills folder, or a flat rob_models root before the per-bot split).
 */
function migratePersona(persona: RolePersona): RolePersona {
  if (persona.kind !== "file") return persona
  const name = persona.path.split("/").pop() ?? ""
  const match = /^skill-([^/]+)\.md$/.exec(name)
  if (match === null) return persona
  const bot = match[1]
  const target = personaPath(bot)
  if (persona.path === target) return persona
  const legacy = persona.path.includes("/Skill/skills/") || persona.path === `${PERSON_SKILLS}/${name}`
  return legacy ? { kind: "file", path: target } : persona
}

function defaultRole(role: (typeof DEFAULT_ROLES)[number]): GroupRole {
  return {
    id: `role-default-${role.bot}`,
    name: role.name,
    model: role.model,
    effort: role.effort,
    persona: { kind: "file", path: personaPath(role.bot) },
    skill: null,
    moderator: role.moderator
  }
}

/**
 * Seeds the bundled personas on a fresh install.
 *
 * A stored key — even one holding `[]` — means the roster has been seen, so a deliberate clear is
 * respected (the user asked for these to be deletable). No key at all is a fresh install.
 */
export function ensureDefaultGroupRoles(): GroupRole[] {
  if (storedRaw() !== null) return dropRetiredDefaults()
  const seeded = DEFAULT_ROLES.map(defaultRole)
  writeAll(seeded)
  return seeded
}

/**
 * Re-adds any bundled persona that is missing, keeping every role the user already has. This is
 * the "恢复内置角色" action: it restores, it never clears.
 */
export function resetGroupRoles(): GroupRole[] {
  const current = readAll()
  const names = new Set(current.map((role) => role.name.trim().toLowerCase()))
  const ids = new Set(current.map((role) => role.id))
  const missing = DEFAULT_ROLES.map(defaultRole).filter(
    (role) => !names.has(role.name.trim().toLowerCase()) && !ids.has(role.id)
  )
  const next = [...current, ...missing]
  writeAll(next)
  return next
}

/** Every role, in the order the user arranged them. */
export function groupRoles(): GroupRole[] {
  return readAll()
}

export function groupRoleFor(id: string): GroupRole | null {
  return readAll().find((role) => role.id === id) ?? null
}

/** Adds or replaces one role and returns the stored list. */
export function setGroupRole(role: GroupRole): GroupRole[] {
  const roles = readAll()
  const index = roles.findIndex((entry) => entry.id === role.id)
  const next = index < 0 ? [...roles, role] : roles.map((entry, position) => (position === index ? role : entry))
  writeAll(next)
  return next
}

export function removeGroupRole(id: string): GroupRole[] {
  const next = readAll().filter((role) => role.id !== id)
  writeAll(next)
  return next
}

export function subscribeGroupRoles(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A stable id for a new role; the name may change afterwards. */
export function newRoleId(): string {
  return `role-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}
