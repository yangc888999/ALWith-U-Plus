/**
 * Chats created by scheduled jobs rather than typed in U.
 *
 * A `codex exec` thread is titled with its first prompt. A daily automation whose prompt file
 * starts with a Markdown heading therefore lands in the sidebar as `# 提额监控表盘每日更新任务` —
 * one row per run, all sharing the project's `cwd`, so a job that fires three times a day buries
 * the conversations the reader actually wrote. The rows are moved out of `sessionList` (the
 * sidebar list reads that array directly) into this small store, and the sidebar shows them in
 * their own collapsible section instead of mixing them into 项目.
 */
import type { SessionSummary } from "@alwith/api/client"

const listeners = new Set<() => void>()
let rows: SessionSummary[] = []

/**
 * Sessions created by *this app's* scheduler. `codex exec` runs are recognised by their `#`
 * heading, but a task launched through `client.newSession` has an ordinary title — the first
 * prompt. Without an explicit, persisted id such a run is filed under its project's cwd and
 * shows up inside 项目 instead of the automation section. Ids live in localStorage: both the
 * writer (main window's scheduler) and the reader (main window's client split) are in that same
 * webview, so no cross-window KV is needed.
 */
const ID_STORAGE_KEY = "alwith.automation.session-ids.v1"

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function readIds(): Set<string> {
  try {
    const raw = storage()?.getItem(ID_STORAGE_KEY)
    if (raw === null || raw === undefined) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [])
  } catch {
    return new Set()
  }
}

const knownIds = readIds()

export function isAutomationSessionId(sessionId: string): boolean {
  return knownIds.has(sessionId)
}

export function rememberAutomationSessionId(sessionId: string): void {
  if (knownIds.has(sessionId)) return
  knownIds.add(sessionId)
  try {
    storage()?.setItem(ID_STORAGE_KEY, JSON.stringify([...knownIds]))
  } catch {
    // A full/quota-blocked localStorage must not break the task itself.
  }
  emit()
}

/** Markdown heading at the start of the thread title, e.g. `# 提额监控表盘每日更新任务`. */
const HEADING = /^\s{0,3}#{1,6}\s+(\S.*)$/

/** The title with its leading heading marker removed, or null when it is not an automation run. */
export function automationTitleOf(title: string | null): string | null {
  if (title === null) return null
  const firstLine = title.split("\n", 1)[0] ?? ""
  const match = HEADING.exec(firstLine)
  const cleaned = match?.[1]?.trim() ?? ""
  return cleaned === "" ? null : cleaned
}

export function automationSessionRows(): SessionSummary[] {
  return rows
}

export function subscribeAutomationSessionRows(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(): void {
  for (const listener of listeners) listener()
}

/** Replaces the whole set: the list is rebuilt from a fresh fetch, not appended to. */
export function replaceAutomationSessionRows(next: SessionSummary[]): void {
  rows = [...next].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
  emit()
}

/** Adds or refreshes one row — a run that finished while the app was open. */
export function rememberAutomationSessionRow(row: SessionSummary): void {
  const next = [row, ...rows.filter((entry) => entry.sessionId !== row.sessionId)]
  rows = next.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
  emit()
}
