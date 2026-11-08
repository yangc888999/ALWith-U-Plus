/**
 * Messages held back by the "queued" send mode until the running turn settles.
 *
 * The wait itself lives in `CodexClient.prompt`; this store is only its surface: the composer
 * shows "排队中…（点击取消）" above the input, and cancelling marks the entry so the wait loop
 * rejects instead of sending. Rejecting (rather than resolving) is deliberate — the package
 * composer reacts to a failed submit by putting the text and attachments back into the input, so
 * a cancelled message is never lost.
 */
export class QueueCancelledError extends Error {
  constructor() {
    super("Queued message cancelled")
    this.name = "QueueCancelledError"
  }
}

export function isQueueCancelled(error: unknown): boolean {
  return error instanceof QueueCancelledError
}

export interface QueuedPrompt {
  /** First line of the message, for the chip; null for attachment-only sends. */
  text: string | null
  cancelled: boolean
}

const entries = new Map<string, QueuedPrompt[]>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Registers a waiting message and returns the entry the wait loop keeps checking. */
export function beginQueuedPrompt(sessionId: string, text: string | null): QueuedPrompt {
  const entry: QueuedPrompt = { text, cancelled: false }
  const list = entries.get(sessionId)
  if (list === undefined) entries.set(sessionId, [entry])
  else list.push(entry)
  emit()
  return entry
}

/** Drops the entry once it was sent (or abandoned); a no-op for an entry already removed. */
export function endQueuedPrompt(sessionId: string, entry: QueuedPrompt): void {
  const list = entries.get(sessionId)
  if (list === undefined) return
  const next = list.filter((item) => item !== entry)
  if (next.length === 0) entries.delete(sessionId)
  else entries.set(sessionId, next)
  emit()
}

/** Cancels every message queued for this session: none of them will be sent. */
export function cancelQueuedPrompt(sessionId: string): void {
  const list = entries.get(sessionId)
  if (list === undefined) return
  for (const entry of list) entry.cancelled = true
  entries.delete(sessionId)
  emit()
}

/** Primitive snapshots: `useSyncExternalStore` needs a stable value, not a fresh object. */
export function queuedPromptCount(sessionId: string): number {
  return entries.get(sessionId)?.length ?? 0
}

export function queuedPromptText(sessionId: string): string | null {
  return entries.get(sessionId)?.[0]?.text ?? null
}

export function subscribeQueuedPrompts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
