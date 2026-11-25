import {
  createEditorController,
  type EditorController,
  type EditorDocument,
  type PreviewProvider
} from "@alwith/module-editor"
import { createPreviewProviders, type PreviewContext, type PreviewHost } from "@alwith/module-editor/previews"
import { createFileSystem, type FileSystem } from "@alwith/module-fs"
import { createMemoryAdapter } from "@alwith/module-fs/testing"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { HTML_EDIT_BRIDGE_ID } from "../html-edit-bridge"
import {
  createWysiwygHtmlIntegration,
  freezeHtmlSourceDuringEditing,
  isEditableHtmlPath,
  sourceHasBody
} from "../html-wysiwyg"
import { type FormatState, HTML_EDIT_FRAME_SOURCE, HTML_EDIT_HOST_SOURCE, type WysiwygLabels } from "../wysiwyg-types"

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

const SOURCE = "<!DOCTYPE html><html><head><title>Report</title></head><body><p>Hello</p></body></html>"

interface Harness {
  fs: FileSystem
  controller: EditorController
  document: EditorDocument
  context: PreviewContext
  provider: PreviewProvider
  markSelfWrite: ReturnType<typeof vi.fn>
  setEditing: ReturnType<typeof vi.fn>
  /** The live iframe the provider rendered (about:blank). */
  frame: () => HTMLIFrameElement
  /** Outgoing host→frame messages captured from the iframe's postMessage. */
  sent: Array<{ type: string; nonce?: string; editing?: boolean; command?: string }>
  /** Simulate a frame→host message with the current handshake nonce. */
  send: (type: string, payload?: Record<string, unknown>, nonceOverride?: string | null) => void
  /** The nonce the host minted (captured from the init message). */
  nonce: () => string
  /** The transformed source the native host was asked to open. */
  openedSource: () => string
}

let harness: Harness | null = null

function contextFixture(overrides: Partial<PreviewContext> = {}): PreviewContext {
  return { readOnly: false, onChange: vi.fn(), onSave: vi.fn(), onError: vi.fn(), ...overrides }
}

/**
 * Build the full provider chain (freeze wrapper → real HTML provider → WYSIWYG integration) over
 * a memory filesystem and a real editor controller, with a fake native host that serves an
 * about:blank iframe so the bridge protocol can be simulated with real MessageEvents.
 */
async function setup(
  options: {
    path?: string
    source?: string
    readOnly?: boolean
    dirty?: boolean
    base?: PreviewHost["htmlIntegration"]
  } = {}
): Promise<Harness> {
  const path = options.path ?? "/repo/report.html"
  const source = options.source ?? SOURCE
  const fs = createFileSystem({
    adapter: createMemoryAdapter({ [path]: source }),
    reportError: (error) => {
      throw error
    }
  })
  const controller = createEditorController({
    fs,
    confirmClose: () => Promise.resolve("cancel"),
    reportError: () => {}
  })
  const opened = await controller.open(path)
  const document: EditorDocument = options.dirty
    ? { ...opened, dirty: true, text: `${source}<!-- unsaved -->` }
    : opened
  const context = contextFixture({ readOnly: options.readOnly ?? false })

  const markSelfWrite = vi.fn()
  const setEditing = vi.fn()
  let openedSource = ""
  const htmlPreview = {
    open: vi.fn(async (_path: string, source: string) => {
      openedSource = source
      return { url: "about:blank", dispose: async () => {} }
    }),
    subscribe: vi.fn(async () => () => {}),
    markSelfWrite,
    setEditing
  }
  const integration = createWysiwygHtmlIntegration(options.base, {
    fs,
    controller,
    labels,
    previewControl: { markSelfWrite, setEditing }
  })
  const host: PreviewHost = {
    pdfWorkerSrc: "worker.js",
    resolveResource: vi.fn(() => Promise.try(() => Promise.reject(new Error("Unexpected resource")))),
    htmlPreview,
    htmlIntegration: integration
  }
  const baseProvider = createPreviewProviders(host).find((provider) => provider.id === "html")
  if (!baseProvider) throw new Error("Missing HTML provider")
  const provider = freezeHtmlSourceDuringEditing(baseProvider, { markSelfWrite, setEditing })

  const sent: Harness["sent"] = []
  let frameEl: HTMLIFrameElement | null = null
  let capturedNonce = ""

  const view = render(provider.render(document, context))
  await waitFor(() => {
    const iframe = view.container.querySelector("iframe")
    if (iframe === null) throw new Error("iframe not mounted yet")
    frameEl = iframe
  })
  const frame = (): HTMLIFrameElement => {
    if (frameEl === null) throw new Error("Missing frame")
    return frameEl
  }
  // Capture everything the host posts into the frame.
  const contentWindow = frame().contentWindow
  if (contentWindow === null) throw new Error("Missing contentWindow")
  vi.spyOn(contentWindow, "postMessage").mockImplementation((message: unknown) => {
    const data = message as { type?: string; nonce?: string; editing?: boolean; command?: string; source?: string }
    if (data.source === HTML_EDIT_HOST_SOURCE && typeof data.type === "string") {
      sent.push({ type: data.type, nonce: data.nonce, editing: data.editing, command: data.command })
      if (data.type === "init" && typeof data.nonce === "string" && data.nonce !== "") capturedNonce = data.nonce
    }
  })

  const send = (type: string, payload: Record<string, unknown> = {}, nonceOverride?: string | null): void => {
    const nonce = nonceOverride === undefined ? capturedNonce : nonceOverride
    const data = { source: HTML_EDIT_FRAME_SOURCE, type, nonce, ...payload }
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source: contentWindow }))
    })
  }

  // The bridge announces readiness on load (no nonce). The host then mints one and sends init.
  send("ready", { editable: true }, null)

  harness = {
    fs,
    controller,
    document,
    context,
    provider,
    markSelfWrite,
    setEditing,
    frame,
    sent,
    send,
    nonce: () => capturedNonce,
    openedSource: () => openedSource
  }
  return harness
}

