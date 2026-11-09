import type { ComposerDraft } from "@alwith/module-chat/conversation"

import type { SessionSummary } from "@/agent/client"
import type { ChatTransfer } from "@/lib/chat-window"

export type SelectSessionActions = {
  connect: () => Promise<void>
  unarchive: (id: string) => Promise<void>
  release: (id: string) => Promise<ChatTransfer | null>
  importDraft: (id: string, draft: ComposerDraft | null) => void
  include: (sessionRow: SessionSummary) => void
  open: (id: string, cwd: string) => Promise<void>
  show: (id: string) => void
  onOpenError: (error: unknown) => void
  /** Fires once this chain settles, so the caller can drop its "opening…" surface. */
  onSettled?: () => void
}

/**
 * Switching conversations is a UI action, not an engine transaction.
 *
 * `show` used to sit after `connect` → `unarchive` → `release`. Each of those can hang or reject:
 * a stalled Drive sync wedges the serialized draft queue that `connect` needs, a chat window has a
 * 60s answer deadline for `release`, and restoring an archived thread can fail outright. When any
 * of them did, the click was a silent no-op with only a toast as a trace. The caller also held a
 * global surface operation while waiting, whose `busy` flag made the entire window inert — so a
 * second click could not even retry.
 *
 * Show the target first and run preparation in the background. `open` was already fire-and-forget
 * for exactly this reason (history restoration must never block the switch); this makes the rest of
 * the chain consistent with it. A failure is reported through `onOpenError` without undoing the
 * switch — the user stays on the conversation they picked and can see what went wrong.
 *
 * `isCurrent` is last-click-wins. Without it, rapid A → B → C clicks start three preparation chains
 * that all `discardDraft("main")` and `open()` their own session; the client serializes those calls
 * but never cancels the stale ones, so the view could end up on C while the engine is attached to
 * A. Every await is followed by a currency check, and a superseded chain neither touches the
 * session list nor reports an error about a conversation the user has already left.
 */
export function selectSession(
  sessionRow: SessionSummary,
  actions: SelectSessionActions,
  isCurrent: () => boolean = () => true
): void {
  actions.show(sessionRow.sessionId)
  void (async () => {
    try {
      await actions.connect()
      if (!isCurrent()) return
      if (sessionRow.archived) {
        await actions.unarchive(sessionRow.sessionId)
        if (!isCurrent()) return
      }
      const transfer = await actions.release(sessionRow.sessionId)
      if (!isCurrent()) return
      if (transfer) actions.importDraft(sessionRow.sessionId, transfer.draft)
      actions.include({ ...sessionRow, archived: false })
      await actions.open(sessionRow.sessionId, sessionRow.cwd)
    } catch (error) {
      if (isCurrent()) actions.onOpenError(error)
    } finally {
      // Only the winning chain clears the caller's "opening" state; a superseded one would erase
      // the placeholder that belongs to the newer click.
      if (isCurrent()) actions.onSettled?.()
    }
  })()
}
