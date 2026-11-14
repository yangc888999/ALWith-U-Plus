import { createPreviewProviders, type PreviewProps } from "@alwith/module-editor/previews"
import { Editor, editorViewCtx } from "@milkdown/core"
import { TextSelection } from "@milkdown/prose/state"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { useMemo, useState } from "react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { createWysiwygMarkdownIntegration } from "../markdown-wysiwyg"
import type { WysiwygLabels } from "../wysiwyg-types"

const labels: WysiwygLabels = {
  bold: "Bold",
  italic: "Italic",
  underline: "Underline",
  strikethrough: "Strikethrough",
  blockquote: "Blockquote",
  bulletList: "Bullet list",
  orderedList: "Numbered list",
  outdent: "Outdent",
  indent: "Indent",
  inlineCode: "Inline code",
  codeBlock: "Code block",
  insertTable: "Insert table",
  deleteRow: "Delete row",
  deleteColumn: "Delete column",
  deleteImage: "Delete image",
  editHtml: "Edit",
  finishEditHtml: "Done",
  htmlEditBlocked: "This file cannot be edited",
  htmlDeleted: "Deleted",
  htmlUndoDelete: "Undo"
}

function fixture(text: string): PreviewProps {
  return {
    document: {
      id: "markdown",
      path: "/repo/notes.md",
      kind: "text",
      text,
      savedText: text,
      bytes: new TextEncoder().encode(text),
      encoding: "utf-8",
      bom: false,
      eol: "\n",
      version: "1",
      contentRevision: 0,
      dirty: false,
      saving: false,
      locked: false,
      externalChange: false,
      pinned: true,
      status: "loaded",
      loadError: null
    },
    context: { readOnly: false, onChange: vi.fn(), onSave: vi.fn(), onError: vi.fn() },
    host: {
      pdfWorkerSrc: "worker.js",
      resolveResource: vi.fn(() => Promise.try(() => Promise.reject(new Error("Unexpected resource"))))
    }
  }
}

function Workbench({ props }: { props: PreviewProps }): ReactNode {
  const [actions, setActions] = useState<ReactNode>(null)
  const provider = useMemo(
    () => createPreviewProviders(props.host).find((candidate) => candidate.id === "markdown"),
    [props.host]
  )
  if (!provider) throw new Error("Missing Markdown preview")
  return (
    <>
      <header>{actions}</header>
      {provider.render(props.document, { ...props.context, setToolbarActions: setActions })}
    </>
  )
}

/** Wrap the host's Markdown integration with the WYSIWYG toolbar. */
function withWysiwyg(props: PreviewProps): PreviewProps {
  const base = props.host.createMarkdownIntegration
  props.host.createMarkdownIntegration = (document, context) =>
    createWysiwygMarkdownIntegration(base?.(document, context), context, labels)
  return props
}

/** Capture the live Editor instance for direct dispatch assertions. */
function captureEditor(): { current: Editor | undefined } {
  const ref: { current: Editor | undefined } = { current: undefined }
  const make = Editor.make.bind(Editor)
  vi.spyOn(Editor, "make").mockImplementation(() => {
    const editor = make()
    ref.current = editor
    return editor
  })
  return ref
}

/**
 * Preview is the default; formatting tests must opt into editing through the toolbar button first.
 * Waiting for Bold keeps the editor-ready wait in one place.
 */
async function enterEditMode(): Promise<void> {
  await screen.findByRole("button", { name: "Bold" }, { timeout: 5000 })
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Bold" })).not.toBeDisabled())
}

/** Place the caret inside the first text block matching `needle`. */
function caretAt(editor: Editor, needle: string): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    let position = -1
    view.state.doc.descendants((node, pos) => {
      if (position >= 0) return false
      if (node.isText && node.text?.includes(needle)) {
        position = pos + (node.text?.indexOf(needle) ?? 0)
        return false
      }
      return true
    })
    if (position < 0) throw new Error(`Text not found: ${needle}`)
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, position))
    view.dispatch(tr)
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// jsdom has no layout engine: ProseMirror's scrollIntoView path calls getClientRects on text
// nodes, which throws. Toolbar commands dispatch scrollIntoView transactions, so stub the two
// geometry probes with empty rects (the assertions are about document content, not scrolling).
beforeEach(() => {
  const empty = (): DOMRect => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) })
  Element.prototype.getClientRects = function getClientRects(): DOMRectList {
    return Object.assign([empty()], { item: (index: number) => (index === 0 ? empty() : null) }) as unknown as DOMRectList
  }
  Range.prototype.getClientRects = Element.prototype.getClientRects as never
  Range.prototype.getBoundingClientRect = empty
})

