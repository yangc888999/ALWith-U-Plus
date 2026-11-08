/**
 * Sending a message must not keep the composer busy for the whole answer.
 *
 * The engine answers `prompt` only when the turn is over (it returns the stop reason), and the
 * package composer uses that same promise to drive its `sending` state. Awaiting it turned the
 * round submit arrow into a spinner that stayed for minutes: the button was disabled, so nothing
 * else could be typed and sent until the model finished — the opposite of steering a running turn.
 *
 * The two things that promise still has to carry cannot both be dropped:
 *
 * - A refusal that comes back immediately (no session, nothing to send, the engine rejecting the
 *   dispatch) is a *failed send*: the composer must hear it, because that is what puts the text
 *   and attachments back into the input.
 * - Everything after that is the turn itself, which the stop button beside the submit button
 *   already shows.
 *
 * So a submit stays open for a short window: inside it a rejection still fails the send, outside
 * it the turn is treated as accepted and keeps running in the background.
 */

/**
 * How long a submit may stay open before it counts as accepted.
 *
 * Comfortably longer than a local refusal (the client raises those in the same tick) and far
 * shorter than any model round trip, so the arrow is back before the reader looks at it.
 */
const DISPATCH_WINDOW_MS = 400

/** What an accepted send resolves to: the receipt the transport stamped on the message. */
export type SubmitReceipt = string

/**
 * Resolves once the message is accepted; rejects while it is still being refused.
 *
 * `task` is the promise the client returned; `accept` receives its receipt once the engine
 * confirms the message (the voice handoff relies on it). A rejection after the window is
 * swallowed on purpose — it already reaches the reader as an error item in the conversation, and
 * leaving it unhandled would also trip the window's global handler.
 */
export function withoutWaitingForTurn(
  task: Promise<unknown>,
  accept?: (receipt: SubmitReceipt) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let windowTimer: ReturnType<typeof setTimeout> | null = null
    const settle = (failure: { error: unknown } | null): void => {
      if (settled) return
      settled = true
      if (windowTimer !== null) clearTimeout(windowTimer)
      if (failure === null) resolve()
      else reject(failure.error)
    }
    windowTimer = setTimeout(() => settle(null), DISPATCH_WINDOW_MS)
    void task.then(
      (receipt) => {
        // The handoff needs the receipt even when the turn took longer than the window.
        if (accept !== undefined && typeof receipt === "string") accept(receipt)
        settle(null)
      },
      (error: unknown) => settle({ error })
    )
  })
}