beforeEach(() => {
  // jsdom does not implement execCommand; the bridge's DOM fallbacks are exercised elsewhere.
  Document.prototype.execCommand = vi.fn(() => false)
  Document.prototype.queryCommandState = vi.fn(() => false)
})

afterEach(() => {
  cleanup()
  harness?.controller.dispose()
  harness = null
  vi.restoreAllMocks()
})

test("isEditableHtmlPath accepts .html/.htm and rejects .xhtml and others", () => {
  expect(isEditableHtmlPath("/a/b.html")).toBe(true)
  expect(isEditableHtmlPath("/a/b.HTM")).toBe(true)
  expect(isEditableHtmlPath("/a/b.xhtml")).toBe(false)
  expect(isEditableHtmlPath("/a/b.md")).toBe(false)
})

test("sourceHasBody distinguishes a declared body from a synthesized fragment body", () => {
  expect(sourceHasBody("<!DOCTYPE html><html><body><p>x</p></body></html>")).toBe(true)
  expect(sourceHasBody("<html><head></head><body>x</body></html>")).toBe(true)
  expect(sourceHasBody("<p>fragment</p>")).toBe(false)
  expect(sourceHasBody("<div>no body tag</div>")).toBe(false)
})

test("a fragment source without a declared body cannot enter edit mode", async () => {
  const h = await setup({ source: "<p>just a fragment</p>" })
  // The bridge still reports a (synthesized) body, but the source-level check blocks editing.
  expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  expect(h.sent.some((m) => m.type === "set-mode" && m.editing === true)).toBe(false)
})

test("transform appends the resident edit bridge after the base transform", async () => {
  const base: NonNullable<PreviewHost["htmlIntegration"]> = {
    transform: (source) => `${source}<!-- drive -->`,
    render: () => null
  }
  const fs = createFileSystem({ adapter: createMemoryAdapter({}), reportError: () => {} })
  const controller = createEditorController({
    fs,
    confirmClose: () => Promise.resolve("cancel"),
    reportError: () => {}
  })
  const integration = createWysiwygHtmlIntegration(base, {
    fs,
    controller,
    labels,
    previewControl: { markSelfWrite: vi.fn(), setEditing: vi.fn() }
  })
  const out = integration.transform("<p>x</p>", "/repo/a.html")
  expect(out).toContain("<!-- drive -->")
  expect(out).toContain(`id="${HTML_EDIT_BRIDGE_ID}"`)
  expect(out.indexOf("<!-- drive -->")).toBeLessThan(out.indexOf(HTML_EDIT_BRIDGE_ID))
  controller.dispose()
})

test("default state is read-only: Edit is offered, format buttons are disabled, no edit mode is requested", async () => {
  const h = await setup()
  const edit = screen.getByRole("button", { name: "Edit" })
  expect(edit).not.toBeDisabled()
  expect(screen.getByRole("button", { name: "Bold" })).toBeDisabled()
  // No set-mode true has been sent: the frame stays non-editable until the user opts in.
  expect(h.sent.some((message) => message.type === "set-mode" && message.editing === true)).toBe(false)
})

