import { isQuickChatDirectory } from "@alwith/module-chat/session-list"

import { commands } from "@/bindings"

/**
 * Whether a directory belongs to a temporary chat.
 *
 * `isQuickChatDirectory` from the chat module matches the quick-chat folder itself, but a chat now
 * owns a subfolder (`<quick-chat>/Chat/<stamp>`) so its memory and output can be removed along with
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

/** Synchronous because it runs during render; the root is primed at startup. */
export function isTemporaryChatDir(cwd: string | null | undefined): boolean {
  if (cwd === null || cwd === undefined || cwd === "") return true
  if (root !== null) {
    const normalized = cwd.replace(/\/+$/, "")
    const base = root.replace(/\/+$/, "")
    if (normalized === base || normalized.startsWith(`${base}/`)) return true
  }
  return isQuickChatDirectory(cwd)
}

/** `2026-11-08 22-54-03` — sortable, filesystem-safe, and readable in a folder list. */
export function chatStamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

/** Creates this chat's own folder and returns its path. */
export async function createChatDirectory(): Promise<string> {
  const directory = await commands.newChatDirectory({ stamp: chatStamp() })
  if (root === null) await primeQuickChatRoot()
  return directory
}
