// A tiny module-level bridge so a toast (which lives at the app root, outside the component tree
// that owns the session navigator) can ask the app to open a conversation.
//
// The real navigator is the `select` callback built inside `App`, and it is the only place that
// wires up `selectSession`'s full action chain (project memory, directory binding, connect →
// unarchive → release → open). Re-implementing that chain here would fork the one entrance the
// sidebar and the command palette already use. Instead `App` registers its `select` once at
// startup; anything that has resolved a session row — here, the retry alert — calls `jumpToSession`.

import type { SessionSummary } from "@/agent/client"
import type { Session } from "@alwith/api"

type JumpHandler = (row: SessionSummary) => void

let handler: JumpHandler | null = null

/** Called from `App` with its own `select` so the rest of the app can trigger a navigation. */
export function registerSessionJump(fn: JumpHandler): void {
  handler = fn
}

/** Open the given conversation through the app's real navigator. No-op until `App` registers it. */
export function jumpToSession(row: SessionSummary): void {
  handler?.(row)
}

/**
 * Builds the `SessionSummary` the navigator needs from a live `Session`.
 *
 * `Session` has no `archived` field (archival is tracked on the summary, not the live state), and a
 * running turn is by definition not archived, so `false` is always correct here. `updatedAt` may be
 * `null` on a brand-new session; `SessionSummary` allows that.
 */
export function summaryOf(session: Session): SessionSummary {
  return {
    sessionId: session.id,
    cwd: session.cwd,
    title: session.title,
    updatedAt: session.updatedAt,
    archived: false,
  }
}
