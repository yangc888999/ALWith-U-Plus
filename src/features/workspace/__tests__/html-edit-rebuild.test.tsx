/**
 * QA regression: prove the four anti-rebuild layers actually keep the *same* iframe alive across
 * our own save, and that the freeze lifts afterwards.
 *
 * The existing suites assert that `markSelfWrite` / `setEditing` were called and that the write
 * landed, but never that the frame survived — which is the whole point of the feature (a rebuild
 * loses the caret and the native undo stack). The vendor HTML preview rebuilds its iframe whenever
 * `document.savedText` changes, and `controller.reload` after our save changes exactly that, so
 * these tests drive the real provider with the reloaded document and compare iframe identity.
 */
import { createEditorController, type EditorController, type EditorDocument, type PreviewProvider } from "@alwith/module-editor"
import { createPreviewProviders, type PreviewContext, type PreviewHost } from "@alwith/module-editor/previews"
import { createFileSystem, type FileSystem } from "@alwith/module-fs"
import { createMemoryAdapter } from "@alwith/module-fs/testing"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { createWysiwygHtmlIntegration, freezeHtmlSourceDuringEditing } from "../html-wysiwyg"
import { HTML_EDIT_FRAME_SOURCE, HTML_EDIT_HOST_SOURCE, type FormatState, type WysiwygLabels } from "../wysiwyg-types"

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

const SOURCE = "<!DOCTYPE html><html><head><title>R</title></head><body><p>Hello</p></body></html>"
const EDITED = "<!DOCTYPE html><html><head><title>R</title></head><body><p>Hello world</p></body></html>"

const EDITABLE_STATE: FormatState = {
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

interface Harness {
  fs: FileSystem
  controller: EditorController
  provider: PreviewProvider
  context: PreviewContext
  document: EditorDocument
  view: ReturnType<typeof render>
  frame: () => HTMLIFrameElement
  window: () => Window
  sent: Array<{ type: string; editing?: boolean; command?: string }>
  send: (type: string, payload?: Record<string, unknown>, nonceOverride?: string | null) => void
  /** Re-render with the controller's current snapshot of the document (what the app does). */
  rerenderFromController: () => Promise<EditorDocument>
  enterEditing: () => Promise<void>
}

let harness: Harness | null = null

async function setup(): Promise<Harness> {
  const path = "/repo/report.html"
  const fs = createFileSystem({
    adapter: createMemoryAdapter({ [path]: SOURCE, "/repo/style.css": "body{}" }),
    reportError: (error) => {
      throw error
    }
  })
  const controller = createEditorController({ fs, confirmClose: () => Promise.resolve("cancel"), reportError: () => {} })
  const document = await controller.open(path)
  const context: PreviewContext = { readOnly: false, onChange: vi.fn(), onSave: vi.fn(), onError: vi.fn() }

  const markSelfWrite = vi.fn()
  const setEditing = vi.fn()
  const htmlPreview = {
    open: vi.fn(async () => ({ url: "about:blank", dispose: async () => {} })),
    subscribe: vi.fn(async () => () => {}),
    markSelfWrite,
    setEditing
  }
  const host: PreviewHost = {
    pdfWorkerSrc: "worker.js",
    resolveResource: vi.fn(() => Promise.try(() => Promise.reject(new Error("Unexpected resource")))),
    htmlPreview,
    htmlIntegration: createWysiwygHtmlIntegration(undefined, {
      fs,
      controller,
      labels,
      previewControl: { markSelfWrite, setEditing }
    })
  }
  const base = createPreviewProviders(host).find((provider) => provider.id === "html")
  if (!base) throw new Error("Missing HTML provider")
  const provider = freezeHtmlSourceDuringEditing(base, { markSelfWrite, setEditing })

  const view = render(provider.render(document, context))
  await waitFor(() => {
    if (view.container.querySelector("iframe") === null) throw new Error("iframe not mounted")
  })
  const frame = (): HTMLIFrameElement => {
    const element = view.container.querySelector("iframe")
    if (element === null) throw new Error("Missing iframe")
    return element
  }
  const contentWindow = frame().contentWindow
  if (contentWindow === null) throw new Error("Missing contentWindow")

  const sent: Harness["sent"] = []
  let nonce = ""
  vi.spyOn(contentWindow, "postMessage").mockImplementation((message: unknown) => {
    const data = message as { source?: string; type?: string; nonce?: string; editing?: boolean; command?: string }
    if (data.source === HTML_EDIT_HOST_SOURCE && typeof data.type === "string") {
      sent.push({ type: data.type, editing: data.editing, command: data.command })
      if (data.type === "init" && typeof data.nonce === "string" && data.nonce !== "") nonce = data.nonce
    }
  })
  const send = (type: string, payload: Record<string, unknown> = {}, nonceOverride?: string | null): void => {
    const stamped = nonceOverride === undefined ? nonce : nonceOverride
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { source: HTML_EDIT_FRAME_SOURCE, type, nonce: stamped, ...payload }, source: contentWindow })
      )
    })
  }
  const rerenderFromController = async (): Promise<EditorDocument> => {
    const current = controller.getSnapshot().documents.find((candidate) => candidate.path === path)
    if (!current) throw new Error("Missing document in snapshot")
    await act(async () => {
      view.rerender(provider.render(current, context))
    })
    return current
  }
  const enterEditing = async (): Promise<void> => {
    // The spontaneous load announce carries no nonce; that is what makes the host mint one.
    send("ready", { editable: true }, null)
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).not.toBeDisabled())
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    send("mode", { editing: true })
    send("state", { state: EDITABLE_STATE })
    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument())
  }

  harness = {
    fs,
    controller,
    provider,
    context,
    document,
    view,
    frame,
    window: () => contentWindow,
    sent,
    send,
    rerenderFromController,
    enterEditing
  }
  return harness
}

