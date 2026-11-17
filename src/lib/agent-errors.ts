// Failures that describe the *engine's* state rather than the request, and that the app can heal
// by itself. Both arrive as text: the Runtime owns the first message, Codex's app-server the second.

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error !== null && typeof error === "object" && "message" in error) return String(error.message)
  return ""
}

/**
 * The Runtime no longer associates the named agent with the connection that asked for it.
 *
 * Ownership dies with the engine process: once the Runtime is replaced, a request that names the
 * agent it used to run is refused instead of being answered by a different process. Every catalog
 * request the plugins page fires (`plugin/list`, `plugin/installed`, `skills/list`) is per-agent,
 * so that page is normally the first surface to see it — and it stayed red forever, because
 * nothing in the app recognised the sentence (2026-11-17).
 */
export function isAgentOwnershipError(error: unknown): boolean {
  return /agent is not owned by this connection/i.test(textOf(error))
}

/**
 * Codex was asked about a thread it does not have in memory.
 *
 * A fresh app-server starts with no threads loaded, so this is the "engine restarted under a live
 * conversation" shape of the same story. The thread still exists on disk: resuming it is enough,
 * no rebuild of the conversation is involved.
 */
export function isThreadNotLoadedError(error: unknown): boolean {
  return /thread not loaded:/i.test(textOf(error))
}
