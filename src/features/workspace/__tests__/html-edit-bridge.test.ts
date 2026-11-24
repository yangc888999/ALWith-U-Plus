/**
 * QA regression: execute the *shipped* iframe bridge (`HTML_EDIT_BRIDGE_SOURCE`) in a live frame.
 *
 * These tests inject the real script into an iframe realm and drive it over the real message
 * protocol, so a syntax error or protocol regression fails here instead of on the user's machine.
 *
 * The bridge is injected as a real <script> element (jsdom executes those). jsdom gives the frame a
 * cross-realm `window.parent` proxy, so both directions of the protocol are wired through that exact
 * object: frame→host is captured by spying on `parent.postMessage`, and host→frame dispatches a
 * MessageEvent whose `source` is the same proxy — which is what the bridge's `event.source !==
 * window.parent` guard compares against.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { HTML_EDIT_BRIDGE_ID, HTML_EDIT_BRIDGE_SOURCE, htmlEditBridgeScript } from "../html-edit-bridge"
import {
  EMPTY_FORMAT_STATE,
  HTML_EDIT_FRAME_SOURCE,
  HTML_EDIT_HOST_SOURCE,
  type FormatState
} from "../wysiwyg-types"

const NONCE = "qa-bridge-nonce"

interface FrameMessage {
  source?: string
  type?: string
  nonce?: string | null
  editing?: boolean
  editable?: boolean
  html?: string
  state?: FormatState
}

interface Bridge {
  doc: Document
  frame: HTMLIFrameElement
  view: Window
  /** The frame's cross-realm proxy for the host window (what the bridge calls window.parent). */
  host: Window
  received: FrameMessage[]
  send: (type: string, payload?: Record<string, unknown>) => void
  last: (type: string) => FrameMessage | undefined
  count: (type: string) => number
  caret: (selector: string, index?: number) => void
  select: (selector: string) => void
  stop: () => void
}

const bridges: Bridge[] = []

/** Write the document, stub the frame's execCommand, then run the shipped bridge as a real script. */
function mountBridge(html: string): Bridge {
  const frame = document.createElement("iframe")
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  const view = frame.contentWindow
  if (doc === null || view === null) throw new Error("Missing iframe realm")
  doc.open()
  doc.write(html)
  doc.close()

  // jsdom implements neither command; report false so the DOM fallbacks are what gets exercised.
  const FrameDocument = (view as Window & { Document?: typeof Document }).Document
  if (FrameDocument !== undefined) {
    FrameDocument.prototype.execCommand = vi.fn(() => false)
    FrameDocument.prototype.queryCommandState = vi.fn(() => false)
  }

  const received: FrameMessage[] = []
  // The frame's view of the host. jsdom's postMessage is asynchronous, so capture on this proxy to
  // observe the bridge's replies synchronously.
  const host = (view as Window & { parent: Window }).parent
  const capture = vi.spyOn(host, "postMessage").mockImplementation((message: unknown) => {
    const data = message as FrameMessage
    if (data?.source === HTML_EDIT_FRAME_SOURCE) received.push(data)
  })

  // Inject the shipped source as a fresh <script> (innerHTML-inserted scripts never execute), with
  // the same id/marker the production wrapper uses so serialization strips it by the real selector.
  const script = doc.createElement("script")
  script.id = HTML_EDIT_BRIDGE_ID
  script.setAttribute("data-alwith-bridge", "edit")
  script.textContent = HTML_EDIT_BRIDGE_SOURCE
  ;(doc.head ?? doc.documentElement).appendChild(script)

  const send = (type: string, payload: Record<string, unknown> = {}): void => {
    const EventCtor = (view as Window & { MessageEvent: typeof MessageEvent }).MessageEvent
    view.dispatchEvent(new EventCtor("message", { data: { source: HTML_EDIT_HOST_SOURCE, type, nonce: NONCE, ...payload }, source: host }))
  }
  const place = (selector: string, index: number, collapse: boolean): void => {
    const element = doc.querySelectorAll(selector)[index]
    if (element === undefined) throw new Error(`Missing element: ${selector}[${index}]`)
    const range = doc.createRange()
    range.selectNodeContents(element)
    if (collapse) range.collapse(true)
    const selection = doc.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  const bridge: Bridge = {
    doc,
    frame,
    view,
    host,
    received,
    send,
    last: (type) => received.filter((message) => message.type === type).at(-1),
    count: (type) => received.filter((message) => message.type === type).length,
    caret: (selector, index = 0) => place(selector, index, true),
    select: (selector) => place(selector, 0, false),
    stop: () => capture.mockRestore()
  }
  bridges.push(bridge)
  // The host's init adopts the nonce and makes the bridge re-announce readiness.
  send("init")
  return bridge
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  for (const bridge of bridges) {
    bridge.stop()
    bridge.frame.remove()
  }
  bridges.length = 0
  vi.restoreAllMocks()
})

