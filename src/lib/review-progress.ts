/**
 * Live state of the multi-model review for each conversation.
 *
 * Deliberately separate from the persisted setting: an opinion is worth showing for the turn it
 * belongs to, and keeping a month of them in localStorage would grow without bound and say nothing
 * useful afterwards.
 */
export type ReviewPhase = "idle" | "reviewing" | "synthesizing" | "done" | "error"

export interface ReviewOpinion {
  model: string
  label: string
  /** What the reviewer wrote, or "" when it failed. */
  text: string
  error: string | null
}

export interface ReviewProgress {
  phase: ReviewPhase
  opinions: ReviewOpinion[]
  error: string | null
  /** The answer item this review belongs to, so a stale card never sits beside a newer turn. */
  answerId: string | null
}

const IDLE: ReviewProgress = { phase: "idle", opinions: [], error: null, answerId: null }
const listeners = new Set<() => void>()
let state: Record<string, ReviewProgress> = {}

export function reviewProgressFor(sessionId: string): ReviewProgress {
  return state[sessionId] ?? IDLE
}

export function patchReviewProgress(sessionId: string, patch: Partial<ReviewProgress>): void {
  const current = state[sessionId] ?? IDLE
  state = { ...state, [sessionId]: { ...current, ...patch } }
  for (const listener of listeners) listener()
}

/** Drops the card entirely; used when a new turn starts so the old opinions stop competing. */
export function clearReviewProgress(sessionId: string): void {
  if (state[sessionId] === undefined) return
  const { [sessionId]: _dropped, ...rest } = state
  state = rest
  for (const listener of listeners) listener()
}

export function subscribeReviewProgress(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function reviewProgressSnapshot(sessionId: string): ReviewProgress {
  return reviewProgressFor(sessionId)
}