afterEach(() => {
  cleanup()
  harness?.controller.dispose()
  harness = null
  vi.restoreAllMocks()
})

test("our own save keeps the same iframe element and window while editing, and the edit session survives", async () => {
  const h = await setup()
  await h.enterEditing()
  const frameBefore = h.frame()
  const windowBefore = h.frame().contentWindow

  // The real save path: dirty → fs.writeFile → controller.reload (which changes savedText).
  h.send("dirty", { html: EDITED })
  await waitFor(async () => expect(new TextDecoder().decode(await h.fs.readFile("/repo/report.html"))).toBe(EDITED))
  const reloaded = await h.rerenderFromController()
  // The controller really did move the source — this is the fourth rebuild path.
  expect(reloaded.savedText).toBe(EDITED)
  expect(reloaded.savedText).not.toBe(SOURCE)

  // …yet the frame is byte-for-byte the same node and realm: no caret/undo loss.
  expect(h.frame()).toBe(frameBefore)
  expect(h.frame().contentWindow).toBe(windowBefore)
  // Still in edit mode, and the toolbar still works.
  expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Bold" })).not.toBeDisabled()
  expect(h.context.onError).not.toHaveBeenCalled()
})

test("repeated saves during one edit session never rebuild the frame", async () => {
  const h = await setup()
  await h.enterEditing()
  const frameBefore = h.frame()
  const windowBefore = h.frame().contentWindow
  for (const body of ["one", "two", "three"]) {
    const html = EDITED.replace("Hello world", `Hello ${body}`)
    h.send("dirty", { html })
    await waitFor(async () => expect(new TextDecoder().decode(await h.fs.readFile("/repo/report.html"))).toBe(html))
    await h.rerenderFromController()
    expect(h.frame()).toBe(frameBefore)
    expect(h.frame().contentWindow).toBe(windowBefore)
  }
  expect(h.context.onError).not.toHaveBeenCalled()
})

test("leaving edit mode lifts the freeze so the saved source reaches the preview", async () => {
  const h = await setup()
  await h.enterEditing()
  h.send("dirty", { html: EDITED })
  await waitFor(async () => expect(new TextDecoder().decode(await h.fs.readFile("/repo/report.html"))).toBe(EDITED))
  await h.rerenderFromController()
  fireEvent.click(screen.getByRole("button", { name: "Done" }))
  h.send("mode", { editing: false })
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument())
  const afterExit = await h.rerenderFromController()
  expect(afterExit.savedText).toBe(EDITED)
  // The freeze is gone: the preview is now driven by the real saved text again.
  expect(h.sent.some((message) => message.type === "set-mode" && message.editing === false)).toBe(true)
})

// The user-facing promise behind `controller.reload`: after a preview-mode save, switching to
// source mode and saving again must not hit the optimistic lock ("File changed on disk").
test("a source-mode save after a preview save succeeds without an optimistic-lock error", async () => {
  const h = await setup()
  await h.enterEditing()
  h.send("dirty", { html: EDITED })
  await waitFor(async () => expect(new TextDecoder().decode(await h.fs.readFile("/repo/report.html"))).toBe(EDITED))
  const reloaded = await h.rerenderFromController()
  expect(reloaded.dirty).toBe(false)

  // Source mode: edit the reloaded text and save through the controller (the real source path).
  const next = EDITED.replace("Hello world", "Hello source mode")
  await act(async () => {
    h.controller.update(h.document.id, next)
    await h.controller.save(h.document.id)
  })
  expect(new TextDecoder().decode(await h.fs.readFile("/repo/report.html"))).toBe(next)
  const afterSource = h.controller.getSnapshot().documents.find((candidate) => candidate.path === "/repo/report.html")
  expect(afterSource?.dirty).toBe(false)
  expect(afterSource?.externalChange).toBe(false)
  expect(h.context.onError).not.toHaveBeenCalled()
})

// A save that fails must surface an error instead of silently dropping the user's edits, and the
// next edit must still be able to save (the serialized-save guard has to reset).
test("a failed save reports the error and a later edit still saves", async () => {
  const h = await setup()
  await h.enterEditing()
  const statSpy = vi.spyOn(h.fs, "stat").mockResolvedValue(null)
  h.send("dirty", { html: EDITED })
  await waitFor(() => expect(h.context.onError).toHaveBeenCalled())
  statSpy.mockRestore()
  // The guard cleared: a subsequent edit lands on disk.
  h.send("dirty", { html: EDITED.replace("Hello world", "Hello retry") })
  await waitFor(async () =>
    expect(new TextDecoder().decode(await h.fs.readFile("/repo/report.html"))).toContain("Hello retry")
  )
})

test("without an edit session a changed savedText does reach the preview (the freeze is not a permanent block)", async () => {
  const h = await setup()
  const frameBefore = h.frame()
  // Not editing: an external replacement must still refresh the preview.
  await act(async () => {
    await h.fs.writeFile("/repo/report.html", new TextEncoder().encode(EDITED), { mode: "replace" })
    await h.controller.reload(h.document.id)
  })
  const afterExternal = await h.rerenderFromController()
  expect(afterExternal.savedText).toBe(EDITED)
  // The provider re-opened for the new source; the edit-mode guard did not swallow it.
  expect(h.frame()).not.toBe(frameBefore)
})
