import { useSyncExternalStore } from "react"

/**
 * Proportions for a chat surface, which has exactly two regions: the session sidebar and the
 * conversation. It is deliberately a separate store from `workspace:layout` — a project opens four
 * columns, a chat opens two, and the sidebar was never meant to be the same width in both.
 *
 * The conversation share is never written by a drag: the only editable region in a chat is the
 * sidebar, and the conversation takes whatever is left. That keeps "chat always follows Settings"
 * true by construction.
 */
export interface ChatLayoutPreferences {
  /** Session sidebar share of the window width. */
  navigationRatio: number
  /** Conversation share of the window width. */
  chatRatio: number
}

const STORAGE_KEY = "workspace:chat-layout"

// A chat is typography first: the sidebar stays narrow, the conversation gets the rest.
export const chatLayoutDefaults: ChatLayoutPreferences = {
  navigationRatio: 0.16,
  chatRatio: 0.84
}

function clamp(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

export function loadChatLayout(storage: Storage = localStorage): ChatLayoutPreferences {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return { ...chatLayoutDefaults }
    const value = JSON.parse(raw) as Partial<ChatLayoutPreferences> | null
    if (typeof value !== "object" || value === null) return { ...chatLayoutDefaults }
    const navigation = clamp(value.navigationRatio, chatLayoutDefaults.navigationRatio)
    return { navigationRatio: navigation, chatRatio: 1 - navigation }
  } catch {
    return { ...chatLayoutDefaults }
  }
}

let cachedKey = ""
let cachedValue: ChatLayoutPreferences = { ...chatLayoutDefaults }
const listeners = new Set<() => void>()

function current(): ChatLayoutPreferences {
  const value = loadChatLayout()
  const key = `${value.navigationRatio}:${value.chatRatio}`
  if (key === cachedKey) return cachedValue
  cachedKey = key
  cachedValue = value
  return value
}

export function getChatLayout(): ChatLayoutPreferences {
  return current()
}

export function subscribeChatLayout(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function saveChatLayout(patch: Partial<ChatLayoutPreferences>, storage: Storage = localStorage): void {
  const next = { ...loadChatLayout(storage), ...patch }
  // Settings can edit either side. Whichever value came in decides the other, so the two always
  // close at 100% without the caller having to pair them.
  const editedChat = patch.chatRatio !== undefined && patch.navigationRatio === undefined
  const navigation = editedChat
    ? 1 - clamp(patch.chatRatio, chatLayoutDefaults.chatRatio)
    : clamp(next.navigationRatio, chatLayoutDefaults.navigationRatio)
  // The two always close at 100%: the sidebar is the only edit, the conversation is the remainder.
  const value: ChatLayoutPreferences = { navigationRatio: navigation, chatRatio: 1 - navigation }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // A full or disabled storage must not break the layout; the in-memory cache still updates.
  }
  cachedKey = `${value.navigationRatio}:${value.chatRatio}`
  cachedValue = value
  for (const listener of listeners) listener()
}

export function useChatLayout(): ChatLayoutPreferences {
  return useSyncExternalStore(subscribeChatLayout, current, current)
}