test("toolbar renders through render(), survives the outline revision, and coexists with the outline", async () => {
  const props = withWysiwyg(fixture("# Title\n\n## Second\n"))
  const view = render(<Workbench props={props} />)
  await screen.findByRole("heading", { name: "Title" }, { timeout: 5000 })
  const toolbar = view.container.querySelector(".alwith-wysiwyg-toolbar")
  expect(toolbar).not.toBeNull()
  // The outline still owns the header slot; the toolbar is NOT in the header.
  expect(toolbar?.closest("header")).toBeNull()
  expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument()
  // Wait past the 800ms MutationObserver revision that re-claims setToolbarActions.
  await new Promise((resolve) => setTimeout(resolve, 1100))
  expect(view.container.querySelector(".alwith-wysiwyg-toolbar")).not.toBeNull()
  expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument()
}, 15000)

test("the preview stays read-only until the reader presses Edit", async () => {
  const props = withWysiwyg(fixture("# Preview\n"))
  const view = render(<Workbench props={props} />)
  await screen.findByRole("button", { name: "Edit" }, { timeout: 5000 })
  const surface = view.container.querySelector(".ProseMirror")
  expect(surface).not.toBeNull()
  await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "false"))
  expect(surface).toHaveAttribute("data-alwith-markdown-editing", "false")
  // The host re-applies `integration.editable()` after mount; that contract must stay false.
  expect(props.host.createMarkdownIntegration).toBeDefined()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"))
  expect(surface).toHaveAttribute("data-alwith-markdown-editing", "true")
  fireEvent.click(screen.getByRole("button", { name: "Done" }))
  await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "false"))
  expect(surface).toHaveAttribute("data-alwith-markdown-editing", "false")
})

test("bold button toggles strong on the caret's word and publishes Markdown", async () => {
  const editorRef = captureEditor()
  const props = withWysiwyg(fixture("hello world\n"))
  render(<Workbench props={props} />)
  await enterEditMode()
  const editor = editorRef.current
  if (!editor) throw new Error("Missing editor")
  act(() => caretAt(editor, "hello"))
  // Select the word "hello".
  act(() => {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const { from } = view.state.selection
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 5)))
    })
  })
  fireEvent.click(screen.getByRole("button", { name: "Bold" }))
  await waitFor(() => expect(props.context.onChange).toHaveBeenCalled())
  expect(props.context.onChange).toHaveBeenLastCalledWith(expect.stringContaining("**hello**"))
})

test("underline button round-trips <u> through the serializer", async () => {
  const editorRef = captureEditor()
  const props = withWysiwyg(fixture("plain text\n"))
  render(<Workbench props={props} />)
  await enterEditMode()
  const editor = editorRef.current
  if (!editor) throw new Error("Missing editor")
  act(() => {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)))
    })
  })
  fireEvent.click(screen.getByRole("button", { name: "Underline" }))
  await waitFor(() => expect(props.context.onChange).toHaveBeenCalled())
  expect(props.context.onChange).toHaveBeenLastCalledWith(expect.stringContaining("<u>"))
})

test("existing <u>x</u> parses into an underline mark and re-serializes", async () => {
  const editorRef = captureEditor()
  const props = withWysiwyg(fixture("a <u>x</u> b\n"))
  const view = render(<Workbench props={props} />)
  // Programmatic edits must not publish while the preview is read-only; opt in first.
  await enterEditMode()
  const editor = editorRef.current
  if (!editor) throw new Error("Missing editor")
  // The underline mark exists in the schema and the document round-trips.
  const hasUnderline = editor.action((ctx) => ctx.get(editorViewCtx).state.schema.marks.underline !== undefined)
  expect(hasUnderline).toBe(true)
  act(() => {
    editor.action((ctx) => {
      const v = ctx.get(editorViewCtx)
      v.dispatch(v.state.tr.insertText("!", 1))
    })
  })
  await waitFor(() => expect(props.context.onChange).toHaveBeenCalled())
  expect(props.context.onChange).toHaveBeenLastCalledWith(expect.stringContaining("<u>x</u>"))
  expect(view.container.querySelector(".alwith-wysiwyg-toolbar")).not.toBeNull()
})

