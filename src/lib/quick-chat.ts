import { isQuickChatDirectory } from "@alwith/module-chat/session-list"

import { commands } from "@/bindings"

/**
 * Whether a directory belongs to a temporary chat.
 *
 * `isQuickChatDirectory` from the chat module matches the quick-chat folder itself, but a chat now
 * owns a timestamp subfolder so its memory and output can be removed along with
 * the conversation. The module's test is path-equal, so a chat inside its own folder would have been
 * classified as a project — four columns, 分工, everything.
 *
 * The root is cached on startup; until it arrives this falls back to the module's own test, which is
 * correct for the folders that existed before subfolders.
 */
let root: string | null = null

export async function primeQuickChatRoot(): Promise<void> {
  try {
    root = await commands.quickChatDirectory()
  } catch {
    root = null
  }
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

const CHAT_STAMP = /^\d{2,4}-\d{2}-\d{2}[ -]\d{2}-\d{2}-\d{2}$/

/** Synchronous because it runs during render; the root is primed at startup. */
export function isTemporaryChatDir(cwd: string | null | undefined): boolean {
  if (cwd === null || cwd === undefined || cwd === "") return true
  if (root !== null) {
    const normalized = normalizedPath(cwd)
    const base = normalizedPath(root)
    if (normalized === base) return true
  }
  // Older builds created chats below `<root>/Chat/<stamp>` and did not remember every root the
  // user may have switched away from. The exact `Chat/timestamp` shape keeps those conversations
  // classified as chats instead of turning them into projects after a settings change.
  return isQuickChatDirectory(cwd) || isChatOwnDirectory(cwd)
}

/**
 * Whether the path is a conversation's *own* timestamp folder rather than the
 * quick-chat root. Those folders belong to one conversation and are deleted with it, so the
 * workspace may locate them; the root itself never becomes a workspace.
 */
export function isChatOwnDirectory(cwd: string | null | undefined): boolean {
  if (cwd === null || cwd === undefined || cwd === "") return false
  const normalized = normalizedPath(cwd)
  if (root !== null && normalized === normalizedPath(root)) return false
  const parts = normalized.split("/")
  return parts.length >= 1 && CHAT_STAMP.test(parts.at(-1) ?? "")
}

/** `26-11-08-22-54-03` — sortable, filesystem-safe, and readable in a folder list. */
function chatStamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${String(date.getFullYear()).slice(-2)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

/** Creates this chat's own timestamp folder under the configured root. */
export async function createChatDirectory(now: Date = new Date()): Promise<string> {
  // Two clicks inside one second are possible from the new + button. The backend uses an atomic
  // create, so retry the next second instead of reusing the same folder for both conversations.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const directory = await commands.newChatDirectory({
        stamp: chatStamp(new Date(now.getTime() + attempt * 1_000))
      })
      if (root === null) await primeQuickChatRoot()
      return directory
    } catch (error: unknown) {
      if (!/已存在|already exists|AlreadyExists/i.test(String(error))) throw error
    }
  }
  throw new Error("无法创建唯一的聊天文件夹，请稍后重试")
}

/** Deletes a chat's own directory. Returns false for the shared root or a project folder. */
export async function deleteChatOwnDirectory(cwd: string | null | undefined): Promise<boolean> {
  if (root === null) await primeQuickChatRoot()
  if (!isChatOwnDirectory(cwd) || cwd === null || cwd === undefined) return false
  await commands.deleteChatDirectory({ path: cwd })
  return true
}
