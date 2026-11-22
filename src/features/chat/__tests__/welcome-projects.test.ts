import { describe, expect, test } from "vitest"

import { projectNameFromPath, recentProjectsFrom } from "../welcome-projects"

describe("recent projects", () => {
  test("keeps one row per folder, newest first", () => {
    const projects = recentProjectsFrom([
      { cwd: "/work/alpha", title: "older alpha", updatedAt: "2026-11-20T10:00:00Z" },
      { cwd: "/work/beta", title: "newest beta", updatedAt: "2026-11-22T10:00:00Z" },
      { cwd: "/work/alpha", title: "newer alpha", updatedAt: "2026-11-21T10:00:00Z" }
    ])
    expect(projects.map((project) => project.name)).toEqual(["beta", "alpha"])
    expect(projects[1]?.title).toBe("newer alpha")
  })

  test("drops temporary chats and respects the limit", () => {
    const projects = recentProjectsFrom(
      [
        { cwd: "/tmp/quick", title: "quick", updatedAt: "2026-11-22T12:00:00Z" },
        { cwd: "/work/alpha", title: "alpha", updatedAt: "2026-11-22T11:00:00Z" },
        { cwd: "/work/beta", title: "beta", updatedAt: "2026-11-22T10:00:00Z" }
      ],
      1,
      (cwd) => cwd.startsWith("/tmp/")
    )
    expect(projects).toHaveLength(1)
    expect(projects[0]?.name).toBe("alpha")
  })

  test("a trailing separator does not become the project name", () => {
    expect(projectNameFromPath("/work/alpha/")).toBe("alpha")
  })
})
