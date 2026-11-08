import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { createWatchRelay } from "../watch-relay"

describe("watch relay", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("a sync burst produces one deduplicated notification", () => {
    const changed = vi.fn()
    const relay = createWatchRelay(changed)
    relay.schedule(["/root/a.md", "/root/b.md"])
    relay.schedule(["/root/b.md", "/root/c.md"])
    expect(changed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledWith(["/root/a.md", "/root/b.md", "/root/c.md"])
    relay.dispose()
  })

  test("continuous writes keep extending the debounce until they stop", () => {
    const changed = vi.fn()
    const relay = createWatchRelay(changed)
    for (let index = 0; index < 20; index += 1) {
      relay.schedule([`/root/file-${index}.md`])
      vi.advanceTimersByTime(50)
    }
    expect(changed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0][0]).toHaveLength(20)
    relay.dispose()
  })

  test("rejected paths never wake the editor", () => {
    const changed = vi.fn()
    const relay = createWatchRelay(changed, (path) => !path.includes("冲突副本"))
    relay.schedule(["/root/report（冲突副本 · leo · 2026-11-06 0912）.md"])
    vi.advanceTimersByTime(500)
    expect(changed).not.toHaveBeenCalled()
    relay.schedule(["/root/report.md"])
    vi.advanceTimersByTime(200)
    expect(changed).toHaveBeenCalledWith(["/root/report.md"])
    relay.dispose()
  })

  test("a burst after the previous flush is delivered separately", () => {
    const changed = vi.fn()
    const relay = createWatchRelay(changed)
    relay.schedule(["/root/a.md"])
    vi.advanceTimersByTime(200)
    relay.schedule(["/root/b.md"])
    vi.advanceTimersByTime(200)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed.mock.calls[1][0]).toEqual(["/root/b.md"])
    relay.dispose()
  })

  test("dispose drops pending paths instead of notifying a dead workspace", () => {
    const changed = vi.fn()
    const relay = createWatchRelay(changed)
    relay.schedule(["/root/a.md"])
    relay.dispose()
    vi.advanceTimersByTime(1000)
    expect(changed).not.toHaveBeenCalled()
  })
})
