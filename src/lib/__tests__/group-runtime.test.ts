import { beforeEach, expect, test, vi } from "vitest"

import {
  armGroupDiscussion,
  clearGroupControl,
  groupControlFor,
  groupDiscussed,
  markGroupDiscussed,
  requestGroupStop,
  setGroupPaused
} from "@/lib/group-runtime"

beforeEach(() => {
  localStorage.clear()
})

test("a discussion is armed until it has actually run", () => {
  expect(groupDiscussed("s1")).toBe(false)
  markGroupDiscussed("s1")
  expect(groupDiscussed("s1")).toBe(true)
  // Asking for another round puts the roster back on the table for that session only.
  armGroupDiscussion("s1")
  expect(groupDiscussed("s1")).toBe(false)
  expect(groupDiscussed("s2")).toBe(false)
})

test("the done mark survives a reload", async () => {
  markGroupDiscussed("s1")
  // The list is cached in the module; a reload must read what storage holds, not the cache.
  vi.resetModules()
  const fresh = await import("@/lib/group-runtime")
  expect(fresh.groupDiscussed("s1")).toBe(true)
})

test("pause and stop are per session and independent", () => {
  setGroupPaused("a", true)
  expect(groupControlFor("a").paused).toBe(true)
  expect(groupControlFor("b").paused).toBe(false)

  requestGroupStop("a")
  // Stopping releases the brake: the roster is done, not waiting for a resume that never comes.
  expect(groupControlFor("a")).toEqual({ paused: false, stop: true })

  clearGroupControl("a")
  expect(groupControlFor("a")).toEqual({ paused: false, stop: false })
})
