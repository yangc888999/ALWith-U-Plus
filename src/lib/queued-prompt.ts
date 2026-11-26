/**
 * Messages held back by the "queued" send mode until the running turn settles.
 *
 * The wait itself lives in `CodexClient.prompt`; this store is only its surface: the composer
 * shows each waiting message as a row above the input. Editing is inline and updates the
 * dispatch callback captured by the wait loop, so the row keeps its queue position. Deleting
 * marks it removed instead: the wait loop resolves without dispatching.
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
  /** Stable within the session; the list uses it for keys and drag-and-drop. */
  id: string
  /** First line of the message, for the row; null for attachment-only sends. */
  text: string | null
  /** Full editable text, including lines hidden by the compact row. */
  body: string
  /** Data URL for the first image attachment, if any. */
  image: string | null
  imageCount: number
  paused: boolean
  pauseReason: QueuedPromptPauseReason | null
  cancelled: boolean
  /** A deleted row resolves its submit without dispatching; unlike cancel, it is not restored. */
  removed: boolean
  jumping: boolean
  /** A row currently being accepted by the engine. It stays visible until the receipt lands. */
  dispatching: boolean
  /** Updates the captured prompt before it is dispatched. */
  edit?: (text: string) => void
  /** Tries to inject the captured prompt into the live turn. */
  jump?: () => Promise<QueuedPromptJumpResult>
}

export interface QueuedPromptItem {
  id: string
  text: string | null
  body: string
  image: string | null
  imageCount: number
  paused: boolean
  pauseReason: QueuedPromptPauseReason | null
  jumping: boolean
  dispatching: boolean
}

export type QueuedPromptJumpResult = "sent" | "queued"
export type QueuedPromptPauseReason = "stop" | "model-error" | "turn-error" | "steer-unknown"

export interface QueuedPromptHooks {
  body?: string
  image?: string | null
  imageCount?: number
  edit?: (text: string) => void
  jump?: () => Promise<QueuedPromptJumpResult>
}

const entries = new Map<string, QueuedPrompt[]>()
const revisions = new Map<string, number>()
const listeners = new Set<() => void>()
let sequence = 0

function emit(): void {
  for (const listener of listeners) listener()
}

function touch(sessionId: string): void {
  revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1)
  emit()
}

function summaryOf(text: string): string | null {
  const first = text.split("\n", 1)[0]?.trim() ?? ""
  if (first === "") return null
  return first.length > 160 ? `${first.slice(0, 160)}…` : first
}

/** Registers a waiting message and returns the entry the wait loop keeps checking. */
export function beginQueuedPrompt(
  sessionId: string,
  text: string | null,
  hooks: QueuedPromptHooks = {}
): QueuedPrompt {
  sequence += 1
  const paused = entries.get(sessionId)?.find((item) => item.paused)
  const entry: QueuedPrompt = {
    id: `queued-${sequence}`,
    text,
    body: hooks.body ?? text ?? "",
    image: hooks.image ?? null,
    imageCount: hooks.imageCount ?? 0,
    paused: paused !== undefined,
    pauseReason: paused?.pauseReason ?? null,
    cancelled: false,
    removed: false,
    jumping: false,
    dispatching: false,
    edit: hooks.edit,
    jump: hooks.jump
  }
  const list = entries.get(sessionId)
  if (list === undefined) entries.set(sessionId, [entry])
  else list.push(entry)
  touch(sessionId)
  return entry
}

/** Drops the entry once it was sent (or abandoned); a no-op for an entry already removed. */
export function endQueuedPrompt(sessionId: string, entry: QueuedPrompt): void {
  const list = entries.get(sessionId)
  if (list === undefined) return
  const next = list.filter((item) => item !== entry)
  if (next.length === 0) entries.delete(sessionId)
  else entries.set(sessionId, next)
  touch(sessionId)
}

/** Cancels one message (or all of them): the composer restores its text and attachments. */
export function cancelQueuedPrompt(sessionId: string, id?: string): void {
  const list = entries.get(sessionId)
  if (list === undefined) return
  if (id === undefined) {
    for (const entry of list) entry.cancelled = true
    entries.delete(sessionId)
  } else {
    const entry = list.find((item) => item.id === id)
    if (entry === undefined) return
    entry.cancelled = true
    const next = list.filter((item) => item !== entry)
    if (next.length === 0) entries.delete(sessionId)
    else entries.set(sessionId, next)
  }
  touch(sessionId)
}

/** Removes one message without putting it back into the composer. */
export function deleteQueuedPrompt(sessionId: string, id: string): void {
  const list = entries.get(sessionId)
  if (list === undefined) return
  const entry = list.find((item) => item.id === id)
  if (entry === undefined || entry.jumping || entry.dispatching) return
  entry.removed = true
  const next = list.filter((item) => item !== entry)
  if (next.length === 0) entries.delete(sessionId)
  else entries.set(sessionId, next)
  touch(sessionId)
}

/** Edits the captured prompt in place, preserving its queue position and attachments. */
export function editQueuedPrompt(sessionId: string, id: string, text: string): boolean {
  const entry = entries.get(sessionId)?.find((item) => item.id === id)
  if (entry === undefined || entry.jumping || entry.dispatching) return false
  const body = text.trim()
  if (body === "" && entry.imageCount === 0) return false
  entry.body = body
  entry.text = summaryOf(body)
  entry.edit?.(body)
  touch(sessionId)
  return true
}