const TABLE =
  "<table><tbody><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>1</td><td>2</td><td>3</td></tr><tr><td>4</td><td>5</td><td>6</td></tr></tbody></table>"

test("the shipped bridge runs, announces readiness and guards against double injection", () => {
  const bridge = mountBridge("<!DOCTYPE html><html><body><p>hi</p></body></html>")
  expect(bridge.last("ready")?.editable).toBe(true)
  // The bridge really executed: the realm carries its guard flag.
  expect((bridge.view as Window & { __alwithHtmlEdit?: boolean }).__alwithHtmlEdit).toBe(true)
  // A second injection must not install a second listener set: one init still yields one ready.
  const again = bridge.doc.createElement("script")
  again.textContent = HTML_EDIT_BRIDGE_SOURCE
  ;(bridge.doc.head ?? bridge.doc.documentElement).appendChild(again)
  const before = bridge.count("ready")
  bridge.send("init")
  expect(bridge.count("ready")).toBe(before + 1)
})

test("the embedded script tag escapes closing-script sequences so it cannot break out", () => {
  const tag = htmlEditBridgeScript()
  expect(tag).toContain(`id="${HTML_EDIT_BRIDGE_ID}"`)
  expect(tag).toContain('data-alwith-bridge="edit"')
  expect(tag.match(/<\/script/gi)).toHaveLength(1)
})

test("set-mode turns contentEditable on and off without replacing the frame's window", () => {
  const bridge = mountBridge("<!DOCTYPE html><html><body><p>hi</p></body></html>")
  const windowBefore = bridge.frame.contentWindow
  bridge.send("set-mode", { editing: true })
  // jsdom neither reflects contentEditable onto the attribute nor implements isContentEditable;
  // the IDL property is the observable signal here (real-engine behaviour is a manual check).
  expect(bridge.doc.body.contentEditable).toBe("true")
  expect(bridge.doc.body.classList.contains("alwith-html-editing")).toBe(true)
  expect(bridge.doc.getElementById("__alwith-edit-style")).not.toBeNull()
  expect(bridge.last("mode")?.editing).toBe(true)
  bridge.send("set-mode", { editing: false })
  expect(bridge.doc.body.contentEditable).toBe("false")
  expect(bridge.doc.body.classList.contains("alwith-html-editing")).toBe(false)
  expect(bridge.frame.contentWindow).toBe(windowBefore)
})

test("a host message with a foreign nonce or source never enters edit mode", () => {
  const bridge = mountBridge("<!DOCTYPE html><html><body><p>hi</p></body></html>")
  const EventCtor = (bridge.view as Window & { MessageEvent: typeof MessageEvent }).MessageEvent
  bridge.view.dispatchEvent(
    new EventCtor("message", { data: { source: HTML_EDIT_HOST_SOURCE, type: "set-mode", nonce: "wrong", editing: true }, source: bridge.host })
  )
  bridge.view.dispatchEvent(
    new EventCtor("message", { data: { source: "alwith-preview", type: "set-mode", nonce: NONCE, editing: true }, source: bridge.host })
  )
  expect(bridge.doc.body.contentEditable).not.toBe("true")
})

test("deleting the caret's row removes it, and the host undo message restores it", () => {
  const bridge = mountBridge(`<!DOCTYPE html><html><body>${TABLE}</body></html>`)
  bridge.send("set-mode", { editing: true })
  // A plain caret in the second row's first cell — no cell selection.
  bridge.caret("tr:nth-child(2) td", 0)
  bridge.send("command", { command: "deleteRow" })
  expect(bridge.doc.querySelectorAll("tr")).toHaveLength(2)
  expect(bridge.doc.body.textContent).not.toContain("1")
  bridge.send("undo")
  expect(bridge.doc.querySelectorAll("tr")).toHaveLength(3)
  expect(bridge.doc.body.textContent).toContain("1")
})

