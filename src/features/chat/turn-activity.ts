// Who is holding a running turn: this machine, the user, or the upstream.
//
// The distinction matters because silence means different things depending on the answer. A tool
// call ends the upstream response, so while Codex runs a shell command (a query, a build, a data
// pull) there is no request in flight at all — a two-minute gap there is the tool working, not a
// model that stopped answering. Offering "switch model" in that window used to cancel the running
// tool for nothing.

import type { Session } from "@alwith/api"

const RUNNING_TOOL = new Set(["in_progress", "pending"])

/** The tool this turn is still executing locally, or null when nothing is running on this machine. */
export function activeTool(session: Session): { name: string } | null {
  // Only the turn in flight counts: a finished turn's last tool must not shadow the next one.
  let index = session.items.length - 1
  while (index >= 0 && session.items[index]?.kind !== "user") index -= 1
  for (let at = session.items.length - 1; at > index; at -= 1) {
    const item = session.items[at]
    if (item === undefined || item.kind !== "tool") continue
    const status = (item as { status?: string }).status
    if (status === undefined || !RUNNING_TOOL.has(status)) continue
    const title = (item as { title?: string | null }).title ?? ""
    const name = (item as { name?: string | null }).name ?? ""
    return { name: title !== "" ? title : name }
  }
  return null
}

/** The turn is parked on a permission / elicitation prompt, so nothing is expected from anywhere. */
export function awaitingUser(session: Session): boolean {
  return session.state === "requires_action"
}
