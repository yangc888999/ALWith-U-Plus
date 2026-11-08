// Project `memory.md` writes go through the native command: the project directory is outside
// the asset-protocol scope, and the file must exist even before the file tree is opened.
import type { Session } from "@alwith/api"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { info } from "@tauri-apps/plugin-log"

const MAX_FIELD = 4000

type SessionItem = Session["items"][number]
type ConversationMessage = { kind: "user" | "assistant"; content: unknown }

function isConversationMessage(item: SessionItem): item is SessionItem & ConversationMessage {
  return item.kind === "user" || item.kind === "assistant"
}

/** Creates `<root>/memory.md` when missing. Failures are non-fatal: memory is best-effort. */
export async function ensureProjectMemory(root: string | null | undefined): Promise<void> {
  if (!isTauri() || !root) return
  try {
    await invoke("project_memory_ensure", { root })
  } catch {
    // A read-only or missing project must not break chat startup.
  }
}

/** One append at a time per project, so a burst of finished turns cannot interleave writes. */
const appends = new Map<string, Promise<void>>()

/** Every writer goes through here: two independent paths appending to the same synced
 *  `memory.md` within milliseconds is what made Drive generate 冲突副本 copies. */
export async function appendProjectMemory(root: string, block: string): Promise<void> {
  if (!isTauri() || !block.trim()) return
  const previous = appends.get(root) ?? Promise.resolve()
  const next = previous
    .then(async () => {
      void info(`[project-memory] append root=${root} bytes=${block.length}`)
      try {
        await invoke("project_memory_append", { root, block })
      } catch (error) {
        void info(`[project-memory] append failed root=${root} error=${String(error)}`)
      }
    })
    .catch(() => undefined)
  appends.set(root, next)
  await next
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue
    const value = block as { type?: unknown; text?: unknown }
    if (value.type === "text" && typeof value.text === "string") parts.push(value.text)
  }
  return parts.join("\n").trim()
}

function clip(text: string): string {
  if (text.length <= MAX_FIELD) return text
  return `${text.slice(0, MAX_FIELD)}\n\n…（已截断 ${text.length - MAX_FIELD} 字）`
}

function stamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** The header line of a record: `YYYY-MM-DD HH:mm` then a title of at most this many chars. */
const TITLE_MAX = 15

/** ≤15 chars, summarizing what the turn was about. The session's own title wins; a long one is
 *  clipped, and an empty one falls back to the user's own words. */
function summarizeTitle(session: Session, user: string): string {
  const source = session.title?.trim() || user.replace(/\s+/g, " ").trim() || session.id.slice(0, 8)
  return Array.from(source).slice(0, TITLE_MAX).join("")
}

/** The final assistant message of the turn — the concluding answer, not the tool-call chatter. */
function finalReply(messages: Session["items"], lastUser: number): string {
  let best = ""
  for (let index = lastUser + 1; index < messages.length; index += 1) {
    const item = messages[index]
    if (item === undefined || item.kind !== "assistant") continue
    const text = textOf(item.content)
    if (text.length > 0) best = text
  }
  return best
}

/** Renders the last completed turn of `session` as a Markdown section, or `null` when empty. */
/** U+2063 INVISIBLE SEPARATOR — carries the turn id without printing anything. */
const INVISIBLE = "\u2063"

export function buildTurnMemoryBlock(session: Session): string | null {
  const messages = session.items.filter(isConversationMessage)
  if (messages.length === 0) return null
  let lastUser = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].kind === "user") {
      lastUser = index
      break
    }
  }
  const user = lastUser >= 0 ? textOf(messages[lastUser].content) : ""
  const reply = lastUser >= 0 ? finalReply(messages, lastUser) : ""
  if (user.length === 0 && reply.length === 0) return null
  // The entry title is the only structure a reader scans by; keep it bold (it lost the markers at
  // some point and every entry started to read as one grey paragraph).
  const parts = [`**${stamp()}  ${summarizeTitle(session, user)}**`]
  if (user.length > 0) parts.push(`用户：${clip(user)}`)
  if (reply.length > 0) parts.push(`助手：${clip(reply)}`)
  // An HTML comment makes the append idempotent: both windows (and an interrupted relaunch) can
  // hand the same turn to the writer, and the native side skips a block it already has instead of
  // duplicating it — repeated writes to a synced project are what produced conflict copies.
  const last = messages.at(-1)
  // Invisible marker (U+2063) instead of an HTML comment: memory.md is opened in the editor as
  // source, where a comment line sat between every entry and read as noise. The idempotency
  // check only needs the token, and no renderer or editor shows it.
  parts.push(`${INVISIBLE}alwith-turn:${session.id}:${last?.id ?? "unknown"}${INVISIBLE}`)
  return parts.join("\n\n")
}

/** Appends a completed turn to the project's `memory.md`. */
export async function recordTurnInProjectMemory(session: Session): Promise<void> {
  const block = buildTurnMemoryBlock(session)
  if (block !== null) await appendProjectMemory(session.cwd, block)
}

/**
 * Archives the current `memory.md` verbatim into `<root>/history.md` with a timestamp and
 * dividers, right before a memory compression. Unlike the best-effort writers above, a failure
 * propagates: compressing without a saved history would destroy the only copy of the old text.
 */
export async function snapshotProjectMemory(root: string | null | undefined): Promise<void> {
  if (!isTauri() || !root) throw new Error("Compress memory requires a project directory")
  await invoke("project_memory_snapshot", { root, timestamp: stamp() })
}
