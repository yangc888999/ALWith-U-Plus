import type { Session } from "@alwith/api"
import { nativeTurnId } from "@nyssance/codex-acp-v2/client"

/**
 * Count the conversation's rounds from the transcript.
 *
 * A round is one native Codex turn, not one user item: steering or sending a supplement while the
 * current turn runs adds another user message to that same turn. Counting raw user messages made
 * the header badge grow faster than the visible conversation (#1.8.0). Messages from older
 * transcripts without a native turn id still count one by one, which is the best available answer
 * for them.
 */
export function countSessionRounds(session: Session): number {
  const nativeTurns = new Set<string>()
  let legacyRounds = 0
  let liveRounds = 0
  for (const item of session.items) {
    if (item.kind !== "user") continue
    const turnId = nativeTurnId(item)
    if (turnId !== null) {
      nativeTurns.add(turnId)
      continue
    }
    // A replayed user item without a turn id predates native turn metadata; each one is a round.
    if (item.replayed) {
      legacyRounds += 1
      continue
    }
    // Live steers are inserted into the running turn as user chunks with `echo: null`. They share
    // the current round; only a real prompt carries an echo state.
    if (item.echo !== null) liveRounds += 1
  }
  return nativeTurns.size + legacyRounds + liveRounds
}
