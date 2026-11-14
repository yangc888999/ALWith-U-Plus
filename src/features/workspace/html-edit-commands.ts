/**
 * DOM-side editing commands for the HTML WYSIWYG bridge (pure, jsdom-testable).
 *
 * Formatting prefers `document.execCommand` so edits land on the frame's native undo stack.
 * Table row/column deletion and image removal are structural DOM operations that execCommand
 * cannot express; they run here and the host offers a one-shot toast+undo because they bypass
 * the undo stack. Every function returns a result describing what happened so the caller can
 * decide whether to schedule a save and whether to offer undo.
 */
import type { FormatState, WysiwygCommand } from "./wysiwyg-types"
import { EMPTY_FORMAT_STATE } from "./wysiwyg-types"

/** A structural deletion that can be undone by re-inserting the removed node. */
export interface DomDeletion {
  kind: "row" | "column" | "image" | "table"
  /** Re-insert the removed content. Returns true when something was restored. */
  undo: () => boolean
}

export interface CommandResult {
  /** The command did something (a save should be scheduled). */
  changed: boolean
  /** Present for structural DOM deletions that need a toast+undo. */
  deletion?: DomDeletion
}

const UNCHANGED: CommandResult = { changed: false }

/** Run execCommand defensively: some engines throw instead of returning false. */
function exec(doc: Document, command: string, value?: string): boolean {
  try {
    return doc.execCommand(command, false, value)
  } catch {
    return false
  }
}

/** The selection's common ancestor element, or null. */
function selectionElement(doc: Document): Element | null {
  const selection = doc.getSelection()
  if (selection === null || selection.rangeCount === 0) return null
  const node = selection.getRangeAt(0).commonAncestorContainer
  if (node.nodeType === 1) return node as Element
  return node.parentElement ?? null
}

/** Wrap the current selection in a fresh element (DOM fallback for underline / inline code). */
function surroundSelection(doc: Document, tagName: string): boolean {
  const selection = doc.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return false
  const range = selection.getRangeAt(0)
  const wrapper = doc.createElement(tagName)
  try {
    range.surroundContents(wrapper)
  } catch {
    // A range that straddles element boundaries cannot be surrounded; extract and re-wrap.
    const fragment = range.extractContents()
    wrapper.appendChild(fragment)
    range.insertNode(wrapper)
  }
  return true
}

/** The table cell / row / table around the selection, if any. */
function tableContext(doc: Document): { cell: HTMLTableCellElement; row: HTMLTableRowElement; table: HTMLTableElement } | null {
  const element = selectionElement(doc)
  if (element === null) return null
  const cell = element.closest("td, th") as HTMLTableCellElement | null
  if (cell === null) return null
  const row = cell.closest("tr") as HTMLTableRowElement | null
  const table = cell.closest("table") as HTMLTableElement | null
  if (row === null || table === null) return null
  return { cell, row, table }
}

/** True when any cell in the table spans more than one column (colspan) — column ops degrade. */
export function tableHasColspan(table: HTMLTableElement): boolean {
  for (const row of Array.from(table.rows)) {
    for (const cell of Array.from(row.cells)) {
      if (cell.colSpan > 1) return true
    }
  }
  return false
}

/** Remove a node but remember how to put it back (for the toast+undo action). */
function removable(node: Node): DomDeletion["undo"] {
  const parent = node.parentNode
  const next = node.nextSibling
  return () => {
    if (parent === null) return false
    parent.insertBefore(node, next)
    return true
  }
}

/** Delete the selection's table row; the last row removes the whole table. */
export function deleteTableRow(doc: Document): CommandResult {
  const context = tableContext(doc)
  if (context === null) return UNCHANGED
  const { row, table } = context
  if (table.rows.length <= 1) {
    const undo = removable(table)
    table.remove()
    return { changed: true, deletion: { kind: "table", undo } }
  }
  const undo = removable(row)
  row.remove()
  return { changed: true, deletion: { kind: "row", undo } }
}

