/**
 * The conversations that belong to a group.
 *
 * A group is a project of its own, so its conversations used to be listed twice: once under 项目
 * (indistinguishable from a real project folder) and once in the 群聊 panel. The sidebar list reads
 * `client.state.sessionList` directly from the vendored list, so the only place to draw the line is
 * where that list is built — the client keeps the group's rows here instead, and the panel reads
 * them from this small store.
 */
import type { SessionSummary } from "@alwith/api/client"

const listeners = new Set<() => void>()
let rows: SessionSummary[] = []

export function groupSessionRows(): SessionSummary[] {
  return rows
}

export function subscribeGroupSessionRows(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Replaces the whole set: the list is rebuilt from a fresh fetch, not appended to. */
export function replaceGroupSessionRows(next: SessionSummary[]): void {
  rows = next
  for (const listener of listeners) listener()
}

/** Adds or refreshes one row — a group conversation created or renamed while the app runs. */
export function rememberGroupSessionRow(row: SessionSummary): void {
  const next = [row, ...rows.filter((entry) => entry.sessionId !== row.sessionId)]
  rows = next
  for (const listener of listeners) listener()
}
