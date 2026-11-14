import { createPreviewProviders, type PreviewProps } from "@alwith/module-editor/previews"
import { Editor, editorViewCtx } from "@milkdown/core"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { useMemo, useState } from "react"
import { afterEach, expect, test, vi } from "vitest"

import { createWysiwygMarkdownIntegration } from "../markdown-wysiwyg"
import type { WysiwygLabels } from "../wysiwyg-types"

const wysiwygLabels: WysiwygLabels = {
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
      resolveResource: vi.fn(() => {
        return Promise.try(() => {
          throw new Error("Unexpected resource")
        })
      })
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
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test("Markdown outline lives in the header popover and closes after jumping to a heading", async () => {
  const scroll = vi.fn()
  HTMLElement.prototype.scrollIntoView = scroll
  const props = fixture("# First\n\n## Second\n")
  const view = render(<Workbench props={props} />)
  // Milkdown loads asynchronously; allow the full-suite worker contention without weakening the rendered-heading assertion.
  await screen.findByRole("heading", { name: "First" }, { timeout: 5000 })
  expect(screen.queryByRole("button", { name: "Bold" })).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Second" })).not.toBeInTheDocument()
  const outline = await screen.findByRole("button", { name: "Document outline" })
  expect(outline.closest("header")).not.toBeNull()
  fireEvent.click(outline)
  fireEvent.click(await screen.findByRole("button", { name: "Second" }))
  expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "smooth" })
  await waitFor(() => expect(screen.queryByRole("button", { name: "Second" })).not.toBeInTheDocument())
  expect(view.container.querySelector(".alwith-preview-outline")).toBeNull()
  expect(props.context.onChange).not.toHaveBeenCalled()
})

test("large UTF-8 Markdown is read-only until the pencil explicitly mounts Milkdown", async () => {
  const make = vi.spyOn(Editor, "make")
  const props = fixture(`# Large\n\n${"文".repeat(350_000)}`)
  const view = render(<Workbench props={props} />)
  await screen.findByRole("heading", { name: "Large" })
  expect(make).not.toHaveBeenCalled()
  expect(view.container.querySelector(".ProseMirror") === null).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown" }))
  await waitFor(() => expect(view.container.querySelector(".ProseMirror")).toHaveAttribute("contenteditable", "true"))
  expect(make).toHaveBeenCalledTimes(1)
  expect(props.context.onChange).not.toHaveBeenCalled()
}, 15000)

test("Markdown math renders through KaTeX and real edits still publish and save", async () => {
  let editor: Editor | undefined
  const make = Editor.make.bind(Editor)
  vi.spyOn(Editor, "make").mockImplementation(() => {
    editor = make()
    return editor
  })
  const props = fixture("# Formula\n\nInline $x^2$\n\n$$\nx^2 + y^2 = z^2\n$$\n")
  const view = render(<Workbench props={props} />)
  await waitFor(() => expect(view.container.querySelector(".katex")).not.toBeNull())
  expect(props.context.onChange).not.toHaveBeenCalled()
  act(() => {
    if (!editor) throw new Error("Missing editor")
    editor.action((ctx) => {
      const v = ctx.get(editorViewCtx)
      v.dispatch(v.state.tr.insertText("Edited ", 1))
    })
  })
  expect(props.context.onChange).toHaveBeenCalledWith(expect.stringContaining("Edited Formula"))
  fireEvent.keyDown(screen.getByRole("textbox", { name: props.document.path }), { key: "s", metaKey: true })
  expect(props.context.onSave).toHaveBeenCalledTimes(1)
  expect(props.context.onError).not.toHaveBeenCalled()
})