/** Delete the selection's table column; the last column removes the whole table. */
export function deleteTableColumn(doc: Document): CommandResult {
  const context = tableContext(doc)
  if (context === null) return UNCHANGED
  const { cell, table } = context
  if (tableHasColspan(table)) return UNCHANGED
  const index = cell.cellIndex
  const rows = Array.from(table.rows)
  const width = rows[0]?.cells.length ?? 0
  if (width <= 1) {
    const undo = removable(table)
    table.remove()
    return { changed: true, deletion: { kind: "table", undo } }
  }
  const removed: Array<{ node: HTMLTableCellElement; parent: HTMLTableRowElement; next: Node | null }> = []
  for (const row of rows) {
    const target = row.cells[index]
    if (target === undefined) continue
    removed.push({ node: target, parent: row, next: target.nextSibling })
    target.remove()
  }
  if (removed.length === 0) return UNCHANGED
  return {
    changed: true,
    deletion: {
      kind: "column",
      undo: () => {
        for (const { node, parent, next } of removed) parent.insertBefore(node, next)
        return true
      }
    }
  }
}

/** Remove the selected image (structural, needs toast+undo). */
export function deleteImage(image: Element | null): CommandResult {
  if (image === null || image.tagName !== "IMG") return UNCHANGED
  const undo = removable(image)
  image.remove()
  return { changed: true, deletion: { kind: "image", undo } }
}

