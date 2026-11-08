import { describe, expect, test, vi } from "vitest"

const stored = new Map<string, boolean>()
vi.mock("@/lib/settings-store", () => ({
  settingsStore: {
    get: <T,>(key: string): T | undefined => stored.get(key) as T | undefined,
    subscribe: () => () => {}
  }
}))

const { blocksConflictCopies, hideConflictCopies, isConflictCopy, isIgnoredWatchPath } = await import(
  "../conflict-copy-filter"
)

describe("conflict copy names", () => {
  test("recognises the names Drive actually writes", () => {
    // Both shapes were copied verbatim out of ~/Documents/YUP on this machine.
    expect(isConflictCopy("拉取进度（冲突副本 · jie.yang · 2026-09-14 1952）.json")).toBe(true)
    expect(
      isConflictCopy("timestamp重跑v2_拉取进度（冲突副本 · jie.yang · 2026-09-21 2020） (4).json.yupcloud")
    ).toBe(true)
    expect(isConflictCopy("Report Ticket (conflicted copy 2026-11-06).xlsx")).toBe(true)
  })

  test("leaves real files and deliberate duplicates alone", () => {
    expect(isConflictCopy("拉取进度.json")).toBe(false)
    // macOS appends a bare counter when a name is taken. That is a file the reader made on
    // purpose; hiding it would look like data loss.
    expect(isConflictCopy("拉取进度 (1).json")).toBe(false)
    expect(isConflictCopy("报告（终稿）.md")).toBe(false)
    expect(isConflictCopy("冲突副本说明.md")).toBe(false)
  })
})

describe("watch event filtering", () => {
  test("hidden conflict copies stop waking the preview only while the switch is on", () => {
    const copy = "/root/report（冲突副本 · leo · 2026-11-06 0912）.md"
    stored.set("drive.blockConflictCopies", false)
    expect(isIgnoredWatchPath(copy)).toBe(false)
    stored.set("drive.blockConflictCopies", true)
    expect(isIgnoredWatchPath(copy)).toBe(true)
    expect(isIgnoredWatchPath("/root/report.md")).toBe(false)
    expect(isIgnoredWatchPath("/root/report (1).md")).toBe(false)
  })
})

describe("readDirectory filtering", () => {
  const dir = (...names: string[]) => ({
    readDirectory: vi.fn(async () => names.map((name) => ({ path: `/root/${name}`, name, kind: "file" as const }))),
    readFile: vi.fn(async () => new Uint8Array()),
    capabilities: { write: true }
  })

  test("hides conflict copies only while the switch is on", async () => {
    const fs = dir("a.md", "a（冲突副本 · leo · 2026-11-06 0912）.md", "b.md")
    const wrapped = hideConflictCopies(fs as never)

    stored.set("drive.blockConflictCopies", false)
    expect(blocksConflictCopies()).toBe(false)
    expect((await wrapped.readDirectory("/root")).map((entry) => entry.name)).toEqual([
      "a.md",
      "a（冲突副本 · leo · 2026-11-06 0912）.md",
      "b.md"
    ])

    stored.set("drive.blockConflictCopies", true)
    expect((await wrapped.readDirectory("/root")).map((entry) => entry.name)).toEqual(["a.md", "b.md"])
  })

  test("passes everything else through untouched", async () => {
    stored.set("drive.blockConflictCopies", true)
    const fs = dir("a.md")
    const wrapped = hideConflictCopies(fs as never)

    await wrapped.readFile("/root/a.md")
    expect(fs.readFile).toHaveBeenCalledWith("/root/a.md")
    expect(wrapped.capabilities).toEqual({ write: true })
  })
})
