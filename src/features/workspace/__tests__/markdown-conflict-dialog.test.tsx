import { fireEvent, render } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

import {
  isMarkdownDocumentPath,
  MarkdownConflictDialog,
  markdownDraftPath,
  type MarkdownConflictState
} from "../markdown-conflict-dialog"

await initI18n("en")

const conflict: MarkdownConflictState = {
  path: "/repo/notes.md",
  local: "# Local\n",
  current: "# Cloud\n",
  version: "v2",
  draftPath: "/repo/.notes.conflict-draft.md",
  draftError: null
}

test("the Markdown conflict dialog compares both versions and exposes the fixed draft path", () => {
  const onUseDisk = vi.fn()
  const onOverwrite = vi.fn()
  const onKeep = vi.fn()
  const view = render(
    <MarkdownConflictDialog
      conflict={conflict}
      busy={false}
      error={null}
      onUseDisk={onUseDisk}
      onOverwrite={onOverwrite}
      onKeep={onKeep}
    />
  )
  expect(view.getByText("# Local")).toBeInTheDocument()
  expect(view.getByText("# Cloud")).toBeInTheDocument()
  expect(view.getByText(/notes\.conflict-draft\.md/)).toBeInTheDocument()
  fireEvent.click(view.getByRole("button", { name: "Load file version" }))
  fireEvent.click(view.getByRole("button", { name: "Overwrite with draft" }))
  fireEvent.click(view.getByRole("button", { name: "Keep editing draft" }))
  expect(onUseDisk).toHaveBeenCalledOnce()
  expect(onOverwrite).toHaveBeenCalledOnce()
  expect(onKeep).toHaveBeenCalledOnce()
})

test("Markdown conflicts use one fixed hidden draft path and ignore HTML", () => {
  expect(isMarkdownDocumentPath("/repo/notes.md")).toBe(true)
  expect(isMarkdownDocumentPath("/repo/notes.markdown")).toBe(true)
  expect(isMarkdownDocumentPath("/repo/report.html")).toBe(false)
  expect(markdownDraftPath("/repo/notes.md")).toBe("/repo/.notes.conflict-draft.md")
})
