/**
 * Live state of a group discussion.
 *
 * Kept apart from the persisted group definition: who is speaking right now is a property of this
 * moment, not something a restart should restore.
 */
type GroupPhase = "idle" | "discussing" | "closing" | "done" | "stopped" | "error"

export interface GroupDiscussionState {
  phase: GroupPhase
  /** The member who is speaking, or null between turns. */
  speaker: string | null
  /** The round being spoken, counting from 1. */
  round: number
  /** How many members the roster has. */
  members: number
  error: string | null
}

const IDLE: GroupDiscussionState = { phase: "idle", speaker: null, round: 0, members: 0, error: null }
const listeners = new Set<() => void>()
let state: Record<string, GroupDiscussionState> = {}

function groupDiscussionFor(sessionId: string): GroupDiscussionState {
  return state[sessionId] ?? IDLE
}

export function patchGroupDiscussion(sessionId: string, patch: Partial<GroupDiscussionState>): void {
  const current = state[sessionId] ?? IDLE
  state = { ...state, [sessionId]: { ...current, ...patch } }
  for (const listener of listeners) listener()
}

export function subscribeGroupDiscussion(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function groupDiscussionSnapshot(sessionId: string): GroupDiscussionState {
  return groupDiscussionFor(sessionId)
}

/**
 * Who is speaking, announced by the client as each member takes the session.
 *
 * The agent knows who holds the floor; the panel is in another part of the tree, so the name
 * travels through this one-line channel instead of a callback threaded through the client.
 */
const speakerListeners = new Set<(speaker: string | null, round: number) => void>()

export function announceGroupSpeaker(speaker: string | null, round: number): void {
  for (const listener of speakerListeners) listener(speaker, round)
}

export function subscribeGroupSpeaker(listener: (speaker: string | null, round: number) => void): () => void {
  speakerListeners.add(listener)
  return () => speakerListeners.delete(listener)
}

/**
 * The user's hand on a running discussion.
 *
 * A discussion is a long chain of turns the user did not type: without a brake, the only way to
 * say "wait, that premise is wrong" is to kill the app. So the roster checks this between turns —
 * pausing lets the turn in flight finish (nobody's answer is cut in half), and the user then has
 * the floor to interject.
 */
export interface GroupControl {
  /** Hold after the turn in flight instead of taking the next one. */
  paused: boolean
  /** End the discussion instead of taking another turn. */
  stop: boolean
}

const IDLE_CONTROL: GroupControl = { paused: false, stop: false }
const control: Record<string, GroupControl> = {}
const controlListeners = new Set<() => void>()

export function groupControlFor(sessionId: string): GroupControl {
  return control[sessionId] ?? IDLE_CONTROL
}

function patchControl(sessionId: string, patch: Partial<GroupControl>): void {
  const current = control[sessionId] ?? IDLE_CONTROL
  control[sessionId] = { ...current, ...patch }
  for (const listener of controlListeners) listener()
}

export function setGroupPaused(sessionId: string, paused: boolean): void {
  patchControl(sessionId, { paused })
}

export function requestGroupStop(sessionId: string): void {
  patchControl(sessionId, { stop: true, paused: false })
}

/** A finished discussion leaves no brake behind; the next one starts clean. */
export function clearGroupControl(sessionId: string): void {
  if (control[sessionId] === undefined) return
  delete control[sessionId]
  for (const listener of controlListeners) listener()
}

export function subscribeGroupControl(listener: () => void): () => void {
  controlListeners.add(listener)
  return () => controlListeners.delete(listener)
}

/**
 * Whether this conversation has already run its discussion.
 *
 * A group project used to start a full roster on *every* user message: one question, then five
 * models answering the follow-up nobody asked them. The roster belongs to the first question;
 * afterwards the conversation is an ordinary chat until the user asks for another round. Kept in
 * storage so reopening the conversation does not re-arm it.
 */
const DISCUSSED_KEY = "alwith:group-discussed"
/** Enough ids to cover a long working week; the oldest fall off. */
const DISCUSSED_LIMIT = 300
const discussedListeners = new Set<() => void>()
let discussed: string[] | null = null

function readDiscussed(): string[] {
  if (discussed !== null) return discussed
  try {
    const raw = localStorage.getItem(DISCUSSED_KEY)
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    discussed = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []
  } catch {
    discussed = []
  }
  return discussed
}

function writeDiscussed(next: string[]): void {
  discussed = next
  try {
    localStorage.setItem(DISCUSSED_KEY, JSON.stringify(next))
  } catch {
    // Storage can be unavailable; the in-memory list still holds for this launch.
  }
  for (const listener of discussedListeners) listener()
}

export function groupDiscussed(sessionId: string): boolean {
  return readDiscussed().includes(sessionId)
}

export function markGroupDiscussed(sessionId: string): void {
  const list = readDiscussed()
  if (list.includes(sessionId)) return
  writeDiscussed([...list, sessionId].slice(-DISCUSSED_LIMIT))
}

/** Puts the roster back on the table for the next user turn (or a manual round). */
export function armGroupDiscussion(sessionId: string): void {
  const list = readDiscussed()
  if (!list.includes(sessionId)) return
  writeDiscussed(list.filter((id) => id !== sessionId))
}

export function subscribeGroupDiscussed(listener: () => void): () => void {
  discussedListeners.add(listener)
  return () => discussedListeners.delete(listener)
}