test("Drive integration keeps configuration, read-only state, serialization and disposal", async () => {
  let editor: Editor | undefined
  const integration = {
    configure: vi.fn((value: Editor) => {
      editor = value
    }),
    ready: vi.fn(async () => {}),
    dispose: vi.fn(),
    editable: () => true,
    serialize: (text: string) => `---\ntitle: Preserved\n---\n${text}`,
    applyExternal: vi.fn(() => false),
    render: () => <aside>Drive comments</aside>
  }
  const props = fixture("# Drive\n")
  props.host.createMarkdownIntegration = () => integration
  const view = render(<Workbench props={props} />)
  await waitFor(() => expect(integration.ready).toHaveBeenCalledTimes(1))
  expect(screen.getByText("Drive comments")).toBeInTheDocument()
  act(() => {
    if (!editor) throw new Error("Missing editor")
    editor.action((ctx) => {
      const v = ctx.get(editorViewCtx)
      v.dispatch(v.state.tr.insertText("Edited ", 1))
    })
  })
  expect(props.context.onChange).toHaveBeenCalledWith(
    expect.stringMatching(/^---\ntitle: Preserved\n---\n# Edited Drive/)
  )
  integration.applyExternal.mockClear()
  view.rerender(
    <Workbench
      props={{
        ...props,
        document: { ...props.document, text: "# External\n" },
        context: { ...props.context, readOnly: true }
      }}
    />
  )
  expect(integration.applyExternal).toHaveBeenCalledTimes(1)
  expect(view.container.querySelector(".ProseMirror")).toHaveAttribute("contenteditable", "false")
  expect(screen.getByRole("heading", { name: "External" })).toBeInTheDocument()
  expect(props.context.onChange).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(integration.dispose).toHaveBeenCalledTimes(1)
})

test("Markdown image resolution never writes object URLs into the Markdown and links use the host", async () => {
  let editor: Editor | undefined
  const make = Editor.make.bind(Editor)
  vi.spyOn(Editor, "make").mockImplementation(() => {
    editor = make()
    return editor
  })
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:resolved-image")
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  const props = fixture("# Images\n\n![Local](assets/pic.png)\n\n[Website](https://example.com)\n")
  props.host.resolveResource = vi.fn(() =>
    Promise.try(() => ({
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      path: "/repo/assets/pic.png"
    }))
  )
  props.host.openLink = vi.fn(async () => {})
  const view = render(<Workbench props={props} />)
  await waitFor(() => expect(screen.getByAltText("Local")).toHaveAttribute("src", "blob:resolved-image"))
  expect(create).toHaveBeenCalledTimes(1)
  expect(props.host.resolveResource).toHaveBeenCalledWith("/repo/notes.md", "assets/pic.png")
  fireEvent.click(screen.getByRole("link", { name: "Website" }))
  expect(props.host.openLink).toHaveBeenCalledWith("https://example.com")
  act(() => {
    if (!editor) throw new Error("Missing editor")
    editor.action((ctx) => {
      const v = ctx.get(editorViewCtx)
      v.dispatch(v.state.tr.insertText("Edited ", 1))
    })
  })
  expect(props.context.onChange).toHaveBeenCalledWith(expect.stringContaining("assets/pic.png"))
  expect(props.context.onChange).not.toHaveBeenCalledWith(expect.stringContaining("blob:"))
  view.unmount()
  expect(revoke).toHaveBeenCalledWith("blob:resolved-image")
})

test("large preview sanitizes HTML, renders formulas and leaves persisted text untouched", async () => {
  const props = fixture(
    `# Safe\n\n$x^2$\n\n<script>window.bad=true</script>\n<img src="https://example.com/a.png" onerror="window.bad=true">\n\n${"a".repeat(1024 * 1024)}`
  )
  const view = render(<Workbench props={props} />)
  await screen.findByRole("heading", { name: "Safe" })
  expect(view.container.querySelector("script")).toBeNull()
  expect(view.container.querySelector("[onerror]")).toBeNull()
  expect(view.container.querySelector(".katex")).not.toBeNull()
  expect(view.container.querySelector('img[src^="https:"]')).toBeNull()
  expect(props.context.onChange).not.toHaveBeenCalled()
  expect(props.context.onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("blocked") as string }) as Error
  )
})

test("legacy Plate snapshots are stripped from preview while actual Markdown stays authoritative", async () => {
  const props = fixture(
    '<!-- plate-metadata: {"stale":"old content"} -->\n\n# Current text\n\n<!-- plate-metadata: {"stale":"another snapshot"} -->'
  )
  const view = render(<Workbench props={props} />)
  await screen.findByRole("heading", { name: "Current text" })
  expect(view.container.textContent).not.toContain("plate-metadata")
  expect(props.context.onChange).not.toHaveBeenCalled()
})

