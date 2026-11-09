import { expect, test, vi } from "vitest"

import { createSurfaceOperation } from "../surface-operation"

const WATCHDOG_MS = 30_000

test("handoffs lock synchronously, reject overlap and unlock on failure", async () => {
  const changes: boolean[] = []
  const operation = createSurfaceOperation((value) => changes.push(value))
  let finish!: () => void
  const pending = operation.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  expect(operation.busy).toBe(true)
  let called = false
  await expect(
    operation.run(() => {
      called = true
      return Promise.resolve()
    })
  ).rejects.toThrow("already in progress")
  expect(called).toBe(false)
  finish()
  await pending
  await expect(
    operation.run(() => {
      return Promise.try(() => {
        throw new Error("delivery failed")
      })
    })
  ).rejects.toThrow("delivery failed")
  expect(operation.busy).toBe(false)
  expect(changes).toEqual([true, false, true, false])
})

test("a wedged handoff releases the lock without cancelling the request", async () => {
  vi.useFakeTimers()
  try {
    const changes: boolean[] = []
    const operation = createSurfaceOperation((value) => changes.push(value))
    let finish!: () => void
    const pending = operation.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    expect(operation.busy).toBe(true)

    await vi.advanceTimersByTimeAsync(WATCHDOG_MS)
    expect(operation.busy).toBe(false)
    expect(changes).toEqual([true, false])

    // The window is usable again even though the old request has not answered yet.
    await expect(operation.run(() => Promise.resolve(42))).resolves.toBe(42)
    finish()
    await pending
    expect(operation.busy).toBe(false)
    // One release for the watchdog, one for the replacement — no duplicate from the late settle.
    expect(changes).toEqual([true, false, true, false])
  } finally {
    vi.useRealTimers()
  }
})

test("a late settle cannot unlock a newer handoff", async () => {
  vi.useFakeTimers()
  try {
    const operation = createSurfaceOperation(() => {})
    let finishFirst!: () => void
    const first = operation.run(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS)

    let finishSecond!: () => void
    const second = operation.run(
      () =>
        new Promise<void>((resolve) => {
          finishSecond = resolve
        })
    )
    expect(operation.busy).toBe(true)

    finishFirst()
    await first
    expect(operation.busy).toBe(true)

    finishSecond()
    await second
    expect(operation.busy).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

test("only handoff operations lock the composer; a plain send never does", async () => {
  const handoff: boolean[] = []
  const operation = createSurfaceOperation(
    () => {},
    () => {},
    (value) => handoff.push(value)
  )

  await operation.run(async () => {})
  expect(handoff).toEqual([])

  await operation.run(async () => {}, { handoff: true })
  expect(handoff).toEqual([true, false])
})

test("a stalled handoff is marked abandoned and the recovery is reported", async () => {
  vi.useFakeTimers()
  try {
    const stalls: string[] = []
    const handoff: boolean[] = []
    let abandonedBefore = true
    let abandonedAfter = false
    let replacementAbandoned = true
    const operation = createSurfaceOperation(
      () => {},
      () => stalls.push("stalled"),
      (value) => handoff.push(value)
    )
    let finish!: () => void
    const pending = operation.run(
      async (signal) => {
        abandonedBefore = signal.abandoned
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        abandonedAfter = signal.abandoned
      },
      { handoff: true }
    )
    expect(abandonedBefore).toBe(false)

    await vi.advanceTimersByTimeAsync(WATCHDOG_MS)
    expect(stalls).toEqual(["stalled"])
    // The composer is usable again even though the old request is still running.
    expect(handoff).toEqual([true, false])

    // A newer request starts clean, while the abandoned one can still be told to stop.
    const replacement = operation.run(async (signal) => {
      replacementAbandoned = signal.abandoned
    })
    finish()
    await Promise.all([pending, replacement])
    expect(abandonedAfter).toBe(true)
    expect(replacementAbandoned).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})
