/**
 * Sandbox policy for new conversations.
 *
 * Codex exposes four fixed presets rather than arbitrary rules, so the settings below are reduced
 * to the preset that matches them, and the per-permission switches answer the sandbox's own
 * approval requests: a permission that is switched on never interrupts the turn, one that is off
 * still asks (or stays blocked by the sandbox).
 */

/** The user-facing switches, one per capability the sandbox report lists. */
export interface SandboxSettings {
  /** Master switch. Off means conversations start without a sandbox. */
  enabled: boolean
  /** Edit files inside the conversation's workspace. */
  projectWrite: boolean
  /** Read or write files outside the workspace. */
  outsideWrite: boolean
  /** Let commands reach the network. */
  network: boolean
  /** Run local commands. */
  commands: boolean
  /** Install packages or dependencies. */
  install: boolean
  /** Let tools reach other applications and plugins. */
  apps: boolean
  /** Web search and remote browsing. */
  web: boolean
}

export const DEFAULT_SANDBOX: SandboxSettings = {
  // Off by default: conversations start unrestricted (`agent-full-access`) unless the reader
  // turns the sandbox on. A sandbox that silently wraps every new chat caused more "why did it
  // stop at the workspace boundary" confusion than it prevented.
  enabled: false,
  projectWrite: true,
  outsideWrite: false,
  network: true,
  commands: true,
  install: false,
  apps: false,
  web: true
}

const STORAGE_KEY = "alwith:sandbox"
const listeners = new Set<() => void>()
let cache: SandboxSettings | null = null

function read(): SandboxSettings {
  if (cache !== null) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw === null ? {} : (JSON.parse(raw) as Partial<SandboxSettings>)
    cache = { ...DEFAULT_SANDBOX, ...parsed }
  } catch {
    cache = { ...DEFAULT_SANDBOX }
  }
  return cache
}

export function sandboxSettings(): SandboxSettings {
  return read()
}

export function setSandboxSettings(patch: Partial<SandboxSettings>): void {
  cache = { ...read(), ...patch }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // Storage can be unavailable; the in-memory value still works for this launch.
  }
  for (const listener of listeners) listener()
}

export function subscribeSandbox(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Snapshot for `useSyncExternalStore`; the stored object identity is stable until it changes. */
export function sandboxSnapshot(): SandboxSettings {
  return read()
}

/**
 * The mode a new conversation starts in.
 *
 * With the sandbox off Codex runs unrestricted (`agent-full-access`): no approval prompts, no
 * workspace boundary. With it on, the conversation gets workspace-write, or read-only when even
 * in-workspace edits are switched off.
 */
export function sandboxMode(): "read-only" | "workspace-write" | "agent-full-access" {
  const settings = read()
  if (!settings.enabled) return "agent-full-access"
  return settings.projectWrite ? "workspace-write" : "read-only"
}

/** The capabilities an approval request asks for, as the settings name them. */
export type SandboxCapability = "projectWrite" | "outsideWrite" | "network" | "commands" | "install" | "apps" | "web"

type PermissionSubject = {
  type?: unknown
  toolCall?: {
    kind?: unknown
    title?: unknown
    input?: unknown
    locations?: Array<{ path?: unknown }>
  }
  command?: unknown
}

export interface ApprovalRequestLike {
  sessionId: string
  params: {
    title?: unknown
    description?: unknown
    subject?: unknown
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : ""
}

/**
 * Reads what an approval is for. The sandbox's additional-permission request carries the exact
 * capability in `input.permissions`; everything else is classified from the tool call's kind,
 * title and locations, which is all the protocol exposes.
 */
export function sandboxCapability(request: ApprovalRequestLike, workspace: string | null): SandboxCapability | null {
  const params = request.params
  const subject = (params.subject ?? {}) as PermissionSubject
  const body = JSON.stringify(params).toLowerCase()
  const toolCall = subject.toolCall
  const input = toolCall?.input as
    | { permissions?: { network?: { enabled?: unknown }; fileSystem?: { write?: unknown[]; read?: unknown[] } } }
    | undefined
  const permissions = input?.permissions
  if (permissions !== undefined) {
    if (permissions.network?.enabled === true) return "network"
    const writes = Array.isArray(permissions.fileSystem?.write) ? permissions.fileSystem.write : []
    if (writes.some((path) => typeof path === "string" && workspace !== null && !path.startsWith(workspace)))
      return "outsideWrite"
    if (writes.length > 0) return "projectWrite"
    return "outsideWrite"
  }
  if (subject.type === "command" || text(toolCall?.kind) === "execute") {
    return /brew install|npm install|bun add|pip install|apt(-get)? install|cargo install/.test(body)
      ? "install"
      : "commands"
  }
  if (body.includes("network") || body.includes("internet")) return "network"
  if (body.includes("web_search") || body.includes("web search") || body.includes("browser")) return "web"
  if (text(toolCall?.kind) === "other" && (body.includes("mcp") || body.includes("plugin"))) return "apps"
  const locations = Array.isArray(toolCall?.locations) ? toolCall.locations : []
  if (locations.some((entry) => typeof entry.path === "string" && workspace !== null && !entry.path.startsWith(workspace)))
    return "outsideWrite"
  if (text(toolCall?.kind) === "edit" || text(toolCall?.kind) === "delete" || text(toolCall?.kind) === "move")
    return "projectWrite"
  if (text(toolCall?.kind) === "fetch") return "web"
  return null
}

/** Whether the sandbox settings pre-approve this capability, so the request must not interrupt. */
export function sandboxGrants(settings: SandboxSettings, capability: SandboxCapability | null): boolean {
  if (!settings.enabled || capability === null) return false
  return settings[capability]
}
