/**
 * The plan an orchestrated conversation is waiting to execute.
 *
 * The planner turn ends with a plan that the user must approve ("执行计划"). Keeping it here (not
 * in the transcript) lets the composer render the approval action next to the input, and lets the
 * client resume the same plan when the worker is dispatched. It is intentionally ephemeral: a
 * relaunch starts clean, and the user can simply ask for a new plan.
 */
export interface PendingPlan {
  /** The planner's plan text, handed to the worker. */
  plan: string
  /** The user's original request, so the worker does not depend on the transcript alone. */
  request: string
}

const pending = new Map<string, PendingPlan>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function setPendingPlan(sessionId: string, value: PendingPlan | null): void {
  if (value === null) {
    if (!pending.delete(sessionId)) return
  } else {
    const current = pending.get(sessionId)
    if (current?.plan === value.plan && current.request === value.request) return
    pending.set(sessionId, value)
  }
  notify()
}

export function pendingPlanFor(sessionId: string): PendingPlan | null {
  return pending.get(sessionId) ?? null
}

export function subscribePendingPlan(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