test("entering edit mode sends set-mode true and enables the format buttons once the frame confirms", async () => {
  const h = await setup()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  await waitFor(() => expect(h.sent.some((m) => m.type === "set-mode" && m.editing === true)).toBe(true))
  // The frame confirms the mode and reports an editable format state.
  h.send("mode", { editing: true })
  h.send("state", {
    state: {
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
    } satisfies FormatState
  })
  await waitFor(() => expect(screen.getByRole("button", { name: "Bold" })).not.toBeDisabled())
  expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument()
  // The native host is told to suspend rebuilds for this path.
  expect(h.setEditing).toHaveBeenCalledWith(h.document.path, true)
})

test("a format command is posted to the frame with the handshake nonce", async () => {
  const h = await setup()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  h.send("mode", { editing: true })
  h.send("state", {
    state: {
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
    } satisfies FormatState
  })
  await waitFor(() => expect(screen.getByRole("button", { name: "Bold" })).not.toBeDisabled())
  fireEvent.click(screen.getByRole("button", { name: "Bold" }))
  const command = h.sent.find((m) => m.type === "command")
  expect(command?.command).toBe("bold")
  expect(command?.nonce).toBe(h.nonce())
})

test("a dirty report saves through fs.writeFile with replace + expectedVersion, then reloads the controller", async () => {
  const h = await setup()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  h.send("mode", { editing: true })
  const writeSpy = vi.spyOn(h.fs, "writeFile")
  const reloadSpy = vi.spyOn(h.controller, "reload")
  const edited = "<!DOCTYPE html><html><head><title>Report</title></head><body><p>Hello world</p></body></html>"
  h.send("dirty", { html: edited })
  await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1))
  const [path, bytes, writeOptions] = writeSpy.mock.calls[0]
  expect(path).toBe(h.document.path)
  expect(new TextDecoder().decode(bytes)).toBe(edited)
  expect(writeOptions).toMatchObject({ mode: "replace" })
  expect(typeof writeOptions?.expectedVersion).toBe("string")
  expect(h.markSelfWrite).toHaveBeenCalledWith(h.document.path)
  await waitFor(() => expect(reloadSpy).toHaveBeenCalledWith(h.document.id))
})

test("a stable read retries through a version change instead of reporting a save failure", async () => {
  const h = await setup()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  h.send("mode", { editing: true })
  const originalStat = h.fs.stat.bind(h.fs)
  let pathStats = 0
  vi.spyOn(h.fs, "stat").mockImplementation(async (path) => {
    const result = await originalStat(path)
    if (path !== h.document.path) return result
    pathStats += 1
    return pathStats === 2 && result !== null ? { ...result, version: `torn-${result.version}` } : result
  })
  const writeSpy = vi.spyOn(h.fs, "writeFile")
  const edited = "<!DOCTYPE html><html><head><title>Report</title></head><body><p>Stable</p></body></html>"
  h.send("dirty", { html: edited })
  await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1))
  expect(h.context.onError).not.toHaveBeenCalled()
})

test("an identical body adopts the newer version without rewriting the file", async () => {
  const h = await setup()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  h.send("mode", { editing: true })
  const edited = "<!DOCTYPE html><html><head><title>Report</title></head><body><p>Same</p></body></html>"
  await h.fs.writeFile(h.document.path, new TextEncoder().encode(edited), { mode: "replace" })
  const writeSpy = vi.spyOn(h.fs, "writeFile")
  const reloadSpy = vi.spyOn(h.controller, "reload")
  h.send("dirty", { html: edited })
  await waitFor(() => expect(reloadSpy).toHaveBeenCalledWith(h.document.id))
  expect(writeSpy).not.toHaveBeenCalled()
  expect(h.context.onError).not.toHaveBeenCalled()
})

test("a real concurrent body change keeps both versions and never overwrites", async () => {
  const h = await setup()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  h.send("mode", { editing: true })
  const disk = "<!DOCTYPE html><html><head><title>Report</title></head><body><p>Cloud edit</p></body></html>"
  const local = "<!DOCTYPE html><html><head><title>Report</title></head><body><p>Local edit</p></body></html>"
  await h.fs.writeFile(h.document.path, new TextEncoder().encode(disk), { mode: "replace" })
  const writeSpy = vi.spyOn(h.fs, "writeFile")
  h.send("dirty", { html: local })
  const conflict = await screen.findByTestId("html-save-conflict")
  expect(within(conflict).getByText(local)).toBeInTheDocument()
  expect(within(conflict).getByText(disk)).toBeInTheDocument()
  expect(writeSpy).not.toHaveBeenCalled()
  expect(h.context.onError).not.toHaveBeenCalled()
})

