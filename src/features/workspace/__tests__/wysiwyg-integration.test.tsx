/**
 * End-to-end WYSIWYG integration: the real localPreviewProviders chain (Markdown + HTML) with the
 * WYSIWYG wrappers layered on top, a memory filesystem and a real editor controller. Verifies the
 * two surfaces compose with the host's providers and that edits round-trip to disk.
 */
import { createEditorController, type EditorController, type EditorDocument, type PreviewProvider } from "@alwith/module-editor"
import type { PreviewContext, PreviewHost } from "@alwith/module-editor/previews"
import { createFileSystem, type FileSystem } from "@alwith/module-fs"
import { createMemoryAdapter } from "@alwith/module-fs/testing"
import { Editor, editorViewCtx } from "@milkdown/core"
import { TextSelection } from "@milkdown/prose/state"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { createWysiwygHtmlIntegration, freezeHtmlSourceDuringEditing } from "../html-wysiwyg"
import { HTML_EDIT_FRAME_SOURCE, type FormatState, type WysiwygLabels } from "../wysiwyg-types"
import { localPreviewProviders } from "../local-previews"
import { createWysiwygMarkdownIntegration } from "../markdown-wysiwyg"

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

const FULL_STATE: FormatState = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  blockquote: false,
  ul: false,
  ol: false,
  code: false,
  codeBlock: false,
  inTable: false,
  hasImage: false,
  canEdit: true
}

interface World {
  fs: FileSystem
  controller: EditorController
  providers: PreviewProvider[]
  context: PreviewContext
  opened: Map<string, EditorDocument>
}

const worlds: World[] = []

function providerFor(world: World, id: string): PreviewProvider {
  const provider = world.providers.find((candidate) => candidate.id === id)
  if (!provider) throw new Error(`Missing provider: ${id}`)
  return provider
}

/**
 * Build the real provider chain exactly as file-workspace does: Drive-style base integrations are
 * absent here, the WYSIWYG wrappers layer directly on the module defaults, and the HTML provider
 * is wrapped with the source freeze.
 */
async function world(files: Record<string, string>): Promise<World> {
  const fs = createFileSystem({ adapter: createMemoryAdapter(files), reportError: (error) => { throw error } })
  const controller = createEditorController({ fs, confirmClose: () => Promise.resolve("cancel"), reportError: () => {} })
  const context: PreviewContext = { readOnly: false, onChange: vi.fn(), onSave: vi.fn(), onError: vi.fn() }
  const htmlPreview = {
    open: vi.fn(async () => ({ url: "about:blank", dispose: async () => {} })),
    subscribe: vi.fn(async () => () => {}),
    markSelfWrite: vi.fn(),
    setEditing: vi.fn()
  }
  const host: Omit<PreviewHost, "pdfWorkerSrc" | "parseSpreadsheet"> = {
    htmlPreview,
    createMarkdownIntegration: (_document, ctx) => createWysiwygMarkdownIntegration(undefined, ctx, labels),
    htmlIntegration: createWysiwygHtmlIntegration(undefined, {
      fs,
      controller,
      labels,
      previewControl: { markSelfWrite: htmlPreview.markSelfWrite, setEditing: htmlPreview.setEditing }
    }),
    resolveResource: vi.fn(() => Promise.try(() => Promise.reject(new Error("Unexpected resource")))),
    autoSaveDelay: 800
  }
  const providers = localPreviewProviders(host).map((provider) =>
    provider.id === "html" ? freezeHtmlSourceDuringEditing(provider, htmlPreview) : provider
  )
  const opened = new Map<string, EditorDocument>()
  for (const path of Object.keys(files)) {
    opened.set(path, await controller.open(path))
  }
  const result: World = { fs, controller, providers, context, opened }
  worlds.push(result)
  return result
}

afterEach(() => {
  cleanup()
  for (const world of worlds) world.controller.dispose()
  worlds.length = 0
  vi.restoreAllMocks()
})

beforeEach(() => {
  // jsdom has no layout engine: ProseMirror's scrollIntoView calls getClientRects on text nodes.
  const empty = (): DOMRect => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) })
  Element.prototype.getClientRects = function getClientRects(): DOMRectList {
    return Object.assign([empty()], { item: (index: number) => (index === 0 ? empty() : null) }) as unknown as DOMRectList
  }
  Range.prototype.getClientRects = Element.prototype.getClientRects as never
  Range.prototype.getBoundingClientRect = empty
})

