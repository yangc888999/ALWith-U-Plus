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
  // input; swallowing this one is what loses a message that was never dispatched.
  await expect(withoutWaitingForTurn(Promise.reject(new Error("Request failed")))).rejects.toThrow(
    "Request failed"
  )
})

test("a turn that ends inside the window releases immediately and keeps the receipt", async () => {
  const accept = vi.fn()
  const started = Date.now()
  await expect(withoutWaitingForTurn(Promise.resolve("receipt-7"), accept)).resolves.toBeUndefined()
  expect(Date.now() - started).toBeLessThan(WINDOW_MS)
  expect(accept).toHaveBeenCalledWith("receipt-7")
})

test("a late failure stays quiet here instead of tripping the window's error handler", async () => {
  // It already shows up as an error item in the conversation.
  vi.useFakeTimers()
  try {
    const accept = vi.fn()
    let fail: (error: Error) => void = () => {}
    const turn = new Promise<string>((_resolve, reject) => {
      fail = reject
    })
    const submit = withoutWaitingForTurn(turn, accept)
    await vi.advanceTimersByTimeAsync(WINDOW_MS)
    fail(new Error("gateway 400 after two minutes"))
    await expect(submit).resolves.toBeUndefined()
    expect(accept).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
