/**
 * QA regression: the toolbar commands the delivered suites never click.
 *
 * The user's acceptance list names 斜体 / 删除线 / 有序与无序列表 / 缩进 / 行内代码 / 插入表格 explicitly,
 * but the shipped tests only exercised bold, underline, blockquote, code block and the two table
 * deletes. Every command below is driven through the real toolbar button on a real Milkdown editor
 * and asserted on the published Markdown, so a broken command cannot hide behind "tests pass".
 */
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

interface Session {
  editor: Editor
  props: PreviewProps
  /** The most recent Markdown the editor published. */
  published: () => string
  caret: (needle: string) => void
  select: (needle: string, length: number) => void
  click: (name: string) => void
}

/**
 * The real factory, captured at import time — before any spy exists. `mount()` may run twice inside
 * one test; reading `Editor.make` at call time would then capture the *previous* spy and recurse
 * into it (Maximum call stack size exceeded).
 */
const makeEditor = Editor.make.bind(Editor)

/**
 * Tear-down for the session mounted most recently. A test may mount a second editor to check a
 * different document; leaving the first one alive puts two identical toolbars in the document and
 * every `screen.getByRole("button", …)` below becomes ambiguous ("Found multiple elements").
 * Retiring the previous session keeps those queries single-match without scoping each assertion.
 */
let retirePrevious: (() => void) | null = null

/** Mount a real editor with the WYSIWYG toolbar and return helpers to drive it. */
async function mount(text: string, firstButton: string): Promise<Session> {
  retirePrevious?.()
  retirePrevious = null
  let captured: Editor | undefined
  vi.spyOn(Editor, "make").mockImplementation(() => {
    captured = makeEditor()
    return captured
  })
  const props = fixture(text)
  props.host.createMarkdownIntegration = (_document, context) =>
    createWysiwygMarkdownIntegration(undefined, context, labels)
  const view = render(<Workbench props={props} />)
  retirePrevious = view.unmount
  await screen.findByRole("button", { name: firstButton }, { timeout: 5000 })
  // The toolbar renders before Milkdown finishes mounting, so waiting for a button is not enough:
  // commands dispatched against a half-built view are silently dropped. Wait for the real document.
  await waitFor(
    () => {
      const surface = view.container.querySelector(".ProseMirror")
      if (surface === null) throw new Error("ProseMirror not mounted")
      if (surface.textContent === "" || surface.textContent === null) throw new Error("Document not parsed yet")
    },
    { timeout: 5000 }
  )
  const editor = captured
  if (!editor) throw new Error("Missing editor")

  const positionOf = (needle: string): number =>
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      let found = -1
      view.state.doc.descendants((node, pos) => {
        if (found >= 0) return false
        if (node.isText && node.text?.includes(needle)) {
          found = pos + (node.text.indexOf(needle) ?? 0)
          return false
        }
        return true
      })
      if (found < 0) throw new Error(`Text not found: ${needle}`)
      return found
    })

  return {
    editor,
    props,
    published: () => (props.context.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string,
    caret: (needle) => {
      act(() => {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const at = positionOf(needle)
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
        })
      })
    },
    select: (needle, length) => {
      act(() => {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const at = positionOf(needle)
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at + length)))
        })
      })
    },
    click: (name) => {
      fireEvent.click(screen.getByRole("button", { name }))
    }
  }
}

beforeEach(() => {
  // jsdom has no layout engine; ProseMirror's scrollIntoView probes these.
  const empty = (): DOMRect => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) })
  Element.prototype.getClientRects = function getClientRects(): DOMRectList {
    return Object.assign([empty()], { item: (index: number) => (index === 0 ? empty() : null) }) as unknown as DOMRectList
  }
  Range.prototype.getClientRects = Element.prototype.getClientRects as never
  Range.prototype.getBoundingClientRect = empty
})

afterEach(() => {
  retirePrevious = null
  cleanup()
  vi.restoreAllMocks()
})

