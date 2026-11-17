// Failures that describe the *engine's* state rather than the request, and that the app can heal
// by itself. Both arrive as text: the Runtime owns the first message, Codex's app-server the second.

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error !== null && typeof error === "object" && "message" in error) return String(error.message)
  return ""
}

/**
 * The Runtime no longer answers for the agent this connection asks about.
 *
 * Two sentences describe the same state. `agent is not owned by this connection` is a Runtime that
 * was replaced under a live connection; `agent codex exited` is the engine process itself being
 * gone. Both leave every per-agent request refused until the connection reconnects, and the
 * plugins page (`plugin/list`, `plugin/installed`, `skills/list`) is normally the first surface to
 * see it — and it stayed red forever, because nothing in the app recognised either sentence
 * (2026-11-17).
 */
export function isAgentOwnershipError(error: unknown): boolean {
  const text = textOf(error)
  return /agent is not owned by this connection/i.test(text) || /agent \S+ exited/i.test(text)
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