test("deleting the caret's column removes it from every row and undo restores all cells", () => {
  const bridge = mountBridge(`<!DOCTYPE html><html><body>${TABLE}</body></html>`)
  bridge.send("set-mode", { editing: true })
  bridge.caret("tr:nth-child(1) td:nth-child(2)", 0)
  bridge.send("command", { command: "deleteColumn" })
  expect(bridge.doc.querySelectorAll("tr")[0].cells).toHaveLength(2)
  expect(bridge.doc.body.textContent).not.toContain("b")
  bridge.send("undo")
  expect(bridge.doc.querySelectorAll("tr")[0].cells).toHaveLength(3)
  expect(bridge.doc.body.textContent).toContain("b")
})

test("the last row / last column removes the whole table, and undo brings it back", () => {
  const single = mountBridge("<!DOCTYPE html><html><body><table><tbody><tr><td>only</td></tr></tbody></table></body></html>")
  single.send("set-mode", { editing: true })
  single.caret("td")
  single.send("command", { command: "deleteRow" })
  expect(single.doc.querySelector("table")).toBeNull()
  single.send("undo")
  expect(single.doc.querySelector("table")).not.toBeNull()

  const oneColumn = mountBridge(
    "<!DOCTYPE html><html><body><table><tbody><tr><td>x</td></tr><tr><td>y</td></tr></tbody></table></body></html>"
  )
  oneColumn.send("set-mode", { editing: true })
  oneColumn.caret("td")
  oneColumn.send("command", { command: "deleteColumn" })
  expect(oneColumn.doc.querySelector("table")).toBeNull()
})

test("a colspan table degrades: column delete is a no-op and the table survives", () => {
  const bridge = mountBridge(
    '<!DOCTYPE html><html><body><table><tbody><tr><td colspan="2">wide</td></tr><tr><td>a</td><td>b</td></tr></tbody></table></body></html>'
  )
  bridge.send("set-mode", { editing: true })
  bridge.caret("td")
  expect(bridge.last("state")?.state?.inTable).toBe(false)
  bridge.send("command", { command: "deleteColumn" })
  expect(bridge.doc.querySelector("table")).not.toBeNull()
})

test("clicking an image selects it, delete removes it, and the selection class never reaches a save", () => {
  const bridge = mountBridge('<!DOCTYPE html><html><body><p>before<img src="a.png">after</p></body></html>')
  bridge.send("set-mode", { editing: true })
  const image = bridge.doc.querySelector("img") as HTMLImageElement
  const MouseCtor = (bridge.view as Window & { MouseEvent: typeof MouseEvent }).MouseEvent
  image.dispatchEvent(new MouseCtor("click", { bubbles: true }))
  expect(image.classList.contains("alwith-img-selected")).toBe(true)
  expect(bridge.last("state")?.state?.hasImage).toBe(true)

  bridge.send("command", { command: "deleteImage" })
  expect(bridge.doc.querySelector("img")).toBeNull()
  bridge.send("undo")
  expect(bridge.doc.querySelector("img")).not.toBeNull()
  // Undo re-inserts the node with the selection class still on it; serialization must strip it.
  bridge.send("flush")
  const html = bridge.last("dirty")?.html ?? ""
  expect(html).toContain('src="a.png"')
  expect(html).not.toContain("alwith-img-selected")
})

test("Delete on a selected image removes it without a toolbar command", () => {
  const bridge = mountBridge('<!DOCTYPE html><html><body><p>x<img src="a.png">y</p></body></html>')
  bridge.send("set-mode", { editing: true })
  const image = bridge.doc.querySelector("img") as HTMLImageElement
  const win = bridge.view as Window & { MouseEvent: typeof MouseEvent; KeyboardEvent: typeof KeyboardEvent }
  image.dispatchEvent(new win.MouseEvent("click", { bubbles: true }))
  bridge.doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Delete", bubbles: true }))
  expect(bridge.doc.querySelector("img")).toBeNull()
})

test("format commands report state and debounce the save; flush saves immediately", () => {
  const bridge = mountBridge("<!DOCTYPE html><html><body><p>hello</p></body></html>")
  bridge.send("set-mode", { editing: true })
  bridge.select("p")
  // execCommand reports false, so underline takes the surroundContents fallback.
  bridge.send("command", { command: "underline" })
  expect(bridge.doc.querySelector("u")).not.toBeNull()
  expect(bridge.last("state")?.state?.canEdit).toBe(true)
  expect(bridge.last("dirty")).toBeUndefined()
  vi.advanceTimersByTime(700)
  expect(bridge.last("dirty")?.html ?? "").toContain("<u>hello</u>")

  // An explicit flush cancels the pending debounce instead of writing twice.
  const before = bridge.count("dirty")
  bridge.select("u")
  bridge.send("command", { command: "inlineCode" })
  vi.advanceTimersByTime(300)
  bridge.send("flush")
  expect(bridge.count("dirty")).toBe(before + 1)
  vi.advanceTimersByTime(700)
  expect(bridge.count("dirty")).toBe(before + 1)
})

