import type { DriveController, DriveState } from "@alwith/module-drive"
import { expect, test, vi } from "vitest"

import { createStableDriveController } from "../drive-store"

function disconnected(): DriveState {
  return { connected: false, snapshot: null, error: null }
}

function fakeController(initial: DriveState = disconnected()) {
  let state = initial
  const listeners = new Set<() => void>()
  const attach = vi.fn(async () => {})
  const refresh = vi.fn(async () => {})
  const request = vi.fn<DriveController["request"]>(async () => ({ type: "done" }))
  const controller: DriveController = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    attach,
    refresh,
    request,
    dispose() {
      listeners.clear()
      state = disconnected()
      for (const listener of listeners) listener()
    }
  }
  return {
    controller,
    attach,
    refresh,
    request,
    listenerCount: () => listeners.size,
    publish(next: DriveState) {
      state = next
      for (const listener of [...listeners]) listener()
    }
  }
}

test("host publishes notify React asynchronously and coalesce into one update", async () => {
  const fake = fakeController()
  const wrapped = createStableDriveController(fake.controller)
  const listener = vi.fn()
  wrapped.subscribe(listener)

  const connected: DriveState = { connected: true, snapshot: null, error: null }
  const failed: DriveState = { connected: true, snapshot: null, error: "offline" }
  fake.publish(connected)
  fake.publish(failed)

  expect(listener).not.toHaveBeenCalled()
  expect(wrapped.getSnapshot()).toBe(failed)
  await Promise.resolve()
  expect(listener).toHaveBeenCalledTimes(1)
})

test("getSnapshot keeps a stable reference until the next real publish", () => {
  const fake = fakeController()
  const wrapped = createStableDriveController(fake.controller)
  const before = wrapped.getSnapshot()

  expect(wrapped.getSnapshot()).toBe(before)
  const next: DriveState = { connected: true, snapshot: null, error: null }
  fake.publish(next)
  expect(wrapped.getSnapshot()).toBe(next)
  expect(wrapped.getSnapshot()).toBe(next)
})

test("unsubscribing one listener leaves the others working", async () => {
  const fake = fakeController()
  const wrapped = createStableDriveController(fake.controller)
  const first = vi.fn()
  const second = vi.fn()
  const unsubscribe = wrapped.subscribe(first)
  wrapped.subscribe(second)

  unsubscribe()
  fake.publish({ connected: true, snapshot: null, error: null })
  await Promise.resolve()

  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledTimes(1)
})

test("dispose drops queued notifications and can be followed by a fresh subscription", async () => {
  const fake = fakeController()
  const wrapped = createStableDriveController(fake.controller)
  const oldListener = vi.fn()
  wrapped.subscribe(oldListener)
  fake.publish({ connected: true, snapshot: null, error: null })

  wrapped.dispose()
  await Promise.resolve()
  expect(oldListener).not.toHaveBeenCalled()
  expect(fake.listenerCount()).toBe(0)

  const nextListener = vi.fn()
  wrapped.subscribe(nextListener)
  fake.publish({ connected: true, snapshot: null, error: "retry" })
  await Promise.resolve()
  expect(nextListener).toHaveBeenCalledTimes(1)
  expect(fake.listenerCount()).toBe(1)
})

test("a request that publishes state before resolving is visible to imperative readers", async () => {
  const fake = fakeController()
  fake.request.mockImplementation(async () => {
    fake.publish({ connected: true, snapshot: null, error: null })
    return { type: "done" }
  })
  const wrapped = createStableDriveController(fake.controller)

  await wrapped.request({ type: "roots" })

  expect(wrapped.getSnapshot().connected).toBe(true)
})
