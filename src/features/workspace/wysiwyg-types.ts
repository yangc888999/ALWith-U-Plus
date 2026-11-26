/**
 * Shared contracts for the preview WYSIWYG editors (Markdown toolbar + HTML edit bridge).
 *
 * Both surfaces report the same FormatState so one toolbar vocabulary serves them, and the HTML
 * frame talks to its host through a small message protocol whose `source` constants never collide
 * with the Rust menu bridge (`alwith-preview`) or the Drive comment bridge (`yup:*`).
 */

/** Which inline/block formats are active at the current selection, plus capability flags. */
export interface FormatState {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  blockquote: boolean
  ul: boolean
  ol: boolean
  code: boolean
  codeBlock: boolean
  inTable: boolean
  /** HTML only: an image is selected and 删除图片 can run. Markdown always reports false. */
  hasImage: boolean
  /** The surface accepts edits right now (HTML: editing mode is on and the frame is ready). */
  canEdit: boolean
}

export const EMPTY_FORMAT_STATE: FormatState = {
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
  canEdit: false
}

/** Field-wise equality; the store only publishes a new snapshot when something actually changed. */
export function formatStateEqual(a: FormatState, b: FormatState): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.blockquote === b.blockquote &&
    a.ul === b.ul &&
    a.ol === b.ol &&
    a.code === b.code &&
    a.codeBlock === b.codeBlock &&
    a.inTable === b.inTable &&
    a.hasImage === b.hasImage &&
    a.canEdit === b.canEdit
  )
}

/** Commands shared by both toolbars. The Markdown side maps them onto Milkdown commands. */
export type WysiwygCommand =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "blockquote"
  | "bulletList"
  | "orderedList"
  | "outdent"
  | "indent"
  | "inlineCode"
  | "codeBlock"
  | "insertTable"
  | "deleteRow"
  | "deleteColumn"
  | "deleteImage"

/** Translated toolbar strings; resolved once by the host so the bridge script stays locale-free. */
export interface WysiwygLabels {
  bold: string
  italic: string
  underline: string
  strikethrough: string
  blockquote: string
  bulletList: string
  orderedList: string
  outdent: string
  indent: string
  inlineCode: string
  codeBlock: string
  insertTable: string
  deleteRow: string
  deleteColumn: string
  deleteImage: string
  editHtml: string
  finishEditHtml: string
  htmlEditBlocked: string
  /** Toast shown after a DOM deletion in the HTML frame (outside the native undo stack). */
  htmlDeleted: string
  /** Label of the toast action that restores the deleted node. */
  htmlUndoDelete: string
  /** HTML save conflict dialog. Optional so existing toolbar-only hosts keep compiling. */
  htmlSaveConflict?: string
  htmlSaveConflictDescription?: string
  htmlLocalDraft?: string
  htmlDiskVersion?: string
  htmlKeepDraft?: string
  htmlUseDiskVersion?: string
  htmlOverwriteDraft?: string
  htmlSaveDraftCopy?: string
  htmlDraftCopySaved?: string
  htmlSaveStillUpdating?: string
}

/** iframe → host. `nonce` is minted per handshake; stale frames are ignored. */
export const HTML_EDIT_FRAME_SOURCE = "alwith-html-edit"
/** host → iframe. */
export const HTML_EDIT_HOST_SOURCE = "alwith-html-edit-host"

interface HtmlEditReadyMessage {
  source: typeof HTML_EDIT_FRAME_SOURCE
  type: "ready"
  /** Whether the document has a <body> that can become contentEditable. */
  editable: boolean
  /**
   * The bridge's current handshake nonce: null on the spontaneous load announce, then the adopted
   * host nonce on the confirmation. The host uses it to tell a fresh frame from an echo.
   */
  nonce?: string | null
}
interface HtmlEditModeMessage {
  source: typeof HTML_EDIT_FRAME_SOURCE
  type: "mode"
  nonce: string
  editing: boolean
}
interface HtmlEditStateMessage {
  source: typeof HTML_EDIT_FRAME_SOURCE
  type: "state"
  nonce: string
  state: FormatState
}
interface HtmlEditDirtyMessage {
  source: typeof HTML_EDIT_FRAME_SOURCE
  type: "dirty"
  nonce: string
  html: string
}
interface HtmlEditErrorMessage {
  source: typeof HTML_EDIT_FRAME_SOURCE
  type: "error"
  nonce: string
  message: string
}
export type HtmlEditMessage =
  HtmlEditReadyMessage | HtmlEditModeMessage | HtmlEditStateMessage | HtmlEditDirtyMessage | HtmlEditErrorMessage

export interface HtmlHostInitMessage {
  source: typeof HTML_EDIT_HOST_SOURCE
  type: "init"
  nonce: string
}
export interface HtmlHostSetModeMessage {
  source: typeof HTML_EDIT_HOST_SOURCE
  type: "set-mode"
  nonce: string
  editing: boolean
}
export interface HtmlHostCommandMessage {
  source: typeof HTML_EDIT_HOST_SOURCE
  type: "command"
  nonce: string
  command: WysiwygCommand
  value?: string
}
export interface HtmlHostFlushMessage {
  source: typeof HTML_EDIT_HOST_SOURCE
  type: "flush"
  nonce: string
}
export interface HtmlHostUndoMessage {
  source: typeof HTML_EDIT_HOST_SOURCE
  type: "undo"
  nonce: string
}
export type HtmlHostMessage =
  HtmlHostInitMessage | HtmlHostSetModeMessage | HtmlHostCommandMessage | HtmlHostFlushMessage | HtmlHostUndoMessage

/** Type guard for anything arriving on `window.message` that claims to be the edit bridge. */
export function isHtmlEditMessage(data: unknown): data is HtmlEditMessage {
  if (data === null || typeof data !== "object") return false
  const message = data as { source?: unknown; type?: unknown }
  if (message.source !== HTML_EDIT_FRAME_SOURCE) return false
  return (
    message.type === "ready" ||
    message.type === "mode" ||
    message.type === "state" ||
    message.type === "dirty" ||
    message.type === "error"
  )
}

/**
 * A tiny external store with reference-stable snapshots, safe for `useSyncExternalStore`.
 * Publishers pass a candidate value; an unchanged value (per `equal`) keeps the old reference so
 * React never re-renders on identity churn (React #185).
 */
export interface SnapshotStore<T> {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => T
  publish: (next: T) => void
}

export function createSnapshotStore<T>(initial: T, equal: (a: T, b: T) => boolean): SnapshotStore<T> {
  let value: T = initial
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => value,
    publish(next) {
      if (equal(value, next)) return
      value = next
      for (const listener of listeners) listener()
    }
  }
}