test("Cmd+S inside the frame flushes immediately", () => {
  const bridge = mountBridge("<!DOCTYPE html><html><body><p>hello</p></body></html>")
  bridge.send("set-mode", { editing: true })
  bridge.select("p")
  bridge.send("command", { command: "underline" })
  const KeyCtor = (bridge.view as Window & { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent
  bridge.doc.dispatchEvent(new KeyCtor("keydown", { key: "s", metaKey: true, bubbles: true }))
  expect(bridge.last("dirty")?.html ?? "").toContain("<u>hello</u>")
})

test("the shipped serializer strips every injected artifact", () => {
  const source =
    '<!DOCTYPE html><html><head><title>T</title>' +
    '<script src="/token/__alwith-menu.js"></script>' +
    "<script>window.__alwithPreviewMenu=true</script>" +
    '<script data-alwith-bridge="drive">window.__driveBridge=true</script>' +
    '<style id="yup-comment-style">.yup{color:red}</style></head>' +
    '<body><p>keep<span class="yup-comment-highlight">quoted</span><span class="yup-comment-marker">1</span></p>' +
    '<img src="a.png"></body></html>'
  const bridge = mountBridge(source)
  bridge.send("set-mode", { editing: true })
  const image = bridge.doc.querySelector("img") as HTMLImageElement
  image.classList.add("alwith-img-selected")
  bridge.send("flush")
  const shipped = bridge.last("dirty")?.html ?? ""

  expect(shipped.startsWith("<!DOCTYPE html>")).toBe(true)
  for (const artifact of [
    "__alwith-edit-bridge",
    "__alwith-edit-style",
    "__alwith-menu.js",
    "__alwithPreviewMenu",
    "__driveBridge",
    "yup-comment-style",
    "yup-comment-marker",
    "yup-comment-highlight",
    "contenteditable",
    "alwith-img-selected",
    "alwith-html-editing"
  ]) {
    expect(shipped).not.toContain(artifact)
  }
  // The user's own content survives, including the text the comment highlight wrapped.
  expect(shipped).toContain("<title>T</title>")
  expect(shipped).toContain("quoted")
  expect(shipped).toContain('src="a.png"')
})

test("a pristine document round-trips through the shipped serializer without editing artifacts", () => {
  const source = "<!DOCTYPE html><html><head><title>T</title></head><body><p>Original</p></body></html>"
  const bridge = mountBridge(source)
  bridge.send("set-mode", { editing: true })
  bridge.send("set-mode", { editing: false })
  bridge.send("flush")
  const html = bridge.last("dirty")?.html ?? ""
  expect(html).toContain("<p>Original</p>")
  expect(html).toContain("<title>T</title>")
  expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
  expect(html).not.toContain("contenteditable")
  expect(html).not.toContain("__alwith")
})

test("the shipped command set reports format state for every command", () => {
  const bridge = mountBridge(`<!DOCTYPE html><html><body><p>text</p>${TABLE}</body></html>`)
  bridge.send("set-mode", { editing: true })
  bridge.caret("td")
  // set-mode focuses/clears the selection, so re-report after placing the caret.
  bridge.send("set-mode", { editing: true })
  const shippedState = bridge.last("state")?.state
  expect(shippedState).toBeDefined()
  expect(Object.keys(shippedState as object).sort()).toEqual(Object.keys(EMPTY_FORMAT_STATE).sort())
  expect(shippedState?.inTable).toBe(true)

  // Every command must be handled by the shipped switch: each one reports state back, while an
  // unknown command would fall through without a report.
  const commands = [
    "bold",
    "italic",
    "underline",
    "strike",
    "blockquote",
    "bulletList",
    "orderedList",
    "indent",
    "outdent",
    "inlineCode",
    "codeBlock",
    "insertTable",
    "deleteRow",
    "deleteColumn",
    "deleteImage"
  ] as const
  for (const command of commands) {
    const before = bridge.count("state")
    bridge.send("command", { command })
    expect(bridge.count("state")).toBe(before + 1)
  }
})
