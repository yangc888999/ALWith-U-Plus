// Two chat-surface preferences, WorkBuddy style, persisted per install.
//
// - Queue send mode: what happens when the user sends a message while a turn is running.
//   "immediate" (the default) uses the adapter's live-turn steering so the message is inserted
//   into the running turn. "queued" holds the send until the running turn settles, so the current
//   answer is never interrupted; the message then goes out on its own.
// - Conversation detail: how tool activity renders while a turn runs. "compact" keeps finished
//   tool groups collapsed; "full" spreads every group open via the timeline stylesheet.
export type QueueSendMode = "queued" | "immediate"
export type ConversationDetail = "compact" | "full"

const QUEUE_KEY = "alwith:queue-send-mode"
const DETAIL_KEY = "alwith:conversation-detail"

function read<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    if (value !== null && (allowed as string[]).includes(value)) return value as T
  } catch {
    // Storage unavailable: defaults only.
  }
  return fallback
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage unavailable; the in-memory value still holds for this launch.
  }
}

let queueMode: QueueSendMode = read(QUEUE_KEY, ["queued", "immediate"], "immediate")
let detail: ConversationDetail = read(DETAIL_KEY, ["compact", "full"], "compact")

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getQueueSendMode(): QueueSendMode {
  return queueMode
}

export function setQueueSendMode(value: QueueSendMode): void {
  if (value === queueMode) return
  queueMode = value
  write(QUEUE_KEY, value)
  emit()
}

export function getConversationDetail(): ConversationDetail {
  return detail
}

export function setConversationDetail(value: ConversationDetail): void {
  if (value === detail) return
  detail = value
  write(DETAIL_KEY, value)
  emit()
}

export function subscribeChatDisplayPreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
