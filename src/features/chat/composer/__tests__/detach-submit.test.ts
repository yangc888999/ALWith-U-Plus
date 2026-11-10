import { expect, test, vi } from "vitest"

import { withoutWaitingForTurn } from "../detach-submit"

/** The window a submit stays open before it counts as accepted. */
const WINDOW_MS = 400

test("the composer is released long before a turn that keeps running", async () => {
  // The engine answers a prompt only when the whole turn is over. Awaiting that kept the submit
  // button spinning (and disabled) for the entire answer, so no second message could be sent.
  vi.useFakeTimers()
  try {
    const turn = new Promise<string>(() => {
      // Never settles: exactly what a running turn looks like to the caller.
    })
    const submit = withoutWaitingForTurn(turn)
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1)
    await expect(Promise.race([submit.then(() => "released"), Promise.resolve("waiting")])).resolves.toBe(
      "waiting"
    )
    await vi.advanceTimersByTimeAsync(1)
    await expect(submit).resolves.toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})

test("a send the engine refuses still fails, so the composer can restore the draft", async () => {
  // The package composer reacts to a failed submit by putting text and attachments back into the
  // input; swallowing this one is what loses a message that was never dispatched. A refusal inside
  // the window rejects the submit itself, so `onLateFailure` must not fire as well.
  const onLateFailure = vi.fn()
  await expect(withoutWaitingForTurn(Promise.reject(new Error("Request failed")), undefined, onLateFailure)).rejects.toThrow(
    "Request failed"
  )
  expect(onLateFailure).not.toHaveBeenCalled()
})

test("a turn that ends inside the window releases immediately and keeps the receipt", async () => {
  const accept = vi.fn()
  const onLateFailure = vi.fn()
  const started = Date.now()
  await expect(withoutWaitingForTurn(Promise.resolve("receipt-7"), accept, onLateFailure)).resolves.toBeUndefined()
  expect(Date.now() - started).toBeLessThan(WINDOW_MS)
  expect(accept).toHaveBeenCalledWith("receipt-7")
  expect(onLateFailure).not.toHaveBeenCalled()
})

test("a late dispatch refusal (no receipt) tells the composer to restore the draft", async () => {
  // The engine rejected before it inserted the message (`!inserted`), so there is no error item:
  // swallowing this rejection silently loses the draft and attachments.
  vi.useFakeTimers()
  try {
    const accept = vi.fn()
    const onLateFailure = vi.fn()
    let fail: (error: Error) => void = () => {}
    const turn = new Promise<string>((_resolve, reject) => {
      fail = reject
    })
    const submit = withoutWaitingForTurn(turn, accept, onLateFailure)
    await vi.advanceTimersByTimeAsync(WINDOW_MS)
    const error = new Error("gateway 400 after two minutes")
    fail(error)
    await vi.advanceTimersByTimeAsync(0)
    // The 400ms early release is unchanged: the submit still resolves as a success.
    await expect(submit).resolves.toBeUndefined()
    expect(onLateFailure).toHaveBeenCalledWith(error)
    expect(accept).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

test("a receipt arriving after the window is an inserted turn, so the draft stays cleared", async () => {
  // A receipt means the message was inserted; any later failure shows up as an error item and the
  // composer must not restore the draft a second time.
  vi.useFakeTimers()
  try {
    const accept = vi.fn()
    const onLateFailure = vi.fn()
    let deliver: (receipt: string) => void = () => {}
    const turn = new Promise<string>((resolve) => {
      deliver = resolve
    })
    const submit = withoutWaitingForTurn(turn, accept, onLateFailure)
    await vi.advanceTimersByTimeAsync(WINDOW_MS)
    deliver("receipt-late")
    await vi.advanceTimersByTimeAsync(0)
    await expect(submit).resolves.toBeUndefined()
    expect(accept).toHaveBeenCalledWith("receipt-late")
    expect(onLateFailure).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