test("readonly code blocks preserve raw copy text, line numbers and wrap controls", async () => {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  const props = fixture(`\`\`\`text\nfirst line\nsecond line\n\`\`\`\n\n${"a".repeat(1024 * 1024)}`)
  const view = render(<Workbench props={props} />)
  const copy = await screen.findByRole("button", { name: "Copy code" })
  expect(view.container.querySelectorAll(".alwith-markdown-line-number")).toHaveLength(2)
  fireEvent.click(copy)
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("first line\nsecond line\n"))
  const wrap = screen.getByRole("button", { name: "Toggle line wrapping" })
  fireEvent.click(wrap)
  expect(wrap).toHaveAttribute("aria-pressed", "true")
  expect(view.container.querySelector(".alwith-markdown-code-block")).toHaveAttribute("data-wrap", "true")
})

test("WYSIWYG toolbar coexists with the outline: the toolbar survives the outline's revision", async () => {
  const props = fixture("# First\n\n## Second\n")
  props.host.createMarkdownIntegration = (_document, context) =>
    createWysiwygMarkdownIntegration(undefined, context, wysiwygLabels)
  const view = render(<Workbench props={props} />)
  await screen.findByRole("heading", { name: "First" }, { timeout: 5000 })
  // The outline owns the header slot; the toolbar renders in the preview body, not the header.
  const outline = await screen.findByRole("button", { name: "Document outline" })
  expect(outline.closest("header")).not.toBeNull()
  const toolbar = view.container.querySelector(".alwith-wysiwyg-toolbar")
  expect(toolbar).not.toBeNull()
  expect(toolbar?.closest("header")).toBeNull()
  expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument()
  // Wait past the 800ms MutationObserver revision that re-claims setToolbarActions.
  await new Promise((resolve) => setTimeout(resolve, 1100))
  expect(view.container.querySelector(".alwith-wysiwyg-toolbar")).not.toBeNull()
  expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument()
  // The outline still works after the revision.
  fireEvent.click(screen.getByRole("button", { name: "Document outline" }))
  expect(await screen.findByRole("button", { name: "Second" })).toBeInTheDocument()
}, 15000)

test("Drive + WYSIWYG double wrapping keeps the Drive surface, frontmatter and the toolbar", async () => {
  const base = {
    configure: vi.fn(),
    ready: vi.fn(async () => {}),
    dispose: vi.fn(),
    editable: vi.fn(() => true),
    serialize: vi.fn((text: string) => `---\ntitle: Preserved\n---\n${text}`),
    applyExternal: vi.fn(() => false),
    render: vi.fn(() => <aside>Drive comments</aside>)
  }
  const props = fixture("# Drive\n")
  props.host.createMarkdownIntegration = (_document, context) =>
    createWysiwygMarkdownIntegration(base, context, wysiwygLabels)
  const view = render(<Workbench props={props} />)
  await screen.findByRole("heading", { name: "Drive" }, { timeout: 5000 })
  expect(screen.getByText("Drive comments")).toBeInTheDocument()
  expect(view.container.querySelector(".alwith-wysiwyg-toolbar")).not.toBeNull()
  expect(screen.getByRole("button", { name: "Underline" })).toBeInTheDocument()
  expect(base.configure).toHaveBeenCalledTimes(1)
  expect(base.ready).toHaveBeenCalledTimes(1)
  // Editing still flows through the Drive serializer (frontmatter preserved). The wrapped editor
  // is the one the provider created and passed to configure.
  const editor = base.configure.mock.calls[0]?.[0] as Editor | undefined
  if (!editor) throw new Error("Missing configured editor")
  act(() => {
    editor.action((ctx) => {
      const v = ctx.get(editorViewCtx)
      v.dispatch(v.state.tr.insertText("Edited ", 1))
    })
  })
  await waitFor(() =>
    expect(props.context.onChange).toHaveBeenCalledWith(expect.stringMatching(/^---\ntitle: Preserved\n---\n# Edited Drive/))
  )
  view.unmount()
  expect(base.dispose).toHaveBeenCalledTimes(1)
})
