import { beforeEach, expect, test, vi } from "vitest"

import { createWorkspaceSessionStore, createWorkspaceStateStore } from "../workspace-state"

beforeEach(() => localStorage.clear())

test("two conversations in one project remember their own tabs", async () => {
  const sessions = createWorkspaceSessionStore()
  await sessions.save("/a", "s1", { tabs: [{ path: "/a/one.md", pinned: true }], activePath: "/a/one.md" })
  await sessions.save("/a", "s2", { tabs: [{ path: "/a/two.md", pinned: false }], activePath: "/a/two.md" })

  // The whole point: opening the second chat must not show the first chat's document.
  expect(await sessions.load("/a", "s2")).toEqual({
    tabs: [{ path: "/a/two.md", pinned: false }],
    activePath: "/a/two.md"
  })
  expect(await sessions.load("/a", "s1")).toEqual({
    tabs: [{ path: "/a/one.md", pinned: true }],
    activePath: "/a/one.md"
  })
  // A conversation that never opened anything has no record, so it inherits the project view.
  expect(await sessions.load("/a", "s3")).toBeNull()
  // Same conversation id under another project is a different conversation.
  expect(await sessions.load("/b", "s1")).toBeNull()
  // The project record stays a single shared entry.
  expect(localStorage.getItem("workspace:/a")).toBeNull()
})

test("drops paths and active selections that left the project", async () => {
  const sessions = createWorkspaceSessionStore()
  localStorage.setItem(
    "workspace-session:/a#s1",
    JSON.stringify({
      tabs: [
        { path: "/a/kept.md", pinned: true },
        { path: "/b/gone.md", pinned: false }
      ],
      activePath: "/b/gone.md"
    })
  )
  expect(await sessions.load("/a", "s1")).toEqual({
    tabs: [{ path: "/a/kept.md", pinned: true }],
    activePath: null
  })
  // A corrupt record must not break the switch; it reads as "nothing remembered".
  localStorage.setItem("workspace-session:/a#s2", "{not json")
  await expect(sessions.load("/a", "s2")).rejects.toThrow()
  localStorage.setItem("workspace-session:/a#s3", JSON.stringify({ tabs: "nope" }))
  expect(await sessions.load("/a", "s3")).toBeNull()
})

test("restores project tabs and tree preferences without persisting document bodies", async () => {
  const store = createWorkspaceStateStore()
  await store.save("/a", {
    tabs: [{ path: "/a/one.md", pinned: true }],
    activePath: "/a/one.md",
    expanded: ["/a", "/a/docs"],
    showHidden: true,
    showIgnored: false,
    iconTheme: "material-icon-theme"
  })
  expect(await createWorkspaceStateStore().load("/a")).toEqual({
    tabs: [{ path: "/a/one.md", pinned: true }],
    activePath: "/a/one.md",
    expanded: ["/a", "/a/docs"],
    showHidden: true,
    showIgnored: false,
    iconTheme: "material-icon-theme"
  })
  expect(await store.load("/b")).toBeNull()
  expect(localStorage.getItem("workspace:/a")).not.toContain("text")
})

test("rejects stored paths outside the project and malformed preferences", async () => {
  localStorage.setItem("workspace:/a", JSON.stringify({ tabs: [{ path: "/b/private.txt", pinned: true }] }))
  await expect(createWorkspaceStateStore().load("/a")).rejects.toThrow()
})

test("propagates failed persistence and allows a later save", async () => {
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new Error("disk full")
  })
  const store = createWorkspaceStateStore()
  const state = {
    tabs: [],
    activePath: null,
    expanded: ["/a"],
    showHidden: false,
    showIgnored: false,
    iconTheme: "vscode-icons" as const
  }
  await expect(store.save("/a", state)).rejects.toThrow("disk full")
  await store.save("/a", state)
  expect(await store.load("/a")).toEqual(state)
  write.mockRestore()
})

test("rejects malformed mixed-tab state and paths escaping the workspace", async () => {
  const state = {
    tabs: [],
    activePath: null,
    expanded: ["/a"],
    showHidden: false,
    showIgnored: false,
    iconTheme: "vscode-icons"
  }
  for (const tabLayout of [
    { tabs: [{ kind: "file", path: "/b/secret.txt" }], activeIndex: 0 },
    { tabs: [{ kind: "new" }], activeIndex: 1 },
    { tabs: [{ kind: "new" }], activeIndex: -1 },
    { tabs: [{ kind: "unknown" }], activeIndex: 0 },
    {
      tabs: [
        { kind: "file", path: "/a/file.txt" },
        { kind: "file", path: "/a/file.txt" }
      ],
      activeIndex: 0
    }
  ]) {
    localStorage.setItem("workspace:/a", JSON.stringify({ ...state, tabLayout }))
    await expect(createWorkspaceStateStore().load("/a")).rejects.toThrow()
  }
})
