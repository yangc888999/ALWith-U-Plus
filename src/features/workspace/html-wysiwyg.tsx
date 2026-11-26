/**
 * HTML WYSIWYG integration: a formatting toolbar + edit-mode state machine layered on top of
 * whatever HTML integration the host already provides (the Drive comment bridge when the drive
 * is visible). The resident edit bridge (html-edit-bridge.ts) is injected through `transform`;
 * the toolbar drives it over the postMessage protocol defined in wysiwyg-types.ts.
 *
 * `htmlIntegration.render(iframeRef)` receives only the frame ref — not the document — so the
 * provider wrapper (freezeHtmlSourceDuringEditing) supplies the per-document session through a
 * React context, and the toolbar reads the live frame through the same ref the provider
 * populates. The toolbar renders inside render(), above the iframe in the preview's flex column
 * — never through setToolbarActions.
 *
 * Saving goes through `workspace.fs.writeFile` (the transport adds collaborationOwnerId) and is
 * followed by `controller.reload(id)` so the editor's optimistic-lock version stays current.
 * Four layers keep the iframe alive across our own saves:
 *  1. html-preview's self-write window (ignores the watch echo for the exact path),
 *  2. html-preview's editing suspension (holds rebuilds while editing),
 *  3. the source freeze (the provider also rebuilds when document.savedText changes — the
 *     controller auto-syncs it after our write, so the preview document must not move),
 *  4. the bridge is a capability, not a session: set-mode never reloads the frame.
 */
import type { EditorController, EditorDocument, PreviewProvider } from "@alwith/module-editor"
import type { PreviewContext, PreviewHost } from "@alwith/module-editor/previews"
import { basename, dirname, type FileSystem, joinPath } from "@alwith/module-fs/core"
import { info } from "@tauri-apps/plugin-log"
import {
  Bold,
  Check,
  Code,
  ImageMinus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Pencil,
  Quote,
  SquareCode,
  Strikethrough,
  Underline,
  Undo2
} from "lucide-react"
import type { ReactNode } from "react"
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

import { Toolbar, type ToolbarItem } from "./components/Toolbar"
import { htmlEditBridgeScript } from "./html-edit-bridge"
import { acceptFrameMessage, hostMessage, mintNonce, postToFrame } from "./html-edit-protocol"
import type { HtmlPreviewHostControl } from "./html-preview"
import {
  createSnapshotStore,
  EMPTY_FORMAT_STATE,
  type FormatState,
  formatStateEqual,
  type SnapshotStore,
  type WysiwygCommand,
  type WysiwygLabels
} from "./wysiwyg-types"

/** Structural DOM deletions bypass the frame's native undo stack; the host offers toast+undo. */
const DELETION_COMMANDS: ReadonlySet<WysiwygCommand> = new Set(["deleteRow", "deleteColumn", "deleteImage"])

/** How long to wait for the frame's dirty reply after a flush before leaving edit mode anyway. */
const FLUSH_TIMEOUT = 2_000
/** A sync may rotate a file version between the two stats of a read. Retry a few times, but
 *  never accept a torn read as the base for an overwrite. */
const STABLE_READ_DELAYS = [40, 80, 120, 180, 240, 320, 420, 540] as const
const STABLE_READ_DELAY = STABLE_READ_DELAYS[0]
const FILE_STILL_UPDATING = "File is still being updated; retry the save"
/** Our write already succeeded when this reload starts. A race in the preview refresh must not
 *  turn into a false save failure. */
const PREVIEW_REFRESH_ATTEMPTS = 3

interface StableHtmlSnapshot {
  text: string
  version: string
}

class HtmlSaveConflictError extends Error {
  readonly localText: string
  readonly currentText: string
  readonly currentVersion: string
  constructor(localText: string, currentText: string, currentVersion: string) {
    super("HTML changed on disk while the local draft was being saved")
    this.name = "HtmlSaveConflictError"
    this.localText = localText
    this.currentText = currentText
    this.currentVersion = currentVersion
  }
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds))

