/**
 * The directory binding is the single source the layout, file tree, preview and composer read.
 * These cases pin the resolution order and the React #185-safe snapshot that the old scattered
 * `session?.cwd ?? lastDirectory` recomputation never had.
 */
import { act, renderHook } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"

vi.mock("@/bindings", () => ({
  commands: { quickChatDirectory: vi.fn(async () => "/Users/me/Documents/ALwith") },
  events: new Proxy({}, { get: () => ({ name: "stub" }) })
}))

import {
  bindProjectDirectory,
  isGroupsRoot,
  projectDirectoryFor,
  resolveProjectDirectory,
  useBoundProjectDirectory
} from "../project-directory"

const MEETING = "/Users/me/Documents/ALWith/groups/定价会"
const GROUPS_ROOT = "/Users/me/Documents/ALWith/groups"

beforeEach(() => {
  // Bindings are module-level; each case uses its own key so no case inherits another's setup.
})

test("an explicit binding wins over the session cwd and the last directory", () => {
  bindProjectDirectory("binding-wins", MEETING, "group-1")
  expect(
    resolveProjectDirectory({ sessionId: "binding-wins", sessionCwd: "/some/other/project", lastDirectory: "/last" })
  ).toEqual({ directory: MEETING, groupId: "group-1", reason: "group" })
})

test("a draft (sessionId === null) resolves through the draft binding", () => {
  bindProjectDirectory("__draft__", MEETING, "group-2")
  expect(resolveProjectDirectory({ sessionId: null, sessionCwd: null, lastDirectory: "/last" })).toEqual({
    directory: MEETING,
    groupId: "group-2",
    reason: "group"
  })
})

test("the Groups root is invalid whatever the on-disk case, a meeting folder is not", () => {
  expect(isGroupsRoot("/Users/me/Documents/ALWith/groups")).toBe(true)
  expect(isGroupsRoot("/Users/me/Documents/ALwith/groups/")).toBe(true)
  expect(isGroupsRoot("C:\\Users\\me\\Documents\\ALWITH\\groups\\")).toBe(true)
  expect(isGroupsRoot(MEETING)).toBe(false)
  expect(
    resolveProjectDirectory({
      sessionId: "root-check",
      sessionCwd: "/Users/me/Documents/ALwith/groups",
      lastDirectory: "/some/project"
    }).reason
  ).toBe("invalid")
})

test("a rejected binding keeps an invalid state instead of being silently dropped", () => {
  bindProjectDirectory("rejected", "/Users/me/Documents/ALWith/groups", "group-3")
  expect(projectDirectoryFor("rejected")).toBeNull()
  expect(resolveProjectDirectory({ sessionId: "rejected", sessionCwd: null, lastDirectory: "/some/project" })).toEqual({
    directory: null,
    groupId: "group-3",
    reason: "invalid"
  })
  bindProjectDirectory("rejected-empty", "", null)
  expect(resolveProjectDirectory({ sessionId: "rejected-empty", sessionCwd: null, lastDirectory: null }).reason).toBe(
    "invalid"
  )
})

test("a quick-chat directory is temporary and never falls through to a stale project", () => {
  expect(
    resolveProjectDirectory({
      sessionId: "quick-check",
      sessionCwd: "/Users/me/Documents/ALwith",
      lastDirectory: "/some/project"
    })
  ).toEqual({ directory: null, groupId: null, reason: "temporary" })
})

test("an ordinary project falls back to sessionCwd, then lastDirectory", () => {
  expect(
    resolveProjectDirectory({ sessionId: "fallback-cwd", sessionCwd: "/projects/a", lastDirectory: "/projects/b" })
      .directory
  ).toBe("/projects/a")
  expect(
    resolveProjectDirectory({ sessionId: "fallback-last", sessionCwd: null, lastDirectory: "/projects/b" }).directory
  ).toBe("/projects/b")
})

test("with nothing bound and nothing known the reason is missing", () => {
  expect(resolveProjectDirectory({ sessionId: "empty-check", sessionCwd: null, lastDirectory: null })).toEqual({
    directory: null,
    groupId: null,
    reason: "missing"
  })
})

test("useSyncExternalStore sees one stable snapshot and only changes on a real rebind", () => {
  const { result, rerender } = renderHook(({ key }: { key: string }) => useBoundProjectDirectory(key), {
    initialProps: { key: "stable-snapshot" }
  })
  const before = result.current
  rerender({ key: "stable-snapshot" })
  expect(result.current).toBe(before)
  expect(projectDirectoryFor("stable-snapshot")).toBe(projectDirectoryFor("stable-snapshot"))
  act(() => bindProjectDirectory("stable-snapshot", "/projects/snapshot", null))
  expect(result.current).not.toBe(before)
  expect(result.current?.directory).toBe("/projects/snapshot")
  // A rebind with identical values does not publish a new snapshot.
  const rebound = result.current
  act(() => bindProjectDirectory("stable-snapshot", "/projects/snapshot", null))
  expect(result.current).toBe(rebound)
})

// Task #5 / ①: the hook used to read `projectDirectoryFor`, which hides rejected bindings. Writing
// an invalid directory therefore published no snapshot and the app kept rendering a stale surface.
// It must now publish the raw attempt so the repair state appears on the same frame.
test("an invalid binding publishes a snapshot and a healed rebind replaces it", () => {
  const { result } = renderHook(() => useBoundProjectDirectory("invalid-snapshot"))
  expect(result.current).toBeNull()
  act(() => bindProjectDirectory("invalid-snapshot", GROUPS_ROOT, "g1"))
  const invalid = result.current
  expect(invalid?.directory).toBe(GROUPS_ROOT)
  expect(invalid?.invalid).toBe(true)
  // The reader must still see `invalid`, not a silently valid project.
  expect(resolveProjectDirectory({ sessionId: "invalid-snapshot", sessionCwd: null, lastDirectory: "/projects/a" }).reason).toBe(
    "invalid"
  )
  act(() => bindProjectDirectory("invalid-snapshot", MEETING, "g1"))
  expect(result.current).not.toBe(invalid)
  expect(result.current?.invalid).toBeUndefined()
  expect(result.current?.directory).toBe(MEETING)
  expect(projectDirectoryFor("invalid-snapshot")?.directory).toBe(MEETING)
})