test("Markdown: the real provider chain mounts the toolbar and a bold edit round-trips to disk", async () => {
  const w = await world({ "/repo/notes.md": "hello world\n" })
  const document = w.opened.get("/repo/notes.md")
  if (!document) throw new Error("Missing document")
  // Capture the live Milkdown editor the provider creates.
  let editor: Editor | undefined
  const make = Editor.make.bind(Editor)
  vi.spyOn(Editor, "make").mockImplementation(() => {
    editor = make()
    return editor
  })
  // The real autosave path: onChange updates the controller, onSave writes to disk.
  const context: PreviewContext = {
    readOnly: false,
    onChange: vi.fn((text: string) => w.controller.update(document.id, text)),
    onSave: vi.fn(() => void w.controller.save(document.id)),
    onError: vi.fn()
  }
  const provider = providerFor(w, "markdown")
  const view = render(provider.render(document, context))
  await screen.findByRole("button", { name: "Bold" }, { timeout: 5000 })
  expect(view.container.querySelector(".alwith-wysiwyg-toolbar")).not.toBeNull()
  if (!editor) throw new Error("Missing editor")
  const live = editor
  // Select "hello" and bold it through the toolbar.
  act(() => {
    live.action((ctx) => {
      const v = ctx.get(editorViewCtx)
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, 6)))
    })
  })
  fireEvent.click(screen.getByRole("button", { name: "Bold" }))
  await waitFor(() => expect(context.onChange).toHaveBeenCalled())
  expect(context.onChange).toHaveBeenLastCalledWith(expect.stringContaining("**hello**"))
  // Let the module's autosave flush to disk through the real controller.
  await waitFor(async () => expect(new TextDecoder().decode(await w.fs.readFile("/repo/notes.md"))).toContain("**hello**"), { timeout: 5000 })
  view.unmount()
})

test("HTML: the real provider chain renders the toolbar, enters edit mode and saves to disk", async () => {
  const source = "<!DOCTYPE html><html><head><title>R</title></head><body><p>Hello</p></body></html>"
  const w = await world({ "/repo/report.html": source })
  const document = w.opened.get("/repo/report.html")
  if (!document) throw new Error("Missing document")
  const provider = providerFor(w, "html")
  const view = render(provider.render(document, w.context))
  await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull())
  const iframe = view.container.querySelector("iframe")
  if (!iframe?.contentWindow) throw new Error("Missing iframe")
  const contentWindow = iframe.contentWindow

  // Capture host→frame messages.
  const sent: Array<{ type: string; nonce?: string; editing?: boolean }> = []
  let nonce = ""
  vi.spyOn(contentWindow, "postMessage").mockImplementation((message: unknown) => {
    const data = message as { type?: string; nonce?: string; editing?: boolean; source?: string }
    if (typeof data.type === "string") {
      sent.push({ type: data.type, nonce: data.nonce, editing: data.editing })
      if (data.type === "init" && data.nonce) nonce = data.nonce
    }
  })
  const send = (type: string, payload: Record<string, unknown> = {}, override?: string | null): void => {
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: HTML_EDIT_FRAME_SOURCE, type, nonce: override === undefined ? nonce : override, ...payload },
          source: contentWindow
        })
      )
    })
  }

  // Handshake: the bridge announces readiness, the host mints a nonce.
  send("ready", { editable: true }, null)
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).not.toBeDisabled())
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  await waitFor(() => expect(sent.some((m) => m.type === "set-mode" && m.editing === true)).toBe(true))
  send("mode", { editing: true })
  send("state", { state: FULL_STATE })
  await waitFor(() => expect(screen.getByRole("button", { name: "Bold" })).not.toBeDisabled())

  // Edit and report dirty; the save must land on disk through the real controller.
  const edited = "<!DOCTYPE html><html><head><title>R</title></head><body><p>Hello world</p></body></html>"
  const writeSpy = vi.spyOn(w.fs, "writeFile")
  send("dirty", { html: edited })
  await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1))
  await waitFor(async () => expect(new TextDecoder().decode(await w.fs.readFile("/repo/report.html"))).toBe(edited))
  // The controller's version is current, so a source-mode save would not hit the optimistic lock.
  const reloaded = w.controller.getSnapshot().documents.find((d) => d.path === "/repo/report.html")
  expect(reloaded?.savedText).toBe(edited)
  expect(reloaded?.dirty).toBe(false)
  view.unmount()
})