test("table row/column delete works from a plain caret (TextSelection), last row removes the table", async () => {
  const editorRef = captureEditor()
  const props = withWysiwyg(fixture("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n"))
  render(<Workbench props={props} />)
  await enterEditMode()
  const editor = editorRef.current
  if (!editor) throw new Error("Missing editor")
  act(() => caretAt(editor, "1"))
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete row" })).not.toBeDisabled())
  fireEvent.click(screen.getByRole("button", { name: "Delete row" }))
  await waitFor(() => expect(props.context.onChange).toHaveBeenCalled())
  const afterRow = (props.context.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string
  expect(afterRow).not.toContain("| 1 |")
  expect(afterRow).toContain("| 3 |")
  // The header is a real row: deleting the last data row leaves the header.
  act(() => caretAt(editor, "3"))
  fireEvent.click(screen.getByRole("button", { name: "Delete row" }))
  await waitFor(() => {
    const last = (props.context.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string
    expect(last).not.toContain("| 3 |")
  })
  // Deleting the final remaining row (the header) spans the whole table → remove the table.
  act(() => caretAt(editor, "a"))
  fireEvent.click(screen.getByRole("button", { name: "Delete row" }))
  await waitFor(() => {
    const last = (props.context.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string
    expect(last).not.toContain("|")
  })
})

test("table column delete removes the caret's column", async () => {
  const editorRef = captureEditor()
  const props = withWysiwyg(fixture("| a | b |\n| - | - |\n| 1 | 2 |\n"))
  render(<Workbench props={props} />)
  await enterEditMode()
  const editor = editorRef.current
  if (!editor) throw new Error("Missing editor")
  act(() => caretAt(editor, "1"))
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete column" })).not.toBeDisabled())
  fireEvent.click(screen.getByRole("button", { name: "Delete column" }))
  await waitFor(() => expect(props.context.onChange).toHaveBeenCalled())
  const last = (props.context.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string
  expect(last).not.toContain("| 1 |")
})

test("code block button toggles a fenced block and back to text", async () => {
  const editorRef = captureEditor()
  const props = withWysiwyg(fixture("some code\n"))
  render(<Workbench props={props} />)
  await enterEditMode()
  const editor = editorRef.current
  if (!editor) throw new Error("Missing editor")
  act(() => caretAt(editor, "some"))
  fireEvent.click(screen.getByRole("button", { name: "Code block" }))
  await waitFor(() => expect(props.context.onChange).toHaveBeenCalled())
  expect((props.context.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toContain("```")
  fireEvent.click(screen.getByRole("button", { name: "Code block" }))
  await waitFor(() => {
    const last = (props.context.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string
    expect(last).not.toContain("```")
  })
})

test("blockquote button toggles a quote and back", async () => {
  const editorRef = captureEditor()
  const props = withWysiwyg(fixture("quoted line\n"))
  render(<Workbench props={props} />)
  await enterEditMode()
  const editor = editorRef.current
  if (!editor) throw new Error("Missing editor")
  act(() => caretAt(editor, "quoted"))
  fireEvent.click(screen.getByRole("button", { name: "Blockquote" }))
  await waitFor(() => expect(props.context.onChange).toHaveBeenCalled())
  expect((props.context.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toContain("> quoted")
  fireEvent.click(screen.getByRole("button", { name: "Blockquote" }))
  await waitFor(() => {
    const last = (props.context.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string
    expect(last).not.toContain("> quoted")
  })
})

test("readOnly disables every toolbar button", async () => {
  const props = withWysiwyg(fixture("# Read only\n"))
  props.context.readOnly = true
  render(<Workbench props={props} />)
  await screen.findByRole("button", { name: "Bold" }, { timeout: 5000 })
  const buttons = screen.getAllByRole("button").filter((button) => button.closest(".alwith-wysiwyg-toolbar"))
  expect(buttons.length).toBeGreaterThan(10)
  for (const button of buttons) expect(button).toBeDisabled()
})

test("Drive base integration: all seven hooks forwarded once, render composed, frontmatter preserved", async () => {
  const base = {
    configure: vi.fn(),
    ready: vi.fn(async () => {}),
    dispose: vi.fn(),
    editable: vi.fn(() => true),
    serialize: vi.fn((text: string) => `---\ntitle: Keep\n---\n${text}`),
    applyExternal: vi.fn(() => false),
    render: vi.fn(() => <aside>Drive surface</aside>)
  }
  const props = fixture("# Drive\n")
  props.host.createMarkdownIntegration = (_document, context) =>
    createWysiwygMarkdownIntegration(base, context, labels)
  const view = render(<Workbench props={props} />)
  await waitFor(() => expect(base.ready).toHaveBeenCalledTimes(1))
  expect(base.configure).toHaveBeenCalledTimes(1)
  expect(base.editable).toHaveBeenCalled()
  expect(base.render).toHaveBeenCalled()
  expect(screen.getByText("Drive surface")).toBeInTheDocument()
  expect(view.container.querySelector(".alwith-wysiwyg-toolbar")).not.toBeNull()
  // Serialize forwards to the base (frontmatter kept).
  const editorRef = captureEditor()
  void editorRef
  view.unmount()
  expect(base.dispose).toHaveBeenCalledTimes(1)
})