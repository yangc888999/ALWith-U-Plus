// Failures that describe the *engine's* state rather than the request. They arrive as text from
// Codex's app-server. Recognising them never means "rebuild the connection from the caller": the
// plugins page tried exactly that on 2026-11-17 and its recovery loop killed the live engine.

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error !== null && typeof error === "object" && "message" in error) return String(error.message)
  return ""
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
