import { createFileSystem } from "@alwith/module-fs"
import { createMemoryAdapter } from "@alwith/module-fs/testing"
import { describe, expect, test, vi } from "vitest"

import { conflictDraftPath, writeConflictDraft } from "../conflict-draft"

function setup() {
  return createFileSystem({
    adapter: createMemoryAdapter({ "/repo/report.html": "<p>Disk</p>" }),
    reportError: vi.fn()
  })
}

describe("conflict drafts", () => {
  test("use one hidden path next to the document", () => {
    expect(conflictDraftPath("/repo/report.html", ".html")).toBe("/repo/.report.conflict-draft.html")
    expect(conflictDraftPath("C:\\repo\\report.md", ".md")).toBe("C:\\repo\\.report.conflict-draft.md")
  })

  test("reuse and overwrite the fixed draft instead of creating versions", async () => {
    const fs = setup()
    const first = await writeConflictDraft(fs, "/repo/report.html", new TextEncoder().encode("first"), ".html")
    const second = await writeConflictDraft(fs, "/repo/report.html", new TextEncoder().encode("second"), ".html")

    expect(first).toBe("/repo/.report.conflict-draft.html")
    expect(second).toBe(first)
    expect(new TextDecoder().decode(await fs.readFile(first))).toBe("second")
  })

  test("skip a write when the fixed draft already has the same bytes", async () => {
    const fs = setup()
    const bytes = new TextEncoder().encode("same")
    await writeConflictDraft(fs, "/repo/report.html", bytes, ".html")
    const writeSpy = vi.spyOn(fs, "writeFile")

    await writeConflictDraft(fs, "/repo/report.html", bytes, ".html")

    expect(writeSpy).not.toHaveBeenCalled()
  })
})