// The large-document path renders the read-only surface, which never calls
// createMarkdownIntegration — so the toolbar must be absent until the pencil mounts Milkdown,
// and mounting it must not make the document dirty.
test("a ≥1MiB Markdown shows no toolbar until the pencil mounts the editor, and stays clean", async () => {
  const props = fixture(`# Large\n\n${"文".repeat(350_000)}`)
  props.host.createMarkdownIntegration = (_document, context) =>
    createWysiwygMarkdownIntegration(undefined, context, labels)
  const view = render(<Workbench props={props} />)
  await screen.findByRole("heading", { name: "Large" }, { timeout: 10000 })
  expect(view.container.querySelector(".alwith-wysiwyg-toolbar")).toBeNull()
  expect(view.container.querySelector(".ProseMirror")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown" }))
  await waitFor(
    () => expect(view.container.querySelector(".ProseMirror")).toHaveAttribute("contenteditable", "true"),
    { timeout: 10000 }
  )
  expect(view.container.querySelector(".alwith-wysiwyg-toolbar")).not.toBeNull()
  expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument()
  expect(props.context.onChange).not.toHaveBeenCalled()
}, 30000)

test("italic toggles emphasis on the selection and back off", async () => {
  const s = await mount("hello world\n", "Italic")
  s.select("hello", 5)
  s.click("Italic")
  await waitFor(() => expect(s.props.context.onChange).toHaveBeenCalled())
  expect(s.published()).toContain("*hello*")
  expect(s.published()).not.toContain("**hello**")
  // Toggling again removes the mark.
  s.select("hello", 5)
  s.click("Italic")
  await waitFor(() => expect(s.published()).not.toContain("*hello*"))
})

test("strikethrough toggles the GFM mark on the selection and back off", async () => {
  const s = await mount("hello world\n", "Strikethrough")
  s.select("hello", 5)
  s.click("Strikethrough")
  await waitFor(() => expect(s.props.context.onChange).toHaveBeenCalled())
  expect(s.published()).toContain("~~hello~~")
  s.select("hello", 5)
  s.click("Strikethrough")
  await waitFor(() => expect(s.published()).not.toContain("~~hello~~"))
})

test("inline code wraps the selection in backticks and toggles back", async () => {
  const s = await mount("run this now\n", "Inline code")
  s.select("this", 4)
  s.click("Inline code")
  await waitFor(() => expect(s.props.context.onChange).toHaveBeenCalled())
  expect(s.published()).toContain("`this`")
  s.select("this", 4)
  s.click("Inline code")
  await waitFor(() => expect(s.published()).not.toContain("`this`"))
})

test("bullet list wraps the caret's paragraph and a second click lifts it back out", async () => {
  const s = await mount("first item\n", "Bullet list")
  s.caret("first")
  s.click("Bullet list")
  await waitFor(() => expect(s.props.context.onChange).toHaveBeenCalled())
  expect(s.published()).toMatch(/[-*]\s+first item/)
  s.caret("first")
  s.click("Bullet list")
  await waitFor(() => expect(s.published()).not.toMatch(/[-*]\s+first item/))
})

test("ordered list numbers the caret's paragraph and a second click lifts it back out", async () => {
  const s = await mount("first item\n", "Numbered list")
  s.caret("first")
  s.click("Numbered list")
  await waitFor(() => expect(s.props.context.onChange).toHaveBeenCalled())
  expect(s.published()).toMatch(/1\.\s+first item/)
  s.caret("first")
  s.click("Numbered list")
  await waitFor(() => expect(s.published()).not.toMatch(/1\.\s+first item/))
})

test("bullet-list toggle leaves an ordered list untouched (no cross-kind lift)", async () => {
  const s = await mount("1. numbered\n", "Bullet list")
  s.caret("numbered")
  s.click("Bullet list")
  // The command may legitimately refuse (no publish at all). What must never happen is the ordered
  // item being lifted into a plain paragraph or renumbered away, so assert on the live document.
  await act(async () => {
    await Promise.resolve()
  })
  const orderedSurvives = s.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    let ordered = false
    let text = ""
    view.state.doc.descendants((node) => {
      if (node.type.name === "ordered_list") ordered = true
      if (node.isText) text += node.text ?? ""
      return true
    })
    return ordered && text.includes("numbered")
  })
  expect(orderedSurvives).toBe(true)
})

// Regression guard for the QA round-1 defect: `inListItem` used to read
// `state.schema.nodes[listItemSchema.id]`, but the preset atoms expose `.id === undefined` in this
// module graph (only `.type(ctx)` resolves). 缩进 then never sank an existing list item — it fell
// through to the "wrap into a bullet list" branch and *lifted* the item out instead.
test("indent nests a list item and outdent lifts it back", async () => {
  const s = await mount("- outer\n- second\n", "Indent")
  s.caret("second")
  s.click("Indent")
  await waitFor(() => expect(s.props.context.onChange).toHaveBeenCalled())
  // The second item must still be a list item, nested under the first.
  expect(s.published()).toMatch(/\n\s+[-*]\s+second/)
  s.caret("second")
  s.click("Outdent")
  await waitFor(() => expect(s.published()).not.toMatch(/\n\s+[-*]\s+second/))
  expect(s.published()).toContain("second")
})

