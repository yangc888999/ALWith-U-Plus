import type { Session } from "@alwith/api"
import { useMemo } from "react"

/** Stable empty transcript: the composer never reads items, and replacing it every streamed token
 *  would force the input subtree through the same render as the transcript. */
const NO_ITEMS: Session["items"] = []

/**
 * The composer only needs session identity, status and model/command configuration. Streaming
 * replaces the session's item array on every token; handing that live object to the composer made
 * typing an interjection wait behind markdown rendering. This projection changes only when a field
 * the composer actually consumes changes.
 */
export function useComposerSession(session: Session): Session {
  return useMemo(
    () => ({ ...session, items: NO_ITEMS }),
    [
      session.id,
      session.cwd,
      session.title,
      session.state,
      session.attached,
      session.restoring,
      session.readOnly,
      session.error,
      session.configOptions,
      session.lastStopReason,
      session.commands,
      session.configRevision
    ]
  )
}
