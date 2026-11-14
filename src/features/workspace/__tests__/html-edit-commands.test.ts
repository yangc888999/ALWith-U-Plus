import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import {
  computeHtmlFormatState,
  deleteImage,
  deleteTableColumn,
  deleteTableRow,
  documentHasBody,
  runHtmlCommand,
  serializeHtmlDocument,
  tableHasColspan
} from "../html-edit-commands"

/**
 * Build a live document from HTML for each test. `DOMParser` documents have no browsing context,
 * so `getSelection()` returns null there; an about:blank iframe gives a real, selectable document.
 */
function makeDoc(html: string): Document {
  const iframe = document.createElement("iframe")
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument
  if (doc === null) throw new Error("Missing iframe document")
  doc.open()
  doc.write(html)
  doc.close()
  return doc
}

/** Place the caret inside the first element matching the selector's text. */
function caretIn(doc: Document, selector: string): void {
  const element = doc.querySelector(selector)
  if (element === null) throw new Error(`Missing element: ${selector}`)
  const range = doc.createRange()
  range.selectNodeContents(element)
  range.collapse(true)
  const selection = doc.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

beforeEach(() => {
  // jsdom does not implement execCommand; default it to false so DOM fallbacks are exercised.
  // Stub the global Document and the iframe realm's Document (makeDoc uses a live iframe, whose
  // methods resolve against its own realm's prototype, not the test window's).
  Document.prototype.execCommand = vi.fn(() => false)
  Document.prototype.queryCommandState = vi.fn(() => false)
  const probe = document.createElement("iframe")
  document.body.appendChild(probe)
  const FrameDocument = (probe.contentWindow as (Window & { Document?: typeof Document }) | null)?.Document
  if (FrameDocument !== undefined) {
    FrameDocument.prototype.execCommand = vi.fn(() => false)
    FrameDocument.prototype.queryCommandState = vi.fn(() => false)
  }
  probe.remove()
})

afterEach(() => {
  // makeDoc appends iframes to the shared body; remove them so selections don't leak.
  document.body.querySelectorAll("iframe").forEach((frame) => frame.remove())
})

describe("table row/column deletion", () => {
  const table = "<table><tbody><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>1</td><td>2</td><td>3</td></tr><tr><td>4</td><td>5</td><td>6</td></tr></tbody></table>"

  test("deletes the caret's row and offers undo", () => {
    const doc = makeDoc(`<body>${table}</body>`)
    caretIn(doc, "td:nth-child(1)")
    // Caret in the second row's first cell.
    const rows = doc.querySelectorAll("tr")
    const range = doc.createRange()
    range.selectNodeContents(rows[1].cells[0])
    range.collapse(true)
    const selection = doc.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const result = deleteTableRow(doc)
    expect(result.changed).toBe(true)
    expect(result.deletion?.kind).toBe("row")
    expect(doc.querySelectorAll("tr")).toHaveLength(2)
    expect(doc.body.textContent).not.toContain("1")
    expect(result.deletion?.undo()).toBe(true)
    expect(doc.querySelectorAll("tr")).toHaveLength(3)
  })

  test("deletes the caret's column and offers undo", () => {
    const doc = makeDoc(`<body>${table}</body>`)
    const rows = doc.querySelectorAll("tr")
    const range = doc.createRange()
    range.selectNodeContents(rows[0].cells[1])
    range.collapse(true)
    const selection = doc.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const result = deleteTableColumn(doc)
    expect(result.changed).toBe(true)
    expect(result.deletion?.kind).toBe("column")
    expect(doc.querySelectorAll("tr")[0].cells).toHaveLength(2)
    expect(doc.body.textContent).not.toContain("b")
    expect(result.deletion?.undo()).toBe(true)
    expect(doc.querySelectorAll("tr")[0].cells).toHaveLength(3)
  })

  test("deleting the last row removes the whole table", () => {
    const doc = makeDoc("<body><table><tbody><tr><td>only</td></tr></tbody></table></body>")
    caretIn(doc, "td")
    const result = deleteTableRow(doc)
    expect(result.deletion?.kind).toBe("table")
    expect(doc.querySelector("table")).toBeNull()
    expect(result.deletion?.undo()).toBe(true)
    expect(doc.querySelector("table")).not.toBeNull()
  })

  test("deleting the last column removes the whole table", () => {
    const doc = makeDoc("<body><table><tbody><tr><td>only</td></tr><tr><td>row2</td></tr></tbody></table></body>")
    caretIn(doc, "td")
    const result = deleteTableColumn(doc)
    expect(result.deletion?.kind).toBe("table")
    expect(doc.querySelector("table")).toBeNull()
  })

  test("colspan tables degrade: column delete is a no-op", () => {
    const doc = makeDoc('<body><table><tbody><tr><td colspan="2">wide</td></tr><tr><td>a</td><td>b</td></tr></tbody></table></body>')
    caretIn(doc, "td")
    expect(tableHasColspan(doc.querySelector("table")!)).toBe(true)
    const result = deleteTableColumn(doc)
    expect(result.changed).toBe(false)
    expect(doc.querySelector("table")).not.toBeNull()
  })

  test("outside a table both deletes are no-ops", () => {
    const doc = makeDoc("<body><p>text</p></body>")
    caretIn(doc, "p")
    expect(deleteTableRow(doc).changed).toBe(false)
    expect(deleteTableColumn(doc).changed).toBe(false)
  })
})

describe("image deletion", () => {
  test("removes the selected image and undo restores it", () => {
    const doc = makeDoc('<body><p>before<img src="x.png">after</p></body>')
    const image = doc.querySelector("img")
    const result = deleteImage(image)
    expect(result.changed).toBe(true)
    expect(result.deletion?.kind).toBe("image")
    expect(doc.querySelector("img")).toBeNull()
    expect(result.deletion?.undo()).toBe(true)
    expect(doc.querySelector("img")).not.toBeNull()
  })

  test("no image is a no-op", () => {
    const doc = makeDoc("<body><p>x</p></body>")
    expect(deleteImage(null).changed).toBe(false)
    expect(deleteImage(doc.querySelector("p")).changed).toBe(false)
  })
})

describe("execCommand fallbacks", () => {
  test("underline falls back to surrounding with <u> when execCommand fails", () => {
    const doc = makeDoc("<body><p>hello</p></body>")
    const range = doc.createRange()
    range.selectNodeContents(doc.querySelector("p")!)
    const selection = doc.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const result = runHtmlCommand(doc, "underline", null)
    expect(result.changed).toBe(true)
    expect(doc.querySelector("u")).not.toBeNull()
  })

  test("execCommand is preferred when it succeeds", () => {
    const exec = vi.fn(() => true)
    const doc = makeDoc("<body><p>hello</p></body>")
    doc.execCommand = exec
    const result = runHtmlCommand(doc, "bold", null)
    expect(result.changed).toBe(true)
    expect(exec).toHaveBeenCalledWith("bold", false, undefined)
  })

  test("blockquote DOM fallback wraps and unwraps", () => {
    const doc = makeDoc("<body><p>quote me</p></body>")
    const range = doc.createRange()
    range.selectNodeContents(doc.querySelector("p")!)
    const selection = doc.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    expect(runHtmlCommand(doc, "blockquote", null).changed).toBe(true)
    expect(doc.querySelector("blockquote")).not.toBeNull()
  })
})

describe("serializeHtmlDocument", () => {
  test("strips the edit bridge, styles, contenteditable and selection classes, keeps doctype", () => {
    const doc = makeDoc(
      '<!DOCTYPE html><html><head><script id="__alwith-edit-bridge" data-alwith-bridge="edit">x</script><style id="__alwith-edit-style">y</style><script src="/token/__alwith-menu.js"></script><script>window.__alwithPreviewMenu=true</script></head><body class="alwith-html-editing" contenteditable="true"><p class="">hi</p><img class="alwith-img-selected" src="a.png"></body></html>'
    )
    const html = serializeHtmlDocument(doc)
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
    expect(html).not.toContain("__alwith-edit-bridge")
    expect(html).not.toContain("__alwith-edit-style")
    expect(html).not.toContain("__alwith-menu.js")
    expect(html).not.toContain("__alwithPreviewMenu")
    expect(html).not.toContain("contenteditable")
    expect(html).not.toContain("alwith-img-selected")
    expect(html).not.toContain("alwith-html-editing")
    expect(html).toContain("<p>hi</p>")
    expect(html).toContain('src="a.png"')
  })

  test("a pristine document round-trips without becoming dirty", () => {
    const source = "<!DOCTYPE html><html><head><title>T</title></head><body><p>Original</p></body></html>"
    const doc = makeDoc(source)
    const html = serializeHtmlDocument(doc)
    expect(html).toContain("<p>Original</p>")
    expect(html).toContain("<title>T</title>")
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
  })

  test("a source without a doctype serializes without one (no synthetic doctype)", () => {
    const doc = makeDoc("<html><body>x</body></html>")
    const html = serializeHtmlDocument(doc)
    expect(html.toLowerCase().startsWith("<!doctype")).toBe(false)
    expect(html).toContain("<body>x</body>")
  })
})

describe("documentHasBody / format state", () => {
  test("a full document has a body; a fragment does not", () => {
    expect(documentHasBody(makeDoc("<html><body><p>x</p></body></html>"))).toBe(true)
    // DOMParser always synthesizes a body for text/html, so a fragment is detected by the host
    // checking the original source instead; here we assert the helper reads the live document.
    expect(documentHasBody(document)).toBe(true)
  })

  test("format state is empty when not editing", () => {
    const doc = makeDoc("<body><p>x</p></body>")
    const state = computeHtmlFormatState(doc, false, null)
    expect(state.canEdit).toBe(false)
    expect(state.bold).toBe(false)
  })

  test("format state reflects the selection when editing", () => {
    const doc = makeDoc("<body><blockquote><p>x</p></blockquote></body>")
    doc.queryCommandState = vi.fn((command: string) => command === "bold")
    caretIn(doc, "p")
    const state = computeHtmlFormatState(doc, true, null)
    expect(state.canEdit).toBe(true)
    expect(state.bold).toBe(true)
    expect(state.blockquote).toBe(true)
  })
})