function decodeHtml(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** A side-by-side draft copy next to the report, so loading the disk version never discards it. */
function draftCopyPath(path: string, now = new Date()): string {
  const name = basename(path)
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ".html"
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0")
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`
  return joinPath(dirname(path), `${stem}-draft-${stamp}${extension}`)
}

/** Read bytes and version only when both stats agree. A version that moved while reading is a
 *  sync race, not a content decision; retry instead of using the half-observed pair. */
async function readStableHtml(fs: FileSystem, path: string): Promise<StableHtmlSnapshot> {
  for (let attempt = 0; attempt < STABLE_READ_DELAYS.length; attempt += 1) {
    const before = await fs.stat(path)
    if (before === null) throw new Error("File is no longer available")
    const bytes = await fs.readFile(path)
    const after = await fs.stat(path)
    if (after !== null && after.version === before.version) {
      return { text: decodeHtml(bytes), version: after.version }
    }
    if (attempt + 1 < STABLE_READ_DELAYS.length) await delay(STABLE_READ_DELAYS[attempt] ?? 540)
  }
  throw new Error(FILE_STILL_UPDATING)
}

/** Last readable bytes for the comparison dialog after an external writer keeps rotating versions. */
async function readLatestHtml(fs: FileSystem, path: string): Promise<StableHtmlSnapshot> {
  const before = await fs.stat(path)
  if (before === null) throw new Error("File is no longer available")
  const bytes = await fs.readFile(path)
  const after = await fs.stat(path)
  return { text: decodeHtml(bytes), version: after?.version ?? before.version }
}

function isVersionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /changed on disk|expectedVersion|version conflict/i.test(message)
}

function isTransientReadRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /changed while opening|changed on disk|still being updated/i.test(message)
}

function saveLog(line: string): void {
  try {
    void info(`[html-save] ${line}`).catch(() => {})
  } catch {
    // Outside Tauri (tests): the local save result is still authoritative.
  }
}

/** Marks the live frame as being edited so the workspace context menu can offer cut/paste. */
export const HTML_EDITING_ATTRIBUTE = "data-alwith-html-editing"

export interface WysiwygHtmlOptions {
  fs: FileSystem
  controller: EditorController
  labels: WysiwygLabels
  /** The native preview host control (self-write window + editing suspension). */
  previewControl: HtmlPreviewHostControl
}

/** Only .html/.htm are editable; .xhtml is served as XML where contentEditable differs. */
export function isEditableHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path)
}

/**
 * Whether the source actually declares a <body>. Browsers synthesize one for fragment documents
 * (`<p>hi</p>`), so the bridge's runtime `!!document.body` cannot tell them apart — editing a
 * fragment would rewrite it into a full document, changing its structure. Block those here.
 */
export function sourceHasBody(source: string): boolean {
  return /<body[\s>]/i.test(source)
}

/** Per-document facts the toolbar needs but `htmlIntegration.render(iframeRef)` does not receive. */
interface HtmlEditSession {
  document: EditorDocument
  context: PreviewContext
  editing: boolean
  setEditing: (editing: boolean) => void
}

const HtmlSessionContext = createContext<HtmlEditSession | null>(null)

/**
 * Freeze the preview source while a document is being edited and publish the session for the
 * toolbar. The HTML provider reads `document.savedText` and rebuilds the iframe whenever it
 * changes; our own save makes the controller reload the document (new savedText), which would
 * tear down the frame mid-edit. While editing, the preview keeps rendering the source it was
 * opened with — the live iframe already shows the user's edits, so nothing is lost. On exit the
 * freeze lifts and the next render picks up the saved content.
 */
export function freezeHtmlSourceDuringEditing(
  provider: PreviewProvider,
  previewControl: HtmlPreviewHostControl
): PreviewProvider {
  return {
    ...provider,
    render(document: EditorDocument, context: PreviewContext): ReactNode {
      return (
        <HtmlSessionBoundary
          key={document.id}
          provider={provider}
          document={document}
          context={context}
          previewControl={previewControl}
        />
      )
    }
  }
}

function HtmlSessionBoundary({
  provider,
  document,
  context,
  previewControl
}: {
  provider: PreviewProvider
  document: EditorDocument
  context: PreviewContext
  previewControl: HtmlPreviewHostControl
}): ReactNode {
  const [editing, setEditing] = useState(false)
  // The source the frame was opened with; held constant for the whole edit session.
  const frozen = useRef<string | null>(null)
  const path = document.path

  // Suspend native-host rebuilds while editing; replay any held change when editing ends.
  useEffect(() => {
    previewControl.setEditing(path, editing)
    return () => previewControl.setEditing(path, false)
  }, [path, editing, previewControl])

  if (editing) {
    if (frozen.current === null) frozen.current = document.savedText
  } else {
    frozen.current = null
  }
  const source = frozen.current ?? document.savedText
  const previewDocument = source === document.savedText ? document : { ...document, savedText: source }

  const session: HtmlEditSession = { document, context, editing, setEditing }
  return (
    <HtmlSessionContext.Provider value={session}>
      {provider.render(previewDocument, context)}
    </HtmlSessionContext.Provider>
  )
}

/**
 * Wrap a base HTML integration with the edit bridge + toolbar. `transform` appends the resident
 * bridge after the base transform (Drive's comment bridge stays intact); `render` composes the
 * base render node with the toolbar, both inside the preview's flex column above the iframe.
 */
export function createWysiwygHtmlIntegration(
  base: PreviewHost["htmlIntegration"],
  options: WysiwygHtmlOptions
): NonNullable<PreviewHost["htmlIntegration"]> {
  return {
    transform(source, path) {
      const transformed = base?.transform(source, path) ?? source
      return `${transformed}${htmlEditBridgeScript()}`
    },
    render(iframeRef) {
      return (
        <>
          {base?.render(iframeRef)}
          <HtmlToolbar iframeRef={iframeRef} options={options} />
        </>
      )
    }
  }
}

/**
 * The toolbar + edit-mode state machine. Reads the live frame through the provider's ref and the
 * per-document session from context. All frame messages are validated by source + nonce
 * (acceptFrameMessage); a fresh frame starts a new handshake.
 */
function HtmlToolbar({
  iframeRef,
  options
}: {
  iframeRef: { current: HTMLIFrameElement | null }
  options: WysiwygHtmlOptions
}): ReactNode {
  const session = useContext(HtmlSessionContext)
  const store = useRef<SnapshotStore<FormatState>>(createSnapshotStore(EMPTY_FORMAT_STATE, formatStateEqual))
  const [ready, setReady] = useState(false)
  const [editable, setEditable] = useState(false)
  const [conflict, setConflict] = useState<{ local: string; current: string; version: string } | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [conflictBusy, setConflictBusy] = useState(false)
  const nonceRef = useRef<string | null>(null)
  const editingRef = useRef(false)
  const dirtyRef = useRef(false)
  const flushWaiters = useRef<Array<() => void>>([])
  const savingRef = useRef(false)
  const pendingHtml = useRef<string | null>(null)
  const lastSaved = useRef<string | null>(null)
  // The document id the current handshake belongs to; a tab switch resets the machine.
  const sessionIdRef = useRef<string | null>(null)
  // Latest session for the (stable) message listener to read without re-subscribing.
  const sessionRef = useRef<HtmlEditSession | null>(session)
  sessionRef.current = session
  // The live frame element, refreshed every render. React nulls the provider's ref during the
  // unmount mutation phase (before effect cleanups run), so the final flush must use this copy.
  const frameElRef = useRef<HTMLIFrameElement | null>(null)
  frameElRef.current = iframeRef.current

  const document = session?.document ?? null
  const context = session?.context ?? null
  const editing = session?.editing ?? false
  editingRef.current = editing
  const documentId = document?.id ?? null
  if (sessionIdRef.current !== documentId) {
    sessionIdRef.current = documentId
    nonceRef.current = null
    dirtyRef.current = false
    lastSaved.current = document?.savedText ?? null
    pendingHtml.current = null
    flushWaiters.current = []
  }

  const frame = (): HTMLIFrameElement | null => frameElRef.current ?? iframeRef.current

  useEffect(() => {
    setConflict(null)
    setConflictError(null)
  }, [documentId])

  /** Refresh the editor snapshot after the local write. This is a separate phase: a sync racing
   *  the read must not turn a successful save into a save error. */
  const refreshPreview = async (documentId: string, path: string): Promise<void> => {
    for (let attempt = 0; attempt < PREVIEW_REFRESH_ATTEMPTS; attempt += 1) {
      try {
        const refreshed = await options.controller.reload(documentId)
        saveLog(
          refreshed
            ? `preview-refreshed path=${path} attempt=${attempt + 1}`
            : `preview-refresh-skipped path=${path} attempt=${attempt + 1}`
        )
        return
      } catch (error) {
        if (!isTransientReadRace(error) || attempt + 1 >= PREVIEW_REFRESH_ATTEMPTS) {
          // The bytes are already on disk. Let the file watcher refresh the preview later instead
          // of reporting a failed save for a read-only refresh race.
          if (!isTransientReadRace(error)) throw error
          saveLog(`preview-refresh-deferred path=${path} error=${String(error)}`)
          return
        }
        await delay(STABLE_READ_DELAY)
      }
    }
  }

  /** Persist the frame's HTML. Serialized saves; a write that lands mid-save is re-flushed after.
   *  The local write is the success boundary; preview refresh and cloud upload are reported
   *  separately. */
  const save = async (html: string): Promise<void> => {
    const current = sessionRef.current
    if (current === null) return
    if (html === lastSaved.current) return
    if (savingRef.current) {
      pendingHtml.current = html
      return
    }
    savingRef.current = true
    let conflicted = false
    try {
      const path = current.document.path
      const base = lastSaved.current ?? current.document.savedText
      let snapshot = await readStableHtml(options.fs, path)
      if (snapshot.text === html) {
        lastSaved.current = html
        saveLog(`local-unchanged path=${path} version=${snapshot.version}`)
        await refreshPreview(current.document.id, path)
        return
      }
      if (snapshot.text !== base) throw new HtmlSaveConflictError(html, snapshot.text, snapshot.version)
      let written = false
      for (let attempt = 0; attempt < 2 && !written; attempt += 1) {
        try {
          options.previewControl.markSelfWrite(path)
          await options.fs.writeFile(path, new TextEncoder().encode(html), {
            mode: "replace",
            expectedVersion: snapshot.version
          })
          written = true
        } catch (error) {
          if (!isVersionConflict(error)) throw error
          snapshot = await readStableHtml(options.fs, path)
          if (snapshot.text === html) {
            // Another writer already landed the exact draft. Adopt that version instead of
            // overwriting it with the same bytes.
            written = true
            break
          }
          if (snapshot.text !== base) throw new HtmlSaveConflictError(html, snapshot.text, snapshot.version)
        }
      }
      if (!written) throw new Error("File changed on disk; the local draft was not saved")
      lastSaved.current = html
      saveLog(`local-write path=${path} version=${snapshot.version} wrote=${written}`)
      await refreshPreview(current.document.id, path)
    } catch (error) {
      if (error instanceof HtmlSaveConflictError) {
        conflicted = true
        setConflict({ local: error.localText, current: error.currentText, version: error.currentVersion })
        setConflictError(null)
      } else if (isTransientReadRace(error)) {
        // AI/cloud writers can rotate the version through a short burst. We waited them out; if
        // they are still moving, keep the draft and compare it with the latest readable bytes.
        // This is a conflict decision, not the old "cloud folders commonly do this" error card.
        const latest = await readLatestHtml(options.fs, current.document.path).catch(() => null)
        if (latest !== null) {
          conflicted = true
          setConflict({ local: html, current: latest.text, version: latest.version })
          setConflictError(null)
          saveLog(`external-write-race path=${current.document.path} version=${latest.version}`)
        } else {
          current.context.onError(new Error(FILE_STILL_UPDATING))
        }
      } else {
        current.context.onError(error)
      }
    } finally {
      savingRef.current = false
      const next = pendingHtml.current
      pendingHtml.current = null
      if (!conflicted && next !== null && next !== lastSaved.current) void save(next)
    }
  }

  const resolveFlushWaiters = (): void => {
    const waiters = flushWaiters.current
    flushWaiters.current = []
    for (const waiter of waiters) waiter()
  }

  // Handshake + message routing. The listener lives for the toolbar's lifetime; sessionRef tells
  // it which document is current. A fresh frame (load or rebuild) re-announces readiness.
  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      const message = acceptFrameMessage(event, frame(), nonceRef.current)
      if (message === null) return
      switch (message.type) {
        case "ready": {
          // The spontaneous load announce carries no nonce; the init confirmation echoes ours.
          // Only a nonce-less ready starts a new handshake — an echo just re-confirms readiness.
          if (message.nonce == null) {
            const nonce = mintNonce()
            nonceRef.current = nonce
            dirtyRef.current = false
            lastSaved.current = sessionRef.current?.document.savedText ?? null
            store.current.publish(EMPTY_FORMAT_STATE)
            postToFrame(frame(), hostMessage({ type: "init", nonce }))
          }
          setReady(true)
          setEditable(message.editable)
          break
        }
        case "mode": {
          sessionRef.current?.setEditing(message.editing)
          if (!message.editing) resolveFlushWaiters()
          break
        }
        case "state":
          store.current.publish(message.state)
          break
        case "dirty":
          dirtyRef.current = true
          resolveFlushWaiters()
          void save(message.html)
          break
        case "error":
          sessionRef.current?.context.onError(new Error(message.message))
          break
      }
    }
    window.addEventListener("message", handler)
    return () => {
      window.removeEventListener("message", handler)
      // Leaving the document: flush any unsaved edits before the frame goes away.
      if (editingRef.current && dirtyRef.current && nonceRef.current !== null) {
        postToFrame(frame(), hostMessage({ type: "flush", nonce: nonceRef.current }))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Safety net: if the frame loaded and announced before the listener was registered, ask it to
  // re-announce. Mint a nonce when none exists so the bridge never adopts an empty one (which
  // would leave the edit button blocked). A later spontaneous ready simply mints a fresh nonce.
  useEffect(() => {
    if (documentId === null) return
    if (nonceRef.current === null) nonceRef.current = mintNonce()
    postToFrame(frame(), hostMessage({ type: "init", nonce: nonceRef.current }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId])

  // Mark the live frame so the workspace context menu knows cut/paste apply while editing.
  useEffect(() => {
    const element = frame()
    if (element === null) return
    element.setAttribute(HTML_EDITING_ATTRIBUTE, editing ? "true" : "false")
  }, [editing, documentId])

  const blocked =
    document === null ||
    (context?.readOnly ?? true) ||
    document.dirty ||
    !isEditableHtmlPath(document.path) ||
    !sourceHasBody(document.savedText) ||
    !ready ||
    !editable

  const startEditing = (): void => {
    if (blocked || nonceRef.current === null) return
    postToFrame(frame(), hostMessage({ type: "set-mode", nonce: nonceRef.current, editing: true }))
  }

  const finishEditing = (): void => {
    if (nonceRef.current === null) return
    const nonce = nonceRef.current
    // Flush first so the last edits are saved, then leave edit mode. The frame replies `dirty`
    // (if there is anything to save) followed by `mode{editing:false}`.
    postToFrame(frame(), hostMessage({ type: "flush", nonce }))
    const wait = new Promise<void>((resolve) => {
      flushWaiters.current.push(resolve)
      setTimeout(resolve, FLUSH_TIMEOUT)
    })
    void wait.then(() => {
      postToFrame(frame(), hostMessage({ type: "set-mode", nonce, editing: false }))
    })
  }

  const runCommand = (command: WysiwygCommand): void => {
    if (!editingRef.current || nonceRef.current === null) return
    postToFrame(frame(), hostMessage({ type: "command", nonce: nonceRef.current, command }))
    if (DELETION_COMMANDS.has(command)) {
      // Structural DOM deletion is not on the frame's undo stack: offer a one-shot restore.
      toast(options.labels.htmlDeleted, {
        action: {
          label: options.labels.htmlUndoDelete,
          onClick: () => {
            if (nonceRef.current !== null) {
              postToFrame(frame(), hostMessage({ type: "undo", nonce: nonceRef.current }))
            }
          }
        }
      })
    }
  }

  const state = useSyncExternalStore(store.current.subscribe, store.current.getSnapshot, store.current.getSnapshot)
  const disabled = !editing || !state.canEdit
  const labels = options.labels

  // A persistent undo, reusing the exact postMessage path the deletion toast uses (the bridge's
  // undoPending restores the last structural deletion). Native typing undo stays on the frame.
  const runUndo = (): void => {
    if (nonceRef.current === null) return
    postToFrame(frame(), hostMessage({ type: "undo", nonce: nonceRef.current }))
  }

  const writeDraftCopy = async (path: string, html: string): Promise<string> => {
    const copyPath = draftCopyPath(path)
    await options.fs.writeFile(copyPath, new TextEncoder().encode(html), { mode: "create" })
    return copyPath
  }

  const loadDiskVersion = async (): Promise<void> => {
    const current = sessionRef.current
    if (current === null || nonceRef.current === null) return
    if (conflictBusy) return
    setConflictBusy(true)
    setConflictError(null)
    if (conflict !== null) {
      try {
        const copyPath = await writeDraftCopy(current.document.path, conflict.local)
        saveLog(`conflict-load-disk-draft path=${copyPath}`)
        toast.success(`${labels.htmlDraftCopySaved ?? "Draft copy saved"}: ${copyPath}`, {
          id: "html-draft-copy-saved"
        })
      } catch (error) {
        setConflictError(error instanceof Error ? error.message : String(error))
        setConflictBusy(false)
        return
      }
    }
    setConflict(null)
    postToFrame(frame(), hostMessage({ type: "set-mode", nonce: nonceRef.current, editing: false }))
    current.setEditing(false)
    try {
      await options.controller.reload(current.document.id)
      saveLog(`conflict-load-disk path=${current.document.path}`)
    } catch (error) {
      current.context.onError(error)
    } finally {
      setConflictBusy(false)
    }
  }

  const saveDraftCopy = async (): Promise<void> => {
    const current = sessionRef.current
    if (current === null || conflict === null || conflictBusy) return
    setConflictBusy(true)
    setConflictError(null)
    try {
      const copyPath = await writeDraftCopy(current.document.path, conflict.local)
      saveLog(`conflict-draft-copy path=${copyPath}`)
      toast.success(`${labels.htmlDraftCopySaved ?? "Draft copy saved"}: ${copyPath}`, {
        id: "html-draft-copy-saved"
      })
    } catch (error) {
      setConflictError(error instanceof Error ? error.message : String(error))
    } finally {
      setConflictBusy(false)
    }
  }

  const overwriteWithDraft = async (): Promise<void> => {
    const current = sessionRef.current
    if (current === null || conflict === null || conflictBusy) return
    setConflictBusy(true)
    setConflictError(null)
    try {
      const latest = await readLatestHtml(options.fs, current.document.path)
      options.previewControl.markSelfWrite(current.document.path)
      await options.fs.writeFile(current.document.path, new TextEncoder().encode(conflict.local), {
        mode: "replace",
        expectedVersion: latest.version
      })
      lastSaved.current = conflict.local
      setConflict(null)
      saveLog(`conflict-overwrite path=${current.document.path} version=${latest.version}`)
      await refreshPreview(current.document.id, current.document.path)
    } catch (error) {
      if (isVersionConflict(error) || isTransientReadRace(error)) {
        const latest = await readLatestHtml(options.fs, current.document.path).catch(() => null)
        if (latest !== null) setConflict({ ...conflict, current: latest.text, version: latest.version })
        setConflictError(labels.htmlSaveStillUpdating ?? "The file is still being updated. Try again.")
      } else {
        current.context.onError(error)
      }
    } finally {
      setConflictBusy(false)
    }
  }

  const editDisabled = blocked && !editing
  const editLabel = editing ? labels.finishEditHtml : labels.editHtml
  const items: ToolbarItem[] = [
    {
      key: "edit-html",
      variant: "primary",
      icon: editing ? <Check /> : <Pencil />,
      label: editLabel,
      title: blocked && !editing ? labels.htmlEditBlocked : editLabel,
      ariaLabel: editLabel,
      pressed: editing,
      disabled: editDisabled,
      keepSelection: false,
      onClick: () => (editing ? finishEditing() : startEditing())
    },
    {
      key: "undo",
      icon: <Undo2 />,
      title: labels.htmlUndoDelete,
      ariaLabel: labels.htmlUndoDelete,
      disabled,
      separator: true,
      onClick: runUndo
    },
    ...buttonSpecs(labels).map((spec) => ({
      key: spec.command,
      icon: spec.icon,
      title: spec.label,
      ariaLabel: spec.label,
      pressed: spec.pressed !== undefined ? state[spec.pressed] : undefined,
      disabled: disabled || (spec.requires !== undefined && !state[spec.requires]),
      separator: spec.separator,
      onClick: () => runCommand(spec.command)
    }))
  ]

  return (
    <>
      <Toolbar ariaLabel="HTML formatting" items={items} />
      <Dialog open={conflict !== null} onOpenChange={(open) => !open && setConflict(null)}>
        <DialogContent className="max-w-4xl" data-testid="html-save-conflict">
          <DialogHeader>
            <DialogTitle>{labels.htmlSaveConflict ?? "Content changed on disk"}</DialogTitle>
            <DialogDescription>
              {labels.htmlSaveConflictDescription ??
                "The local draft was kept. Compare it with the current file before choosing what to keep."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[55vh] min-h-0 grid-cols-2 gap-3">
            <section className="flex min-h-0 flex-col gap-1.5">
              <h3 className="text-sm font-medium">{labels.htmlLocalDraft ?? "Local draft"}</h3>
              <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
                {conflict?.local ?? ""}
              </pre>
            </section>
            <section className="flex min-h-0 flex-col gap-1.5">
              <h3 className="text-sm font-medium">{labels.htmlDiskVersion ?? "Current file"}</h3>
              <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
                {conflict?.current ?? ""}
              </pre>
            </section>
          </div>
          <DialogFooter className="flex-wrap">
            <div className="me-auto min-h-4 text-xs text-destructive" role="status">
              {conflictError}
            </div>
            <Button type="button" variant="outline" disabled={conflictBusy} onClick={() => void saveDraftCopy()}>
              {labels.htmlSaveDraftCopy ?? "Save draft copy"}
            </Button>
            <Button type="button" variant="outline" disabled={conflictBusy} onClick={() => void loadDiskVersion()}>
              {labels.htmlUseDiskVersion ?? "Load file version"}
            </Button>
            <Button type="button" variant="outline" disabled={conflictBusy} onClick={() => void overwriteWithDraft()}>
              {labels.htmlOverwriteDraft ?? "Overwrite with draft"}
            </Button>
            <Button type="button" disabled={conflictBusy} onClick={() => setConflict(null)}>
              {labels.htmlKeepDraft ?? "Keep editing draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface ToolbarButtonSpec {
  command: WysiwygCommand
  label: string
  icon: ReactNode
  pressed?: keyof FormatState
  requires?: keyof FormatState
  separator?: boolean
}

function buttonSpecs(labels: WysiwygLabels): ToolbarButtonSpec[] {
  return [
    { command: "bold", label: labels.bold, icon: <Bold />, pressed: "bold" },
    { command: "italic", label: labels.italic, icon: <Italic />, pressed: "italic" },
    { command: "underline", label: labels.underline, icon: <Underline />, pressed: "underline" },
    { command: "strike", label: labels.strikethrough, icon: <Strikethrough />, pressed: "strike" },
    { command: "inlineCode", label: labels.inlineCode, icon: <Code />, pressed: "code", separator: true },
    { command: "codeBlock", label: labels.codeBlock, icon: <SquareCode />, pressed: "codeBlock" },
    { command: "blockquote", label: labels.blockquote, icon: <Quote />, pressed: "blockquote", separator: true },
    { command: "bulletList", label: labels.bulletList, icon: <List />, pressed: "ul" },
    { command: "orderedList", label: labels.orderedList, icon: <ListOrdered />, pressed: "ol" },
    { command: "outdent", label: labels.outdent, icon: <IndentDecrease /> },
    { command: "indent", label: labels.indent, icon: <IndentIncrease /> },
    { command: "deleteImage", label: labels.deleteImage, icon: <ImageMinus />, requires: "hasImage", separator: true }
  ]
}