test("a preview refresh race after a successful write does not surface as a save error", async () => {
  const h = await setup()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  h.send("mode", { editing: true })
  const reloadSpy = vi
    .spyOn(h.controller, "reload")
    .mockRejectedValue(new Error("File changed while opening; reopen it"))
  const writeSpy = vi.spyOn(h.fs, "writeFile")
  const edited = "<!DOCTYPE html><html><head><title>Report</title></head><body><p>Saved once</p></body></html>"
  h.send("dirty", { html: edited })
  await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(3))
  expect(h.context.onError).not.toHaveBeenCalled()
})

test("finishing edit mode flushes before leaving, and replays the held rebuild on exit", async () => {
  const h = await setup()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  h.send("mode", { editing: true })
  await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument())
  fireEvent.click(screen.getByRole("button", { name: "Done" }))
  // Flush is sent first.
  await waitFor(() => expect(h.sent.some((m) => m.type === "flush")).toBe(true))
  // The frame replies dirty (saved) then confirms the mode change.
  h.send("dirty", { html: SOURCE })
  h.send("mode", { editing: false })
  await waitFor(() => expect(h.sent.some((m) => m.type === "set-mode" && m.editing === false)).toBe(true))
  const flushIndex = h.sent.findIndex((m) => m.type === "flush")
  const exitIndex = h.sent.findIndex((m) => m.type === "set-mode" && m.editing === false)
  expect(flushIndex).toBeLessThan(exitIndex)
  await waitFor(() => expect(h.setEditing).toHaveBeenCalledWith(h.document.path, false))
})

test("messages from another window or with a stale nonce are ignored", async () => {
  const h = await setup()
  const writeSpy = vi.spyOn(h.fs, "writeFile")
  // Wrong source window: a different window object entirely.
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: HTML_EDIT_FRAME_SOURCE, type: "dirty", nonce: h.nonce(), html: "<p>evil</p>" },
        source: window
      })
    )
  })
  // Stale nonce from the right window.
  h.send("dirty", { html: "<p>stale</p>" }, "not-the-nonce")
  // Wrong source constant.
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "alwith-preview", type: "dirty", nonce: h.nonce(), html: "<p>nope</p>" },
        source: h.frame().contentWindow
      })
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(writeSpy).not.toHaveBeenCalled()
})

test("the edit button is disabled for readOnly, dirty source, and non-.html documents", async () => {
  const readOnly = await setup({ readOnly: true })
  expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled()
  cleanup()
  readOnly.controller.dispose()

  const dirty = await setup({ dirty: true })
  expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled()
  cleanup()
  dirty.controller.dispose()

  const fragment = await setup({ path: "/repo/page.xhtml" })
  expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled()
  cleanup()
  fragment.controller.dispose()
})

test("a fragment document without a body cannot enter edit mode", async () => {
  const h = await setup()
  // Re-announce readiness with editable:false (the bridge reports no <body>).
  h.send("ready", { editable: false }, null)
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled())
})

test("Drive base integration: transform and render are both composed with the toolbar", async () => {
  const base: NonNullable<PreviewHost["htmlIntegration"]> = {
    transform: (source) => `${source}<script>window.__driveComment=true</script>`,
    render: () => <aside data-testid="drive-surface">Drive comments</aside>
  }
  const h = await setup({ base })
  // The base render node and the toolbar both live in the preview.
  expect(screen.getByTestId("drive-surface")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument()
  // The opened source carries both the drive bridge and our edit bridge, in that order.
  const opened = h.openedSource()
  expect(opened).toContain("__driveComment")
  expect(opened).toContain(`id="${HTML_EDIT_BRIDGE_ID}"`)
  expect(opened.indexOf("__driveComment")).toBeLessThan(opened.indexOf(HTML_EDIT_BRIDGE_ID))
})

test("unmounting while editing with unsaved edits posts a final flush", async () => {
  const h = await setup()
  fireEvent.click(screen.getByRole("button", { name: "Edit" }))
  h.send("mode", { editing: true })
  h.send("state", {
    state: {
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
    } satisfies FormatState
  })
  await waitFor(() => expect(screen.getByRole("button", { name: "Bold" })).not.toBeDisabled())
  // Make a change that schedules a flush in the real bridge; here we simulate the dirty report
  // arriving but intercept the save so the session stays dirty at unmount time.
  vi.spyOn(h.fs, "stat").mockResolvedValue(null)
  h.send("dirty", { html: "<!DOCTYPE html><html><body><p>changed</p></body></html>" })
  await waitFor(() => expect(h.context.onError).toHaveBeenCalled())
  const flushBefore = h.sent.filter((m) => m.type === "flush").length
  cleanup()
  // The unmount path posts a flush for the dirty, editing session.
  expect(h.sent.filter((m) => m.type === "flush").length).toBeGreaterThan(flushBefore)
})
