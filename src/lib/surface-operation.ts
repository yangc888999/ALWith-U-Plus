/**
 * Reject overlapping handoffs instead of queueing mutually dependent window requests.
 *
 * This lock is a UX guard, not a transaction. A wedged window request (a chat webview that never
 * answers, a stalled draft read, a background cloud call sitting in the draft queue) used to own it
 * forever; because the busy flag was wired to a root-level `inert`, that froze the entire window —
 * the sidebar, the file tree and every retry became unclickable. The watchdog releases `busy` after
 * WATCHDOG_MS without cancelling the underlying operation: aborting a half-finished handoff would
 * leave two windows disagreeing about who owns the draft. A generation counter keeps the late
 * `finally` of the old operation from clearing the flag (or the notification) of a newer one.
 *
 * Releasing the lock does mean a newer request can start while the old one is still running. The
 * signal handed to every operation makes that visible: long chains check `abandoned` after each
 * await and stop before writing drafts or window state. A request already dispatched to the engine
 * cannot be recalled, but no further local side effects follow it — and `onStall` tells the reader
 * that the interface was recovered so a retry is possible.
 *
 * `handoff: true` marks operations that replace the draft or move a conversation between windows.
 * Only those lock the composer; sending a message also uses this lock but must never disable the
 * input while its turn streams (see composer.tsx `withoutWaitingForTurn`).
 */
const WATCHDOG_MS = 30_000

export interface SurfaceOperationSignal {
  /** True once the watchdog has handed the lock to a newer request. */
  readonly abandoned: boolean
}

export interface SurfaceOperationOptions {
  handoff?: boolean
}

export function createSurfaceOperation(
  onBusy: (busy: boolean) => void,
  onStall: () => void = () => {},
  onHandoffBusy: (busy: boolean) => void = () => {}
): {
  readonly busy: boolean
  run: <T>(operation: (signal: SurfaceOperationSignal) => Promise<T>, options?: SurfaceOperationOptions) => Promise<T>
} {
  let busy = false
  let generation = 0
  return {
    get busy() {
      return busy
    },
    async run<T>(
      operation: (signal: SurfaceOperationSignal) => Promise<T>,
      options?: SurfaceOperationOptions
    ): Promise<T> {
      if (busy) throw new Error("A chat operation is already in progress")
      const handoff = options?.handoff === true
      busy = true
      const mine = ++generation
      onBusy(true)
      if (handoff) onHandoffBusy(true)
      const signal: SurfaceOperationSignal = {
        get abandoned() {
          return generation !== mine
        }
      }
      const release = (): void => {
        onBusy(false)
        if (handoff) onHandoffBusy(false)
      }
      const watchdog = setTimeout(() => {
        if (generation !== mine) return
        // Hand the lock over: the wedged request keeps running, but it no longer owns `busy`.
        generation++
        busy = false
        release()
        onStall()
      }, WATCHDOG_MS)
      try {
        return await operation(signal)
      } finally {
        clearTimeout(watchdog)
        if (generation === mine) {
          busy = false
          release()
        }
      }
    }
  }
}