test("indent outside a list still produces a visible nesting change", async () => {
  const s = await mount("plain paragraph\n", "Indent")
  s.caret("plain")
  s.click("Indent")
  await waitFor(() => expect(s.props.context.onChange).toHaveBeenCalled())
  // The command wraps into a list first so the button is never a silent no-op.
  expect(s.published()).toMatch(/[-*]\s+plain paragraph/)
})

test("insert table publishes a real Markdown table and enables both delete buttons", async () => {
  const s = await mount("before table\n", "Insert table")
  s.caret("before")
  // Outside a table the deletes must be disabled.
  expect(screen.getByRole("button", { name: "Delete row" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Delete column" })).toBeDisabled()
  s.click("Insert table")
  await waitFor(() => expect(s.props.context.onChange).toHaveBeenCalled())
  const published = s.published()
  expect(published).toContain("|")
  // The GFM serializer writes an aligned delimiter row (`| :- | :- |`).
  expect(published).toMatch(/\|\s*:?-{1,}/)
  // Put the caret in a cell: both deletes light up (TextSelection, not CellSelection).
  const inTable = s.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    let cellText = -1
    view.state.doc.descendants((node, pos) => {
      if (cellText >= 0) return false
      if (node.type.name === "table_cell" || node.type.name === "table_header") {
        cellText = pos + 1
        return false
      }
      return true
    })
    if (cellText < 0) return false
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cellText)))
    return true
  })
  expect(inTable).toBe(true)
  await waitFor(() => expect(screen.getByRole("button", { name: "Delete row" })).not.toBeDisabled())
  expect(screen.getByRole("button", { name: "Delete column" })).not.toBeDisabled()
})

// Regression guard for the QA round-1 defect: `computeFormatState` looked every mark up by
// `xxxSchema.id` (always `undefined` here), so `markActive` was permanently false even though the
// document really carried the mark. The toolbar must report the caret's marks, not just apply them.
test("the toolbar's pressed state tracks the caret's marks", async () => {
  const s = await mount("hello world\n", "Bold")
  s.select("hello", 5)
  s.click("Bold")
  await waitFor(() => expect(s.props.context.onChange).toHaveBeenCalled())
  expect(s.published()).toContain("**hello**")
  await waitFor(() => expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true"))
  // Move the caret outside the bold run: the button must un-press.
  s.caret("world")
  await waitFor(() => expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "false"))
})

// Same root cause as above, for the block-level indicators. One editor per test: two live
// toolbars in document.body make `screen.getByRole` ambiguous.
test("the blockquote button reports its pressed state while the caret is inside a quote", async () => {
  const s = await mount("> quoted line\n", "Blockquote")
  s.caret("quoted")
  await waitFor(() => expect(screen.getByRole("button", { name: "Blockquote" })).toHaveAttribute("aria-pressed", "true"))
  // Lifting out of the quote must un-press it — a stuck indicator is as bad as a dead one.
  s.click("Blockquote")
  await waitFor(() => expect(screen.getByRole("button", { name: "Blockquote" })).toHaveAttribute("aria-pressed", "false"))
})

test("both list buttons report their pressed state while the caret is inside them", async () => {
  const s = await mount("- item text\n", "Bullet list")
  s.caret("item")
  await waitFor(() => expect(screen.getByRole("button", { name: "Bullet list" })).toHaveAttribute("aria-pressed", "true"))
  // The other list kind must stay un-pressed: the indicators cannot both light up.
  expect(screen.getByRole("button", { name: "Numbered list" })).toHaveAttribute("aria-pressed", "false")
  s.click("Bullet list")
  await waitFor(() => expect(screen.getByRole("button", { name: "Bullet list" })).toHaveAttribute("aria-pressed", "false"))
})

test("the numbered-list button reports its pressed state inside an ordered list", async () => {
  const s = await mount("1. item text\n", "Numbered list")
  s.caret("item")
  await waitFor(() => expect(screen.getByRole("button", { name: "Numbered list" })).toHaveAttribute("aria-pressed", "true"))
  expect(screen.getByRole("button", { name: "Bullet list" })).toHaveAttribute("aria-pressed", "false")
})