/**
 * Tries to send one waiting row into the running turn immediately. A successful steer removes
 * the row; a non-steerable step promotes it to the head of the queue instead.
 */
export async function jumpQueuedPrompt(sessionId: string, id: string): Promise<QueuedPromptJumpResult> {
  const list = entries.get(sessionId)
  const entry = list?.find((item) => item.id === id)
  if (
    list === undefined ||
    entry === undefined ||
    entry.jumping ||
    entry.dispatching ||
    entry.paused ||
    list.some((item) => item.jumping || item.dispatching)
  )
    return "queued"
  entry.jumping = true
  touch(sessionId)
  try {
    const result = entry.jump === undefined ? "queued" : await entry.jump()
    // Re-read the live list after the await: a cancel, delete, reorder or a newly queued message
    // can land while steering is in flight. Writing the captured list back would resurrect rows
    // or erase messages that arrived in the meantime.
    const current = entries.get(sessionId)
    if (current === undefined) return result
    const index = current.indexOf(entry)
    if (result === "sent") {
      entry.removed = true
      if (index >= 0) {
        const next = current.filter((item) => item !== entry)
        if (next.length === 0) entries.delete(sessionId)
        else entries.set(sessionId, next)
        touch(sessionId)
      }
    } else if (index > 0) {
      const next = [...current]
      next.splice(index, 1)
      next.unshift(entry)
      entries.set(sessionId, next)
      touch(sessionId)
    }
    return result
  } finally {
    entry.jumping = false
    if (entries.get(sessionId)?.includes(entry) === true) touch(sessionId)
  }
}

/** Stops automatic dispatch without destroying any queued text or attachments. */
export function pauseQueuedPrompts(sessionId: string, reason: QueuedPromptPauseReason): void {
  const list = entries.get(sessionId)
  if (list === undefined) return
  for (const entry of list) {
    entry.paused = true
    entry.pauseReason = reason
  }
  touch(sessionId)
}

/** Resumes a paused queue; the caller must reopen the ACP session first if it was stopped. */
export function resumeQueuedPrompts(sessionId: string): void {
  const list = entries.get(sessionId)
  if (list === undefined) return
  for (const entry of list) {
    entry.paused = false
    entry.pauseReason = null
  }
  touch(sessionId)
}

/** Explicitly discards every row, used by the paused queue's own Clear action. */
export function clearQueuedPrompts(sessionId: string): void {
  const list = entries.get(sessionId)
  if (list === undefined) return
  if (list.some((entry) => entry.jumping || entry.dispatching)) return
  for (const entry of list) entry.removed = true
  entries.delete(sessionId)
  touch(sessionId)
}

/** Moves a waiting message to another row's position; the head is always sent first. */
export function moveQueuedPrompt(sessionId: string, activeId: string, overId: string): void {
  if (activeId === overId) return
  const list = entries.get(sessionId)
  if (list === undefined) return
  const from = list.findIndex((item) => item.id === activeId)
  const to = list.findIndex((item) => item.id === overId)
  if (from < 0 || to < 0) return
  if (
    list[from]?.jumping === true ||
    list[to]?.jumping === true ||
    list[from]?.dispatching === true ||
    list[to]?.dispatching === true
  )
    return
  const next = [...list]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return
  next.splice(to, 0, moved)
  entries.set(sessionId, next)
  touch(sessionId)
}

/** Primitive snapshots: `useSyncExternalStore` needs a stable value, not a fresh object. */
export function queuedPromptCount(sessionId: string): number {
  return entries.get(sessionId)?.length ?? 0
}

/** True while the session holds rows that must not dispatch until the reader resumes them. */
export function queuedPromptPaused(sessionId: string): boolean {
  return entries.get(sessionId)?.some((entry) => entry.paused) ?? false
}

/** Why the queue is paused, or null when every row may dispatch. */
export function queuedPromptPauseReason(sessionId: string): QueuedPromptPauseReason | null {
  return entries.get(sessionId)?.find((entry) => entry.paused)?.pauseReason ?? null
}

/** Marks the head row as waiting for its engine receipt without removing it from the list. */
export function setQueuedPromptDispatching(sessionId: string, id: string, dispatching: boolean): void {
  const entry = entries.get(sessionId)?.find((item) => item.id === id)
  if (entry === undefined || entry.dispatching === dispatching) return
  entry.dispatching = dispatching
  touch(sessionId)
}

export function queuedPromptRevision(sessionId: string): number {
  return revisions.get(sessionId) ?? 0
}

export function queuedPromptItems(sessionId: string): QueuedPromptItem[] {
  return (entries.get(sessionId) ?? []).map(
    ({ id, text, body, image, imageCount, paused, pauseReason, jumping, dispatching }) => ({
      id,
      text,
      body,
      image,
      imageCount,
      paused,
      pauseReason,
      jumping,
      dispatching
    })
  )
}

export function queuedPromptHead(sessionId: string, entry: QueuedPrompt): boolean {
  return entries.get(sessionId)?.[0] === entry
}

export function subscribeQueuedPrompts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