/** Toggle a blockquote around the selection (DOM fallback when formatBlock is unavailable). */
function toggleBlockquoteDom(doc: Document): boolean {
  const element = selectionElement(doc)
  const existing = element?.closest("blockquote")
  if (existing != null) {
    const parent = existing.parentNode
    if (parent === null) return false
    while (existing.firstChild !== null) parent.insertBefore(existing.firstChild, existing)
    existing.remove()
    return true
  }
  const selection = doc.getSelection()
  if (selection === null || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  const quote = doc.createElement("blockquote")
  try {
    range.surroundContents(quote)
  } catch {
    quote.appendChild(range.extractContents())
    range.insertNode(quote)
  }
  return true
}

/** Indent/outdent a non-list block by wrapping/unwrapping a margin-left div (DOM fallback). */
function indentDom(doc: Document, outward: boolean): boolean {
  const element = selectionElement(doc)
  const block = element?.closest("p, div, h1, h2, h3, h4, h5, h6, pre") as HTMLElement | null
  if (block === null) return false
  const wrapper = block.parentElement
  const isWrapped = wrapper !== null && wrapper.tagName === "DIV" && wrapper.style.marginLeft !== ""
  if (outward) {
    if (!isWrapped || wrapper === null) return false
    const parent = wrapper.parentNode
    if (parent === null) return false
    parent.insertBefore(block, wrapper)
    if (wrapper.childElementCount === 0) wrapper.remove()
    return true
  }
  if (isWrapped) {
    // Already wrapped: deepen the margin.
    const current = Number.parseInt(wrapper.style.marginLeft, 10) || 0
    wrapper.style.marginLeft = `${current + 24}px`
    return true
  }
  const parent = block.parentNode
  if (parent === null) return false
  const div = doc.createElement("div")
  div.style.marginLeft = "24px"
  parent.insertBefore(div, block)
  div.appendChild(block)
  return true
}

/**
 * Run a toolbar command against the frame document. `selectedImage` is the image the bridge
 * marked via click-capture (Delete/Backspace and 删除图片 act on it).
 */
export function runHtmlCommand(doc: Document, command: WysiwygCommand, selectedImage: Element | null): CommandResult {
  switch (command) {
    case "bold":
      return { changed: exec(doc, "bold") }
    case "italic":
      return { changed: exec(doc, "italic") }
    case "underline":
      return { changed: exec(doc, "underline") || surroundSelection(doc, "u") }
    case "strike":
      return { changed: exec(doc, "strikeThrough") }
    case "blockquote":
      return { changed: exec(doc, "formatBlock", "blockquote") || toggleBlockquoteDom(doc) }
    case "bulletList":
      return { changed: exec(doc, "insertUnorderedList") }
    case "orderedList":
      return { changed: exec(doc, "insertOrderedList") }
    case "indent":
      return { changed: exec(doc, "indent") || indentDom(doc, false) }
    case "outdent":
      return { changed: exec(doc, "outdent") || indentDom(doc, true) }
    case "inlineCode":
      return { changed: surroundSelection(doc, "code") }
    case "codeBlock":
      return { changed: exec(doc, "formatBlock", "pre") }
    case "insertTable":
      return { changed: exec(doc, "insertHTML", "<table><tbody><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table>") }
    case "deleteRow":
      return deleteTableRow(doc)
    case "deleteColumn":
      return deleteTableColumn(doc)
    case "deleteImage":
      return deleteImage(selectedImage)
  }
}

/** Compute the toolbar's format state from the frame's current selection. */
export function computeHtmlFormatState(doc: Document, editing: boolean, selectedImage: Element | null): FormatState {
  if (!editing) return { ...EMPTY_FORMAT_STATE }
  const query = (command: string): boolean => {
    try {
      return doc.queryCommandState(command)
    } catch {
      return false
    }
  }
  const element = selectionElement(doc)
  const context = tableContext(doc)
  const block = element?.closest("pre")
  return {
    bold: query("bold"),
    italic: query("italic"),
    underline: query("underline"),
    strike: query("strikeThrough"),
    blockquote: element?.closest("blockquote") != null,
    ul: element?.closest("ul") != null,
    ol: element?.closest("ol") != null,
    code: element?.closest("code") != null && block === null,
    codeBlock: block != null,
    inTable: context !== null && !tableHasColspan(context.table),
    hasImage: selectedImage !== null,
    canEdit: true
  }
}

/**
 * Serialize the frame document back to clean HTML: strip the edit bridge, the injected edit
 * styles, every contenteditable attribute and selection class, and the Rust menu bridge nodes.
 * The doctype is preserved. Only nodes are removed — already-registered listeners are untouched.
 */
export function serializeHtmlDocument(doc: Document): string {
  const clone = doc.cloneNode(true) as Document
  // Our own bridge + styles.
  clone.querySelectorAll('script[data-alwith-bridge="edit"], #__alwith-edit-bridge, #__alwith-edit-style').forEach((node) => node.remove())
  // The Rust menu bridge: an external __alwith-menu.js script and its inline twin. Removing the
  // DOM nodes does not unregister their listeners, so the live preview keeps its menu.
  clone.querySelectorAll('script[src$="__alwith-menu.js"]').forEach((node) => node.remove())
  clone.querySelectorAll("script").forEach((node) => {
    if ((node.textContent ?? "").includes("__alwithPreviewMenu")) node.remove()
  })
  // Drive comment bridge artifacts: the injected style, number markers and highlight spans
  // (unwrapped so the quoted text survives). The bridge script carries the drive marker.
  clone.querySelectorAll("#yup-comment-style, script[data-alwith-bridge]").forEach((node) => node.remove())
  clone.querySelectorAll(".yup-comment-marker").forEach((node) => node.remove())
  clone.querySelectorAll(".yup-comment-highlight").forEach((node) => {
    const parent = node.parentNode
    if (parent === null) return
    while (node.firstChild !== null) parent.insertBefore(node.firstChild, node)
    node.remove()
  })
  // Editing artifacts.
  clone.querySelectorAll("[contenteditable]").forEach((node) => node.removeAttribute("contenteditable"))
  clone.querySelectorAll(".alwith-img-selected").forEach((node) => {
    node.classList.remove("alwith-img-selected")
    if (node.classList.length === 0) node.removeAttribute("class")
  })
  clone.querySelectorAll("[class]").forEach((node) => {
    if (node.getAttribute("class") === "") node.removeAttribute("class")
  })
  const body = clone.querySelector("body")
  if (body !== null) {
    body.classList.remove("alwith-html-editing")
    if (body.classList.length === 0) body.removeAttribute("class")
  }
  const doctype = clone.doctype
  const doctypeText =
    doctype === null
      ? ""
      : `<!DOCTYPE ${doctype.name}${doctype.publicId !== "" ? ` PUBLIC "${doctype.publicId}"` : ""}${doctype.systemId !== "" ? ` "${doctype.systemId}"` : ""}>`
  return `${doctypeText}${clone.documentElement.outerHTML}`
}

/** Whether the document has a <body> that can become contentEditable (fragments cannot). */
export function documentHasBody(doc: Document): boolean {
  return doc.body !== null && doc.body.tagName === "BODY"
}