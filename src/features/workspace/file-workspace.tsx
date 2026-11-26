import type { Job, RemoteId } from "@alwith/module-drive"
import {
  ChatCondenseEntry,
  type CondenseScope,
  DriveCondense,
  DriveMoveDialog,
  drivePreviewIntegrations,
  isYuplinkName,
  resolveDriveRoot
} from "@alwith/module-drive/content"
import { DriveBadge, useDrive } from "@alwith/module-drive/react"
import {
  type CloseDecision,
  createEditorController,
  createEditorWorkspace,
  type EditorController,
  type EditorLabels,
  type EditorWorkspaceController,
  ImagePreview
} from "@alwith/module-editor"
import {
  createFileTreeController,
  FileTree,
  type FileTreeController,
  type FileTreeLabels
} from "@alwith/module-file-tree"
import { containsPath, createFileSystem, dirname, type FileSystem, normalizePath } from "@alwith/module-fs"
import { createTauriAdapter } from "@alwith/module-fs/tauri"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { confirm } from "@tauri-apps/plugin-dialog"
import { Effect } from "effect"

import { ContextMenuItem } from "@/components/ui/context-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { openFilePreview } from "@/features/chat/dialogs/file-preview-modal"
import { DRAFT_SESSION_ID } from "@/features/chat/draft-chat"
import { appendQuote, focusComposer, SelectionMenu } from "@/features/chat/selection-menu"
import { collaborationOwner, useCollaborationOwner } from "@/features/drive/collaboration-owners"
import { DriveDocumentSurface, useDriveContentHost } from "@/features/drive/content-host"
import { driveControls, driveDialogClassName } from "@/features/drive/controls"
import { useDriveDeepLinks } from "@/features/drive/deep-links"
import { drive, DriveSharingDialog } from "@/features/drive/drive"
import { prepareWorkspaceFile } from "@/features/drive/files"
import { driveFileSystem } from "@/features/drive/filesystem"
import { rebaseDrivePins } from "@/features/drive/pinned"
import { DriveTreeActions } from "@/features/drive/tree-actions"
import { useDriveVisible } from "@/features/drive/use-drive-visible"
import { ExtensionMount } from "@/features/extensions/extension-view"
import { setActivePreview } from "@/lib/active-preview"
import { describeError } from "@/lib/error-text"
import { openExternal } from "@/lib/open"

import { createWatchRelay } from "./watch-relay"
import "@alwith/module-file-tree/styles.css"
import "@alwith/module-editor/styles.css"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { revealItemsInDir } from "@tauri-apps/plugin-opener"
import { ChartColumn, FolderOpen, FolderTree, MessageSquare, RefreshCw } from "lucide-react"
import {
  lazy,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/alwith-ui/button"
import { WindowsWorkspaceControlsContext } from "@/components/alwith-ui/windows-main-window-shell"
import { useTheme } from "@/components/theme-provider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ChatContextMenu, type ContextMenuTarget, selectionRectOf } from "@/features/chat/chat-context-menu"
import { ChatDirectoryContext } from "@/features/chat/file-actions"
import { CanvasContext } from "@/features/layout/lib/canvas-context"
import { isChatOwnDirectory, isTemporaryChatDir } from "@/lib/quick-chat"

import { type FilePosition, WorkspaceContext, WorkspaceHeaderContext } from "./context"
import { useHostDialog } from "./host-dialog"
import {
  getOnlineBiEmbedSrc,
  ONLINE_BI_URL,
  ONLINE_BI_VIEW_ID,
  saveOnlineBiPath,
  stripOnlineBiToken
} from "./online-bi"
import { OnlineBiNativeView } from "./online-bi-embed"
import type { PanelControls } from "./panel-controls-context"
import { usePreviewExtension } from "./preview-extension"
import { applyStoredCommentsVisibility, commentsHidden, setCommentsHidden } from "./preview-resources"
import { PreviewSurface } from "./preview-surface"
import { createResilientWriteFileSystem } from "./resilient-write-fs"
import { WorkspaceButton } from "./workspace-button"
import { WorkspaceEditor } from "./workspace-editor"
import { WorkspacePanels } from "./workspace-panels"
import "./workspace.css"
import { routeHistory, routeReplace } from "./editor-shortcuts"
import { createHtmlPreviewHost } from "./html-preview"
import { createWysiwygHtmlIntegration, freezeHtmlSourceDuringEditing, HTML_EDITING_ATTRIBUTE } from "./html-wysiwyg"
import { localPreviewProviders } from "./local-previews"
import { createWysiwygMarkdownIntegration, LARGE_MARKDOWN_BYTES, MARKDOWN_EDITING_ATTRIBUTE } from "./markdown-wysiwyg"
import { MoveToDialog } from "./move-to-dialog"
import { moveWorkspaceFiles, type WorkspaceMoveOutcome } from "./move-workspace-files"
import { resolvePreviewResource } from "./preview-resources"
import {
  DRAFT_DIRECTORY_KEY,
  projectDirectoryAttempt,
  projectDirectoryFor,
  type ProjectDirectoryReason,
  type WorkspaceEmptyReason
} from "./project-directory"
import { createTreeOpener } from "./tree-opener"
import { useTreeVisiblePreference } from "./tree-visible-preference"
import { useEditorPreferences } from "./use-editor-preferences"
import { WorkspaceEmptyState } from "./workspace-empty-state"
import { openWorkspaceScope, workspaceTask } from "./workspace-lifecycle"
import {
  createWorkspaceSessionStore,
  createWorkspaceStateStore,
  type IconTheme,
  type WorkspaceState
} from "./workspace-state"
import type { WysiwygLabels } from "./wysiwyg-types"
import "@alwith/module-editor/previews/styles.css"

const loadMonaco = () => import("./monaco-editor")
const CodeEditor = lazy(loadMonaco)
interface Workspace {
  root: string
  fs: FileSystem
  tree: FileTreeController
  editor: EditorController
  tabs: EditorWorkspaceController
  treeOpener: ReturnType<typeof createTreeOpener>
  iconTheme: IconTheme
  /** Files the current editor state under the project and the conversation that owns it. */
  persistState: () => void
}
const emptyEditorSnapshot = (): null => null
const noEditorSubscription = (): (() => void) => () => {}
function report(error: unknown): void {
  toast.error(describeError(error))
}

/** Which empty-state message a directory resolution calls for; `null` means "workspace is loading". */
function emptyReasonFor(reason: ProjectDirectoryReason, cwd: string | null): WorkspaceEmptyReason | null {
  if (cwd === null) return reason === "invalid" ? "invalid" : "missing"
  if (reason === "invalid") return "invalid"
  // A conversation's own quick-chat folder is a real, locatable workspace; only the root (or an
  // unclassified temporary path) has no files to show.
  if ((reason === "temporary" || isTemporaryChatDir(cwd)) && !isChatOwnDirectory(cwd)) return "temporary"
  return null
}

/** Which hint to show when a click cannot open a workspace. */
function emptyHintKey(reason: ProjectDirectoryReason): string {
  if (reason === "invalid") return "workspace.invalidDirectoryHint"
  if (reason === "temporary") return "workspace.selectFileHint"
  return "workspace.noDirectoryHint"
}
/**
 * True when the right-click belongs to the file tree, which brings its own menu (open / reveal /
 * rename / delete). The editor surface wraps the tree and would otherwise swallow the click into
 * the text menu — the one with Translate and Share, and no file actions at all.
 */
export function ownsItsContextMenu(target: Element): boolean {
  return target.closest(".alwith-file-tree, [data-file-path]") !== null
}

export function FileWorkspace({
  cwd,
  children,
  sessionId = null,
  chatRevealRequest = 0,
  defaultOpen = false,
  columnsRequest = 0,
  busy = false,
  reason = "project",
  guidance = null,
  invalidDirectory = null,
  directoryKey,
  draft = false,
  chat = false
}: {
  cwd: string | null
  children: ReactNode
  /** The conversation on screen; opening another one restores the four-column layout. */
  sessionId?: string | null
  chatRevealRequest?: number
  /** Opens the preview pane once per project so the app starts with all four columns visible. */
  defaultOpen?: boolean
  /** Bumped when the reader explicitly starts a chat in a project: open all four columns again. */
  columnsRequest?: number
  /**
   * An agent turn is running. File-watch reloads are held while this is true and replayed once it
   * turns false, so an AI editing a document does not make the preview flicker under the reader.
   */
  busy?: boolean
  /** Why the resolved directory is (not) a project; drives the actionable empty state. */
  reason?: ProjectDirectoryReason
  /** Extra, caller-supplied guidance shown next to the empty state and in the click toast. */
  guidance?: string | null
  /** The rejected path when `reason === "invalid"`, so 一键修复 knows what to heal. */
  invalidDirectory?: string | null
  /**
   * The exact key the app used to resolve this surface's directory (`selectedId ?? __draft__`).
   * `session` can still be null in the frame where `selectedId` is already set, so deriving the key
   * from `sessionId` here would write a repair/folder pick under `__draft__` and leave the selected
   * conversation unresolved. Standalone tests omit it and fall back to `sessionId ?? __draft__`.
   */
  directoryKey?: string
  /** A brand-new task: the workspace and file tree must not be openable at all. */
  draft?: boolean
  /** A temporary conversation (quick chat): it owns a folder for its own files, but no workspace UI. */
  chat?: boolean
}) {
  const windowsControls = useContext(WindowsWorkspaceControlsContext)
  const { resolvedTheme } = useTheme()
  const { t, i18n } = useTranslation(),
    { ask, dialog } = useHostDialog()
  // Every directory read/write inside this component (retry, invalid path, empty-state repair and
  // folder pick) uses this one key, so it always lands on the binding the app resolves against.
  const projectBindingKey = directoryKey ?? sessionId ?? DRAFT_DIRECTORY_KEY
  const workspaces = useRef(new Map<string, Workspace>()),
    opening = useRef(new Map<string, Promise<Workspace>>())
  // File-watch events produced while an agent turn is running are buffered per workspace and
  // replayed when the turn ends, so the preview only reloads once the AI has finished editing.
  const pendingChanges = useRef(new Map<string, Set<string>>())
  const changeHandlers = useRef(new Map<string, (paths: string[]) => void>())
  const busyRef = useRef(busy)
  busyRef.current = busy
  const saveDriveDocument = useCallback(async (path: string): Promise<void> => {
    for (const owner of workspaces.current.values()) {
      const document = owner.editor.getSnapshot().documents.find((document) => document.path === path)
      if (document) {
        await owner.editor.save(document.id)
        return
      }
    }
    // Closed files already have their latest contents on disk.
  }, [])
  const contentHost = useDriveContentHost(saveDriveDocument)
  const routeDriveTarget = useRef<(path: string) => Promise<void>>(() => {
    return Promise.try(() => {
      throw new Error("Workspace navigation is not ready")
    })
  })
  const lifecycle = useRef(new AbortController())
  const stateStore = useMemo(() => createWorkspaceStateStore(), [])
  const sessionStore = useMemo(() => createWorkspaceSessionStore(), [])
  // The conversation whose tabs the editor currently holds. Read by the persistence path so a
  // snapshot is always filed under the conversation that produced it, even though the workspace
  // instance itself outlives the switch.
  const openFor = useRef<string | null>(sessionId)
  // Which workspace instance has actually been reconciled against which conversation. Tracked by
  // object identity, not by session id alone: leaving a project and coming back rebuilds the
  // workspace from the project record, and that record is not this conversation's view.
  const applied = useRef<{ workspace: Workspace; session: string | null } | null>(null)
  // Set while `applySession` is closing and reopening documents: the editor emits a snapshot for
  // every step of that, and filing those would overwrite the target conversation with the
  // half-restored intermediate state.
  const restoring = useRef(false)
  const { settings, iconTheme } = useEditorPreferences()
  const [sharingPath, setSharingPath] = useState<string | null>(null)
  const [condenseJob, setCondenseJob] = useState<Job | undefined>()
  const [condenseScope, setCondenseScope] = useState<CondenseScope | null>(null)
  const [moveTarget, setMoveTarget] = useState<{ path: string; kind: "file" | "directory" } | null>(null)
  const [publishSources, setPublishSources] = useState<{ owner: Workspace; paths: readonly string[] } | null>(null)
  const [moveSources, setMoveSources] = useState<{ owner: Workspace; paths: readonly string[] } | null>(null)
  const condenseHost = useMemo(
    () => ({
      readSnooze: (id: RemoteId): Promise<number | null> => {
        return Promise.try(() => {
          const profile = drive.getSnapshot().snapshot
          const raw = localStorage.getItem(
            `alwith:drive:condense-snooze:${profile?.baseUrl}:${profile?.localRoot}:${id}`
          )
          if (raw === null) return null
          const value = Number(raw)
          if (!Number.isFinite(value)) throw new Error("Invalid Drive suggestion preference")
          return value
        })
      },
      writeSnooze: (id: RemoteId, until: number): Promise<void> => {
        return Promise.try(() => {
          const profile = drive.getSnapshot().snapshot
          localStorage.setItem(
            `alwith:drive:condense-snooze:${profile?.baseUrl}:${profile?.localRoot}:${id}`,
            String(until)
          )
        })
      }
    }),
    []
  )
  const panelControls = useRef<PanelControls | null>(null)
  const headerTarget = useContext(WorkspaceHeaderContext)
  // Closed by default for embedding tests; the main window asks for the four-column layout.
  const [visible, setVisible] = useState(defaultOpen),
    [viewMode, setViewMode] = useState(false)
  // BI Metrics takes over the preview pane; the sidebar no longer carries a full-page entry.
  const previewExtension = usePreviewExtension((state) => state.id)
  const closePreviewExtension = usePreviewExtension((state) => state.close)
  // The embed URL carries the BI token (`?s=`), which is how a cross-site frame can be logged in.
  const [biSrc, setBiSrc] = useState<string | null>(null)
  // Bumped to remount the frame; a WebView keeps its own history across src changes.
  const [biReload, setBiReload] = useState(0)
  // Editable copy of the frame URL. The preview is a test surface for now: any bi.finture.id path
  // can be tried without a rebuild, and the stored token is carried over when the pasted URL has
  // none of its own.
  const [biDraft, setBiDraft] = useState("")
  // 评论栏 is the drive module's own column; this switch hides it for good instead of collapsing it.
  const [commentsOff, setCommentsOff] = useState(() => commentsHidden())
  useEffect(() => {
    applyStoredCommentsVisibility()
  }, [])
  // The file tree remembers being closed: a project visit must not reopen a column the reader
  // collapsed on purpose. The toggle in the tree header (and its shortcut) is the way back.
  const [treeVisible, setTreeVisible] = useTreeVisiblePreference()
  const canvas = useContext(CanvasContext)
  const navigateCanvas = canvas?.navigate
  // A temporary chat has none of these columns, so its window header carries no switches for them.
  // Leaving them visible offered 评论栏 / 文件树 / 工作区 on a surface that has no tree to hide.
  const temporaryChat = isTemporaryChatDir(cwd) && !isChatOwnDirectory(cwd)
  // A draft has no directory yet, and a temporary chat is not a project: every workspace entry
  // point stays shut for both. The chat keeps its own folder for file operations, but the tree,
  // preview and 四方格 controls never appear.
  const workspaceAllowed = !draft && !chat
  // P0-5: hiding the *whole* toolbar for a temporary chat (or a chat whose directory has not
  // arrived) removed the only buttons that could explain why 文件栏 does nothing. Keep 四方格 and
  // 文件栏 always reachable; only the chat-specific actions are hidden when there is no directory.
  const showMainControls = canvas === null || canvas.selected === 1
  const hasProjectDirectory = cwd !== null && !temporaryChat
  const [emptyReason, setEmptyReason] = useState<WorkspaceEmptyReason | null>(() => emptyReasonFor(reason, cwd))
  const reportEmptyState = useCallback((): void => {
    setEmptyReason(emptyReasonFor(reason, cwd))
  }, [reason, cwd])
  useEffect(() => {
    reportEmptyState()
  }, [reportEmptyState])
  /**
   * Called by the empty state after a repair, a folder pick or a plain retry. A successful repair
   * writes a binding synchronously, so check it here: the app's re-render (with the healed `cwd`)
   * is one frame away, and showing the "no directory" message in that gap read as a failed fix.
   */
  const retryWorkspace = useCallback((): void => {
    const bound = projectDirectoryFor(projectBindingKey)
    const ready = bound !== null || (cwd !== null && (!isTemporaryChatDir(cwd) || isChatOwnDirectory(cwd)))
    setEmptyReason(ready ? null : emptyReasonFor(reason, cwd))
    setViewMode(false)
    setVisible(true)
  }, [projectBindingKey, cwd, reason])
  const previousChatRevealRequest = useRef(chatRevealRequest)
  useEffect(() => {
    if (previousChatRevealRequest.current === chatRevealRequest) return
    previousChatRevealRequest.current = chatRevealRequest
    // New and returned chats must be visible even when the chat pane was collapsed.
    setViewMode(false)
    navigateCanvas?.("chat")
  }, [chatRevealRequest, navigateCanvas])
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  useEffect(() => {
    // Switching projects must not keep the previous project's BI surface in the preview pane.
    closePreviewExtension()
  }, [workspace?.root, closePreviewExtension])
  useEffect(() => {
    // The sidebar opens BI into the preview column even while the column is collapsed.
    if (previewExtension !== null) setVisible(true)
  }, [previewExtension])
  // Plain URL by default: the dashboard keeps its own first-party session inside the frame, so the
  // login screen is the expected entry point. `?s=<JWT>` stays available as an opt-in — it is the
  // session token the app can also capture from the standalone window — but it is no longer the
  // default, and the address bar can load any path with or without it.
  const refreshBiSrc = useCallback(() => {
    let cancelled = false
    void getOnlineBiEmbedSrc()
      .then((url) => {
        if (cancelled) return
        setBiSrc(stripOnlineBiToken(url))
      })
      .catch((error: unknown) => console.error("[online-bi] embed url", error))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (previewExtension !== ONLINE_BI_VIEW_ID) return
    const cancel = refreshBiSrc()
    return cancel
  }, [previewExtension, refreshBiSrc])

  useEffect(() => {
    if (biSrc !== null) setBiDraft(biSrc)
  }, [biSrc])

  /** Loads whatever is typed in the address field, keeping the signed-in token when it fits. */
  const loadBiUrl = useCallback(
    (raw: string) => {
      const value = raw.trim()
      if (value === "") return
      let next = value
      try {
        const parsed = new URL(value)
        // Remember where the reader went: next time the preview opens here. No settings field.
        saveOnlineBiPath(parsed.pathname)
      } catch {
        toast.error(t("settings.onlineBiUrlInvalid"))
        return
      }
      setBiSrc(next)
      setBiReload((count) => count + 1)
    },
    [t]
  )

  // Which projects have already opened their four columns. A project opens once; a chat never
  // opens them, and closing the preview inside a project keeps it closed on the next visit.
  const openedProjects = useRef(new Set<string>())
  // Whether the previous render belonged to a project. Moving from a project to a chat is the one
  // transition that has to close columns the user did not close themselves.
  const wasProject = useRef(defaultOpen)
  useEffect(() => {
    if (draft) {
      setViewMode(false)
      setVisible(false)
      reportEmptyState()
      return
    }
    const project = defaultOpen
    const leftProject = wasProject.current && !project
    wasProject.current = project
    if (!project) {
      // A temporary chat has no files next to it: only the sidebar and the conversation remain.
      if (leftProject) {
        setViewMode(false)
        setVisible(false)
      }
      // No bare return: remember *why* there is no workspace so the tree toggle can explain it.
      reportEmptyState()
      return
    }
    if (cwd === null) {
      // Reached only while `defaultOpen` is true (a project, or an `invalid` directory whose repair
      // hint must be visible immediately). `missing` is NOT auto-opened by app.tsx: a fresh install
      // starts in two columns, and clicking 文件栏 / 四方格 calls showProjectTree() (or toggle()),
      // which opens the column and shows the guidance instead of forcing an empty pane up front.
      reportEmptyState()
      setTreeVisible(true)
      setVisible(true)
      return
    }
    if (openedProjects.current.has(cwd)) {
      reportEmptyState()
      return
    }
    openedProjects.current.add(cwd)
    // Opening `visible` is what makes the cwd effect load the workspace, so this must not wait
    // for `workspace` to exist (that would deadlock the four-column layout).
    reportEmptyState()
    setVisible(true)
  }, [defaultOpen, cwd, setTreeVisible, reportEmptyState, draft])
  // An explicit "create a chat in this project" always shows the four columns, even for a project
  // that was opened (and maybe collapsed) earlier in this run. `openedProjects` still keeps the
  // ordinary revisits quiet; this signal deliberately bypasses it.
  useEffect(() => {
    if (draft || columnsRequest === 0 || !defaultOpen || cwd === null) {
      reportEmptyState()
      return
    }
    openedProjects.current.add(cwd)
    setTreeVisible(true)
    setVisible(true)
    reportEmptyState()
  }, [columnsRequest, defaultOpen, cwd, setTreeVisible, reportEmptyState, draft])
  // Opening any conversation of a project restores the four columns — session list, chat, file tree
  // and preview. This is keyed by the conversation, not by the project: entering the same project
  // again through another chat (or through the floated chat window) must not inherit the collapsed
  // state a previous visit left behind.
  useEffect(() => {
    if (!defaultOpen || cwd === null || sessionId === null) {
      reportEmptyState()
      return
    }
    openedProjects.current.add(cwd)
    setTreeVisible(true)
    setVisible(true)
    reportEmptyState()
  }, [sessionId, defaultOpen, cwd, setTreeVisible, reportEmptyState])
  const [navigation, setNavigation] = useState<{ path: string; position: FilePosition } | null>(null)
  const editorSnapshot = useSyncExternalStore(
    workspace ? workspace.editor.subscribe : noEditorSubscription,
    workspace ? workspace.editor.getSnapshot : emptyEditorSnapshot
  )
  const tabSnapshot = useSyncExternalStore(
    workspace ? workspace.tabs.subscribe : noEditorSubscription,
    workspace ? workspace.tabs.getSnapshot : emptyEditorSnapshot
  )
  const activeDocument = editorSnapshot?.documents.find((document) => document.id === tabSnapshot?.activeId)
  const activePath = activeDocument?.path ?? null
  const markdownPreview = /\.(md|markdown|mdown|mdx)(\.yupcloud)?$/i.test(activePath ?? "")
  // Publish the previewed document so the chat can scope the user's next message to it. Only an
  // actually visible preview counts: a closed pane (or an empty editor) must not carry context.
  useEffect(() => {
    setActivePreview(
      visible && workspace !== null && activeDocument?.path
        ? {
            path: activeDocument.path,
            title: activeDocument.path.split(/[\\/]/).pop() ?? activeDocument.path,
            // The mounted workspace's root, not the `cwd` prop: while switching projects the old
            // workspace stays mounted, and pairing its document with the new project would attach
            // the wrong file to the next prompt.
            root: workspace.root
          }
        : null
    )
  }, [visible, workspace, activeDocument?.path])
  // Drop the published document when the workspace unmounts so a stale path never leaks into the
  // next surface's prompts.
  //
  // Swapping the open documents when the reader moves between conversations of the same project.
  // The workspace itself stays mounted — it holds the tree, the editor and any unsaved buffers —
  // so without this every chat in a project showed the same document, and the preview published to
  // the composer (and therefore the file the next message is scoped to) belonged to whichever chat
  // had opened it last.
  useEffect(() => {
    if (workspace === null) return
    if (applied.current?.workspace === workspace && applied.current.session === sessionId) return
    applied.current = { workspace, session: sessionId }
    // `persistState` reads this ref on every editor change, so it has to move first: the close/open
    // steps below are suppressed by `restoring`, but anything the reader does afterwards belongs to
    // the conversation now on screen.
    openFor.current = sessionId
    if (sessionId === null) return
    const target = workspace
    void sessionStore
      .load(target.root, sessionId)
      .then(async (saved) => {
        // No record yet: this conversation has never opened a file, so it keeps showing whatever
        // the project has on screen. The first edit records it, and the two diverge from there.
        if (saved === null) return
        restoring.current = true
        // Only a completed restore may re-file the record. Abandoning it (the reader cancelled the
        // unsaved-changes prompt) leaves the previous conversation's tabs on screen, and filing
        // those under this conversation would erase what it actually had open.
        let restored = false
        try {
          const before = target.editor.getSnapshot()
          const wanted = new Set(saved.tabs.map((tab) => tab.path))
          const extra = before.documents.filter((doc) => !wanted.has(doc.path)).map((doc) => doc.id)
          // Closing first keeps the reopened order identical to the saved one. A reader who cancels
          // the unsaved-changes prompt keeps the current view rather than half a restore.
          if (extra.length > 0 && !(await target.editor.requestCloseMany(extra))) return
          for (const tab of saved.tabs) {
            const document = await target.editor.open(tab.path).catch(() => null)
            if (document !== null && tab.pinned) target.editor.pin(document.id)
          }
          const after = target.editor.getSnapshot()
          const active = after.documents.find((doc) => doc.path === saved.activePath)
          if (active !== undefined) target.editor.activate(active.id)
          restored = true
        } finally {
          restoring.current = false
          // File the restored view under this conversation explicitly. `persistState` skips the
          // session write whenever the project record is unchanged, and this record has to be
          // right even when two conversations happen to hold the same tabs.
          if (restored) {
            const settled = target.editor.getSnapshot()
            void sessionStore
              .save(target.root, sessionId, {
                tabs: settled.documents.map((doc) => ({ path: doc.path, pinned: doc.pinned })),
                activePath: settled.documents.find((doc) => doc.id === settled.activeId)?.path ?? null
              })
              .catch(report)
          }
          // The project record still carries the previous conversation's tabs, and a brand-new
          // chat inherits from it.
          target.persistState()
        }
      })
      .catch((error: unknown) => {
        restoring.current = false
        report(error)
      })
  }, [sessionId, workspace, sessionStore])

  const [previewMenu, setPreviewMenu] = useState<ContextMenuTarget | null>(null)
  // Text selected inside the previewed HTML frame (forwarded by the bridge): the frame's own
  // selection never reaches this document, so the host renders the copy pill itself.
  const [previewSelection, setPreviewSelection] = useState<{
    left: number
    top: number
    text: string
    path: string
    onComment?: () => void
  } | null>(null)
  const previewEditorRef = useRef<HTMLDivElement | null>(null)
  const noSelectionRoot = useRef<HTMLDivElement | null>(null)
  // The composer on screen belongs to the selected conversation; before the first message the
  // draft chat owns it. Both the floating pill and the right-click menu quote into that composer.
  const composerSessionId = sessionId ?? DRAFT_SESSION_ID
  const dismissPreviewSelection = useCallback(() => setPreviewSelection(null), [])
  const addSelectionToChat = useCallback(
    (text: string): void => {
      if (!appendQuote(composerSessionId, text)) {
        toast.error(t("chat.selectionAddFailed"))
        return
      }
      focusComposer()
    },
    [composerSessionId, t]
  )
  // Where the pointer was when the preview asked for its menu. A frame's own coordinates drift
  // under zoom and scrolling, so the window position recorded here is the reliable anchor.
  const pointer = useRef({ x: 0, y: 0 })
  useEffect(() => {
    const track = (event: MouseEvent): void => {
      pointer.current = { x: event.clientX, y: event.clientY }
    }
    window.addEventListener("mousemove", track, { passive: true })
    return () => window.removeEventListener("mousemove", track)
  }, [])
  useEffect(() => () => setActivePreview(null), [])
  // A selection belongs to one visible file. Closing the pane, switching tabs or opening another
  // surface drops the pill immediately; it never waits for the frame to announce an empty range.
  useEffect(() => {
    setPreviewSelection(null)
    setPreviewMenu(null)
  }, [activePath, visible, previewExtension])
  // Clicking or focusing anything outside the preview pane dismisses a frame-forwarded selection.
  // The pill lives at document.body (above the iframe) but belongs to the pane, so its own clicks
  // are explicitly exempt.
  useEffect(() => {
    const dismissOutsidePreview = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Element) || target.closest(".file-workspace-editor, [data-selection-menu]") !== null)
        return
      setPreviewSelection(null)
    }
    document.addEventListener("pointerdown", dismissOutsidePreview, true)
    document.addEventListener("focusin", dismissOutsidePreview, true)
    return () => {
      document.removeEventListener("pointerdown", dismissOutsidePreview, true)
      document.removeEventListener("focusin", dismissOutsidePreview, true)
    }
  }, [])
  // The tree, the tabs and the editor keep their own functional context menus (rename, copy path,
  // close others…), so nothing here replaces them with a document-level menu — that would swallow
  // their actions. Only the previewed document needs the translated menu, and it lives in an
  // iframe the document never sees, so it is handled by the message listener below.
  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      const data = event.data as {
        source?: unknown
        type?: unknown
        text?: unknown
        x?: unknown
        y?: unknown
        rect?: unknown
        canComment?: unknown
        repositionOnly?: unknown
        frameToken?: unknown
      } | null
      if (!data || data.source !== "alwith-preview" || (data.type !== "selection" && data.type !== "context-menu"))
        return
      const editor = previewEditorRef.current
      if (!editor || typeof data.frameToken !== "string") return
      const frame = Array.from(editor.querySelectorAll("iframe")).find(
        (element) => element.contentWindow === event.source
      )
      // A table-of-contents link changes location.href in the frame, not the iframe's src.
      // Ignore only the fragment; a different capability, file or query still identifies a different preview.
      if (!frame || !frame.src || frame.src.split("#", 1)[0] !== data.frameToken.split("#", 1)[0]) return
      if (data.type === "selection") {
        const text = typeof data.text === "string" ? data.text.trim() : ""
        if (!visible || previewExtension !== null || activePath === null || !/\.(html?|xhtml)$/i.test(activePath))
          return
        const box = frame.getBoundingClientRect()
        const rect = data.rect as { left?: number; top?: number; bottom?: number; width?: number } | null
        if (text === "" || rect == null) {
          setPreviewSelection(null)
          return
        }
        // In WYSIWYG edit mode the iframe body is contenteditable; suppress the copy/quote pill so
        // it doesn't overlap the editing surface — native cut/copy/paste is available instead.
        if (frame.getAttribute(HTML_EDITING_ATTRIBUTE) === "true") {
          setPreviewSelection(null)
          return
        }
        // Account for iframe zoom: rect is in the iframe's own coordinate space, so scale by the
        // ratio of the on-screen box width to the frame's intrinsic offsetWidth.
        const a = box.width / (frame.offsetWidth || box.width)
        const left = box.left + (Number(rect.left ?? 0) + Number(rect.width ?? 0) / 2) * a - 98
        const top = box.top + Number(rect.bottom ?? 0) * a + 8
        if (data.repositionOnly === true) {
          setPreviewSelection((current) =>
            current?.path === activePath && current.text === text ? { ...current, left, top } : current
          )
          return
        }
        setPreviewSelection({
          left,
          top,
          text: text.slice(0, 20_000),
          path: activePath,
          onComment:
            data.canComment === true
              ? () => {
                  if (frame.isConnected)
                    frame.contentWindow?.postMessage({ source: "alwith-preview-host", type: "comment" }, "*")
                }
              : undefined
        })
        return
      }
      const rect = frame.getBoundingClientRect()
      // Scale the in-frame pointer coordinates by the iframe zoom ratio. The parent window's own
      // pointer (pointer.current) is unreliable here: mousemove inside the iframe never bubbles to
      // the parent, so the last position before entering the frame is often 0. Prefer the scaled
      // formula; when a === 1 (no zoom) keep the measured pointer as a fallback.
      const a = rect.width / (frame.offsetWidth || rect.width || 1)
      const x = a === 1 && pointer.current.x > 0 ? pointer.current.x : rect.left + Number(data.x ?? 0) * a
      const y = a === 1 && pointer.current.y > 0 ? pointer.current.y : rect.top + Number(data.y ?? 0) * a
      // While the HTML frame is in WYSIWYG edit mode its body is contenteditable, so cut/paste
      // apply. The frame's own editing state never reaches this document; the toolbar marks the
      // live iframe element instead.
      const editable = frame.getAttribute(HTML_EDITING_ATTRIBUTE) === "true"
      // In edit mode the native browser right-click menu (cut/copy/paste) is what the user wants,
      // not the translated preview menu — skip it (the Rust bridge already lets it through, see T03).
      if (editable) return
      setPreviewMenu({
        x,
        y,
        text: typeof data.text === "string" ? data.text : "",
        editable
      })
    }
    window.addEventListener("message", handler)
    return () => {
      window.removeEventListener("message", handler)
      setPreviewSelection(null)
    }
  }, [activePath, visible, previewExtension])
  // Previews rendered in this document (Markdown, PDF, images, spreadsheets, Word) are not frames,
  // so their right-click never reaches the bridge above. Scope the menu to the preview surface
  // by excluding the parts that own functional menus: the editor canvas, the tab strip and text
  // fields. Everything else inside the surface is a preview.
  const previewContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (ownsItsContextMenu(target)) return
    // Markdown/HTML edit mode owns the pointer: no translated menu, no "添加到对话". Native
    // cut/copy/paste stays available, exactly like the HTML frame's edit mode.
    if (target.closest(`[${MARKDOWN_EDITING_ATTRIBUTE}="true"]`) !== null) return
    if (
      target.closest(
        '[contenteditable="true"], [contenteditable=""], textarea, input, .cm-editor, .monaco-editor, [class*="tab"], [role="tablist"], [data-editor]'
      ) !== null
    )
      return
    event.preventDefault()
    event.stopPropagation()
    // Only the selected text: a preview's `textContent` is the whole document, and copying that on
    // a right-click without a selection would be a surprise.
    const selection = window.getSelection()?.toString().trim() ?? ""
    setPreviewMenu({
      x: event.clientX,
      y: event.clientY,
      text: selection,
      editable: false,
      selectionRect: selectionRectOf()
    })
  }
  const activeCollaborationOwner = useCollaborationOwner(activeDocument?.path)
  const driveVisible = useDriveVisible()
  const driveState = useDrive(drive).snapshot
  // With the drive switched off nothing may consult it: opening a plain file (memory.md) used to
  // surface "Drive is not running" from these lookups.
  const driveRoot =
    driveVisible && activeDocument
      ? driveState?.roots.find((root) => containsPath(root.localPath, activeDocument.path)) ?? null
      : null
  const driveFile =
    driveVisible && activeDocument
      ? driveState?.files.find((file) => file.localPath === activeDocument.path) ?? null
      : null
  // Drive preview integrations belong to documents that actually live in the drive. Handing them
  // to a plain file (memory.md in a local folder) made the collab probe own `editable()`: it stays
  // false while probing and only flips after the drive answers — with the drive unreachable that
  // disabled the Markdown Edit button outright. Local files use the plain providers.
  const activeIsDriveDocument = driveRoot !== null || driveFile !== null
  const driveReadOnly =
    Boolean(
      driveRoot &&
      (!driveState?.running ||
        !driveRoot.canWrite ||
        !driveRoot.syncEnabled ||
        driveRoot.cloudOnly ||
        driveRoot.kind === "SKILL")
    ) || driveFile?.state === "readOnly"
  // The Drive host changes whenever its snapshot does (its `generation` is a cache-busting
  // number). A preview is rebuilt whenever its host identity changes — the Markdown preview
  // recreates its whole Milkdown editor — so passing the live object meant every sync tick tore
  // down and rebuilt the open preview, and repeated clicks on a Markdown file could freeze the
  // window. Keep one object and refresh its fields in place instead: providers compare identity,
  // so a stable object stops the rebuilds while reads still see the current values.
  const contentHostRef = useRef(contentHost)
  contentHostRef.current = contentHost
  const previewHost = useMemo(() => ({ ...contentHost }), [])
  Object.assign(previewHost, contentHost)
  // Translations are read through a ref as well: the preview list must not be rebuilt on every
  // render just because the translator's identity moved, and a language change is the only thing
  // that actually needs new labels.
  const translateRef = useRef(t)
  translateRef.current = t
  const previews = useMemo(() => {
    if (!workspace) return []
    const imageLabels = {
      failed: translateRef.current("workspace.imageFailed"),
      zoomIn: translateRef.current("workspace.zoomIn"),
      zoomOut: translateRef.current("workspace.zoomOut"),
      resetZoom: translateRef.current("workspace.resetZoom")
    }
    // The native HTML host plus the WYSIWYG self-write/editing controls. Created once per
    // workspace so the iframe's rebuild identity stays stable across renders.
    const htmlPreviewHost = createHtmlPreviewHost(
      workspace.root,
      workspace.fs,
      invoke,
      navigator.userAgent.includes("Windows")
    )
    const wysiwygLabels: WysiwygLabels = {
      bold: translateRef.current("workspace.bold"),
      italic: translateRef.current("workspace.italic"),
      underline: translateRef.current("workspace.underline"),
      strikethrough: translateRef.current("workspace.strikethrough"),
      blockquote: translateRef.current("workspace.blockquote"),
      bulletList: translateRef.current("workspace.bulletList"),
      orderedList: translateRef.current("workspace.orderedList"),
      outdent: translateRef.current("workspace.outdent"),
      indent: translateRef.current("workspace.indent"),
      inlineCode: translateRef.current("workspace.inlineCode"),
      codeBlock: translateRef.current("workspace.codeBlock"),
      insertTable: translateRef.current("workspace.insertTable"),
      deleteRow: translateRef.current("workspace.deleteRow"),
      deleteColumn: translateRef.current("workspace.deleteColumn"),
      deleteImage: translateRef.current("workspace.deleteImage"),
      editHtml: translateRef.current("workspace.editHtml"),
      finishEditHtml: translateRef.current("workspace.finishEditHtml"),
      htmlEditBlocked: translateRef.current("workspace.htmlEditBlocked"),
      htmlDeleted: translateRef.current("workspace.htmlDeleted"),
      htmlUndoDelete: translateRef.current("workspace.htmlUndoDelete"),
      htmlSaveConflict: translateRef.current("workspace.htmlSaveConflict"),
      htmlSaveConflictDescription: translateRef.current("workspace.htmlSaveConflictDescription"),
      htmlLocalDraft: translateRef.current("workspace.htmlLocalDraft"),
      htmlDiskVersion: translateRef.current("workspace.htmlDiskVersion"),
      htmlKeepDraft: translateRef.current("workspace.htmlKeepDraft"),
      htmlUseDiskVersion: translateRef.current("workspace.htmlUseDiskVersion"),
      htmlOverwriteDraft: translateRef.current("workspace.htmlOverwriteDraft"),
      htmlSaveStillUpdating: translateRef.current("workspace.htmlSaveStillUpdating")
    }
    // Drive occupies both integration extension points only for drive documents; the WYSIWYG
    // wrappers layer on top and forward every base hook, so collaboration/comments keep working.
    // A local file must not carry the drive's probing state into its editable contract.
    const driveIntegrations = driveVisible && activeIsDriveDocument ? drivePreviewIntegrations(previewHost) : {}
    const providers = localPreviewProviders({
      ...driveIntegrations,
      createMarkdownIntegration: (document, context) =>
        createWysiwygMarkdownIntegration(
          driveIntegrations.createMarkdownIntegration?.(document, context),
          context,
          wysiwygLabels,
          // Large documents only mount Milkdown after the static preview's own "Edit Markdown"
          // press, so that explicit intent carries into the editor. Everything else opens in
          // preview and waits for the toolbar's Edit button.
          { startEditing: (document.bytes?.byteLength ?? 0) >= LARGE_MARKDOWN_BYTES }
        ),
      htmlIntegration: createWysiwygHtmlIntegration(driveIntegrations.htmlIntegration, {
        fs: workspace.fs,
        controller: workspace.editor,
        labels: wysiwygLabels,
        previewControl: htmlPreviewHost
      }),
      htmlPreview: htmlPreviewHost,
      openLink: openExternal,
      resolveResource: (path, reference) => resolvePreviewResource(workspace.fs, workspace.root, path, reference),
      openExternal,
      allowRemoteResources: true,
      autoSaveDelay: 800,
      imageLabels,
      labels: {
        loading: translateRef.current("workspace.previewsLoading"),
        openExternal: translateRef.current("workspace.openExternal"),
        legacyWord: translateRef.current("workspace.legacyWord"),
        mediaUnsupported: translateRef.current("workspace.mediaUnsupported"),
        emptySheet: translateRef.current("workspace.emptySheet"),
        worksheets: translateRef.current("workspace.worksheets"),
        bold: translateRef.current("workspace.bold"),
        italic: translateRef.current("workspace.italic"),
        outline: translateRef.current("workspace.outline"),
        outlineEmpty: translateRef.current("workspace.outlineEmpty"),
        editMarkdown: translateRef.current("workspace.editMarkdown"),
        copyCode: translateRef.current("workspace.copyCode"),
        toggleWrap: translateRef.current("workspace.toggleWrap"),
        previousSheet: translateRef.current("workspace.previousSheet"),
        nextSheet: translateRef.current("workspace.nextSheet"),
        page: translateRef.current("workspace.page"),
        thumbnails: translateRef.current("workspace.thumbnails"),
        zoomIn: translateRef.current("workspace.zoomIn"),
        zoomOut: translateRef.current("workspace.zoomOut"),
        resetZoom: translateRef.current("workspace.resetZoom")
      }
    })
    return [
      {
        id: "image",
        supports: (document: import("@alwith/module-editor").EditorDocument) =>
          /\.(png|jpe?g|webp|gif|bmp|avif|svg|ico)$/i.test(document.path),
        render: (document: import("@alwith/module-editor").EditorDocument) => (
          <ImagePreview document={document} labels={imageLabels} onError={report} />
        )
      },
      // The HTML provider rebuilds its iframe when document.savedText changes; freeze the source
      // while editing so our own save (which reloads the controller document) keeps the frame.
      ...providers.map((provider) =>
        provider.id === "html" ? freezeHtmlSourceDuringEditing(provider, htmlPreviewHost) : provider
      )
    ]
  }, [workspace, i18n.language, previewHost, driveVisible, activeIsDriveDocument])
  const reportedDirty = useRef(false)
  const requestGeneration = useRef(0),
    currentCwd = useRef(cwd)
  currentCwd.current = cwd
  useEffect(() => {
    if (!isTauri()) return
    const window = getCurrentWindow()
    const subscriptions = [
      window.listen("menu:replace-in-file", routeReplace),
      window.listen("menu:edit-undo", () => routeHistory("undo")),
      window.listen("menu:edit-redo", () => routeHistory("redo"))
    ]
    return () => {
      for (const subscription of subscriptions) void subscription.then((stop) => stop()).catch(report)
    }
  }, [])
  const ensure = useCallback(
    async (directory: string | null): Promise<Workspace> => {
      const signal = lifecycle.current.signal
      signal.throwIfAborted()
      const requested = await invoke<string>("draft_directory", { cwd: directory })
      signal.throwIfAborted()
      const existing = workspaces.current.get(requested)
      if (existing) return existing
      const inFlight = opening.current.get(requested)
      if (inFlight) return inFlight
      const create = Effect.gen(function* () {
        const root = yield* workspaceTask(() => invoke<string>("workspace_open", { path: requested }))
        signal.throwIfAborted()
        const saved = yield* workspaceTask(() => stateStore.load(root)).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              report(error)
              return null
            })
          )
        )
        signal.throwIfAborted()
        const rawFs = createFileSystem({
          adapter: createTauriAdapter({
            root,
            transport: {
              invoke: (request) =>
                invoke("workspace_file", {
                  request: {
                    ...request,
                    ...(request.operation === "writeFile"
                      ? { collaborationOwnerId: collaborationOwner(request.path) }
                      : {})
                  }
                })
            },
            watch: async (path, changed, onError) => {
              // Drive writes a synced project one file at a time. Every raw event used to broadcast
              // a `change`, and each one invalidates the editor's document cache and rebuilds the
              // open preview — so a sync burst made the preview flicker continuously. Coalesce the
              // events into one notification per quiet period.
              const relay = createWatchRelay(changed)
              changeHandlers.current.set(root, relay.schedule)
              const stop = await listen<{ root: string; paths: string[]; error: string | null }>(
                "workspace:change",
                (event) => {
                  if (event.payload.root !== root) return
                  if (event.payload.error !== null) {
                    onError(new Error(event.payload.error))
                    return
                  }
                  // Hold the reload while an agent turn runs: it writes many times and the preview
                  // must stay readable. The effect below replays the union when the turn ends.
                  if (busyRef.current) {
                    const pending = pendingChanges.current.get(root) ?? new Set<string>()
                    for (const changedPath of event.payload.paths) pending.add(changedPath)
                    if (pending.size > 0) pendingChanges.current.set(root, pending)
                    return
                  }
                  relay.schedule(event.payload.paths)
                }
              )
              try {
                await invoke("workspace_watch", { path, enabled: true })
              } catch (error) {
                relay.dispose()
                stop()
                throw error
              }
              return () => {
                relay.dispose()
                stop()
                void invoke("workspace_watch", { path, enabled: false }).catch(report)
              }
            }
          }),
          reportError: report
        })
        // Markdown autosave uses the controller's conditional write. Wrap only the editor-facing
        // filesystem so a sync that rotates the version without changing the body cannot turn every
        // autosave into a false "changed on disk" error.
        const fs = createResilientWriteFileSystem(rawFs)
        const editor = yield* Effect.acquireRelease(
          Effect.sync(() =>
            createEditorController({
              fs,
              reportError: report,
              confirmClose: async (document) => {
                const result = await ask({
                  title: t("workspace.unsaved"),
                  detail: document.path,
                  choices: [
                    { label: t("workspace.discard"), value: "discard" },
                    { label: t("workspace.save"), value: "save" }
                  ]
                })
                return result === null ? "cancel" : (result as CloseDecision)
              }
            })
          ),
          (editor) =>
            Effect.sync(() => editor.dispose()).pipe(
              Effect.ensuring(workspaceTask(async () => (await loadMonaco()).releaseMonaco(editor)).pipe(Effect.orDie))
            )
        )
        let expanded = saved?.expanded ?? [root]
        // assigned below once the editor exists; earlier tree callbacks skip persistence
        const late: { persistState?: () => void } = {}
        const tree = yield* Effect.acquireRelease(
          Effect.sync(() =>
            createFileTreeController({
              fs,
              root,
              reportError: report,
              expanded,
              onExpandedChange: (paths) => {
                expanded = [...paths]
                late.persistState?.()
              },
              confirmReplace: async (paths) =>
                (await ask({
                  title: t("workspace.replace"),
                  detail: paths.join("\n"),
                  choices: [{ label: t("workspace.replace"), value: "replace" }]
                })) === "replace"
            })
          ),
          (tree) => Effect.sync(() => tree.dispose())
        )
        yield* workspaceTask(() => tree.refresh())
        signal.throwIfAborted()
        if (saved?.showHidden) yield* workspaceTask(() => tree.setShowHidden(true))
        if (saved?.showIgnored) yield* workspaceTask(() => tree.setShowIgnored(true))
        for (const tab of saved?.tabs ?? []) {
          signal.throwIfAborted()
          const document = yield* workspaceTask(() => editor.open(tab.path)).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                signal.throwIfAborted()
                report(error)
                return null
              })
            )
          )
          signal.throwIfAborted()
          if (document && tab.pinned) editor.pin(document.id)
        }
        signal.throwIfAborted()
        const active = editor.getSnapshot().documents.find((doc) => doc.path === saved?.activePath)
        if (active) yield* workspaceTask(() => editor.open(active.path))
        signal.throwIfAborted()
        yield* Effect.acquireRelease(
          workspaceTask(() => fs.watch(root)),
          (stop) => Effect.sync(stop)
        )
        signal.throwIfAborted()
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            editor.subscribe(() => {
              const dirty = [...workspaces.current.values()].some((value) =>
                value.editor.getSnapshot().documents.some((doc) => doc.dirty)
              )
              if (dirty !== reportedDirty.current) {
                reportedDirty.current = dirty
                void invoke("workspace_dirty", { dirty }).catch(report)
              }
            })
          ),
          (stop) => Effect.sync(stop)
        )
        const tabs = yield* Effect.acquireRelease(
          Effect.sync(() => createEditorWorkspace(editor, saved?.tabLayout)),
          (tabs) => Effect.sync(() => tabs.dispose())
        )
        const created = {
          root,
          fs,
          editor,
          // Replaced below once the persistence closure exists; the placeholder keeps the shape
          // total so callers can treat every workspace as persistable.
          persistState: (): void => {},
          tabs,
          tree,
          iconTheme: saved?.iconTheme ?? "vscode-icons",
          treeOpener: createTreeOpener(
            editor,
            async (path) => {
              // Ordinary files are opened straight from disk. Going through the Drive index first
              // meant a daemon round trip on every tree click, queued behind whatever sync work
              // was running, so a local Markdown file could take seconds to appear.
              if (!isYuplinkName(path)) {
                const stat = await fs.stat(path).catch(() => null)
                if (stat?.kind === "file" && stat.size > 0) {
                  if (stat.size > 16 * 1024 * 1024) {
                    await openExternal(path)
                    return null
                  }
                  return path
                }
              }
              return prepareWorkspaceFile(path, {
                readFile: async (target) =>
                  (containsPath(root, target) ? fs : await driveFileSystem(target)).readFile(target),
                openTarget: (target) => routeDriveTarget.current(target)
              })
            },
            tabs
          )
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => created.treeOpener.dispose()))
        let serialized = ""
        /**
         * @param fileSession `false` only for the snapshot taken while the workspace is still being
         *   built: at that moment the editor holds the project's restored tabs, not this
         *   conversation's, and filing them would overwrite the conversation's own record with a
         *   copy of the project's.
         */
        const persistState = (fileSession = true) => {
          // A restore drives the editor through close/open one document at a time; every step
          // emits a snapshot that looks like user activity but is not. Filing those would leave
          // the conversation holding whichever document happened to be opened last.
          if (restoring.current) return
          const snapshot = editor.getSnapshot(),
            treeSnapshot = tree.getSnapshot()
          const tabs = snapshot.documents.map((doc) => ({ path: doc.path, pinned: doc.pinned }))
          const activePath = snapshot.documents.find((doc) => doc.id === snapshot.activeId)?.path ?? null
          const state: WorkspaceState = {
            tabs,
            activePath,
            expanded,
            showHidden: treeSnapshot.showHidden,
            showIgnored: treeSnapshot.showIgnored,
            iconTheme: created.iconTheme,
            tabLayout: created.tabs.serialize()
          }
          const next = JSON.stringify(state)
          if (next !== serialized) {
            serialized = next
            void stateStore.save(root, state).catch((error) => {
              serialized = ""
              report(error)
            })
          }
          // Same snapshot, filed under the conversation that owns the editor. Kept separate from
          // the project record above, which is also read by the tree/hidden/theme preferences and
          // must stay shared across conversations in one project.
          const session = openFor.current
          if (!fileSession || session === null) return
          void sessionStore.save(root, session, { tabs, activePath }).catch(report)
        }
        late.persistState = persistState
        created.persistState = persistState
        for (const subscribe of [
          () => editor.subscribe(persistState),
          () => tree.subscribe(persistState),
          () => created.tabs.subscribe(persistState)
        ])
          yield* Effect.acquireRelease(Effect.sync(subscribe), (stop) => Effect.sync(stop))
        // Project preferences only: the tabs in hand right now came from the project record, and
        // the conversation's own record is applied by the session switch effect afterwards.
        persistState(false)
        return created
      })
      const promise = openWorkspaceScope(signal, create, report).then((created) => {
        signal.throwIfAborted()
        workspaces.current.set(requested, created)
        return created
      })
      opening.current.set(requested, promise)
      try {
        return await promise
      } finally {
        if (opening.current.get(requested) === promise) opening.current.delete(requested)
      }
    },
    [ask, t, stateStore]
  )
  const openFile = useCallback(
    async (path: string, root: string | null, position?: FilePosition): Promise<void> => {
      const generation = ++requestGeneration.current,
        owner = currentCwd.current
      const authorized = [...workspaces.current.values()].find(
        (value) => root !== null && containsPath(value.root, root) && containsPath(value.root, path)
      )
      const target = authorized ?? (await ensure(root))
      if (!containsPath(target.root, path)) {
        openFilePreview(path, position)
        return
      }
      const destination = await prepareWorkspaceFile(path, {
        readFile: async (value) =>
          (containsPath(target.root, value) ? target.fs : await driveFileSystem(value)).readFile(value),
        openTarget: (value) => routeDriveTarget.current(value)
      })
      if (destination === null) return
      await target.editor.open(destination)
      if (generation !== requestGeneration.current || owner !== currentCwd.current) return
      setWorkspace(target)
      setNavigation(position ? { path: destination, position } : null)
      setVisible(true)
    },
    [ensure]
  )
  routeDriveTarget.current = async (path) => {
    const match = resolveDriveRoot(path, drive.getSnapshot().snapshot?.roots ?? [])
    if (!match) throw new Error("The linked file does not belong to an indexed Drive project")
    await openFile(path, match.base)
  }
  const openDriveLink = useCallback((path: string): Promise<void> => routeDriveTarget.current(path), [])
  useDriveDeepLinks(openDriveLink)
  const toggle = useCallback((): void => {
    if (!workspaceAllowed) return
    if (visible) {
      // Use the layout's effective state, including a preview moved onto the third screen.
      if (panelControls.current?.expanded) panelControls.current.toggleExpanded()
      else {
        setVisible(false)
        setViewMode(false)
      }
    } else {
      if (cwd === null || (isTemporaryChatDir(cwd) && !isChatOwnDirectory(cwd))) {
        // A dead click was the reported bug. Open the column with an actionable explanation
        // instead of calling `ensure(null)` and silently returning.
        reportEmptyState()
        setViewMode(false)
        setVisible(true)
        toast.info(guidance ?? t(emptyHintKey(reason)))
        return
      }
      const generation = ++requestGeneration.current,
        owner = cwd
      void ensure(cwd)
        .then((value) => {
          if (generation !== requestGeneration.current || owner !== currentCwd.current) return
          setWorkspace(value)
          setEmptyReason(null)
          setViewMode(false)
          setVisible(true)
        })
        .catch(report)
    }
  }, [cwd, ensure, visible, reportEmptyState, guidance, reason, t, workspaceAllowed])
  /**
   * The one action behind 四方格 (when no directory is bound), the header 文件栏 toggle and the
   * collapsed-state FolderTree. It ensures the workspace *and* opens/expands the columns; the old
   * header toggle only flipped `treeVisible`, which did nothing at all when `visible` was false.
   */
  const showProjectTree = useCallback((): void => {
    if (!workspaceAllowed) return
    if (cwd === null || (isTemporaryChatDir(cwd) && !isChatOwnDirectory(cwd))) {
      reportEmptyState()
      setViewMode(false)
      setVisible(true)
      toast.info(guidance ?? t(emptyHintKey(reason)))
      return
    }
    const generation = ++requestGeneration.current,
      owner = cwd
    void ensure(cwd)
      .then((value) => {
        if (generation !== requestGeneration.current || owner !== currentCwd.current) return
        setWorkspace(value)
        setEmptyReason(null)
        setVisible(true)
        setTreeVisible(true)
        setViewMode(false)
      })
      .catch(report)
  }, [cwd, ensure, setTreeVisible, reportEmptyState, guidance, reason, t, workspaceAllowed])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== "e")
        return
      event.preventDefault()
      // The shortcut only ever shows the column: hiding it is the button's job, so a stray press
      // never takes the reader's files away.
      showProjectTree()
    }
    window.addEventListener("keydown", onKeyDown)
    const subscription = isTauri() ? getCurrentWindow().listen("menu:project-tree", showProjectTree) : null
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      if (subscription) void subscription.then((stop) => stop()).catch(report)
    }
  }, [showProjectTree])
  const openProject = useCallback(
    async (path: string): Promise<void> => {
      const target = await ensure(path)
      if (currentCwd.current !== path) throw new Error("Project navigation was superseded")
      setWorkspace(target)
      setVisible(true)
    },
    [ensure]
  )
  // `undefined` rather than `cwd` so the first mount also loads the project: with `defaultOpen`
  // the preview must render all four columns on launch, and nothing else ensures the workspace
  // (the project effect above only opens `visible`, which is what brings the workspace in here).
  // Read in the cwd effect without becoming one of its dependencies: a `visible` dependency
  // re-runs that effect (and cancels the in-flight load) every time the preview opens.
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const displayedWorkspace = useRef(workspace)
  displayedWorkspace.current = workspace
  const previousCwd = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (previousCwd.current === cwd) return
    requestGeneration.current++
    // Load the workspace for any project (a project session, or a chat opened inside one) and skip
    // quick chats, which never have files next to them. Gate on "the preview is on screen", not on
    // `visible` alone: when a project session opens, the preview flag flips on in a *later* effect,
    // so a bare `!visible` guard bails and leaves `workspace` null — the "opened a project but only
    // the conversation shows" report. `defaultOpen` covers that first frame, and a preview the
    // reader opened by hand (`visible`, preference off) still has to load when the project changes,
    // otherwise the tree keeps listing the previous project's files.
    if (cwd === null || (!defaultOpen && !visibleRef.current)) return
    previousCwd.current = cwd
    // Keep the previous workspace mounted until the new one is ready. Nulling it first makes
    // `visible && workspace !== null` false, which collapses the whole chat/preview split and
    // leaves the user with a single column after simply clicking another conversation.
    let cancelled = false
    void ensure(cwd)
      .then((value) => {
        if (!cancelled) setWorkspace(value)
      })
      .catch(report)
    return () => {
      cancelled = true
    }
  }, [cwd, ensure, defaultOpen])
  // Replay the file changes held during the agent's turn, once it has settled: one reload at the
  // end instead of a flicker per write.
  useEffect(() => {
    if (busy) return
    const pending = pendingChanges.current
    if (pending.size === 0) return
    pendingChanges.current = new Map()
    for (const [root, paths] of pending) {
      if (paths.size === 0) continue
      try {
        changeHandlers.current.get(root)?.(Array.from(paths))
      } catch {
        // The workspace may have been disposed while the turn was running; its watcher is gone.
      }
    }
  }, [busy])
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent): void {
      if (
        [...workspaces.current.values()].some((value) => value.editor.getSnapshot().documents.some((doc) => doc.dirty))
      ) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    function refresh(): void {
      if (workspace) void workspace.tree.refresh().catch(report)
    }
    window.addEventListener("beforeunload", beforeUnload)
    window.addEventListener("focus", refresh)
    return () => {
      window.removeEventListener("beforeunload", beforeUnload)
      window.removeEventListener("focus", refresh)
    }
  }, [workspace])
  useEffect(() => {
    if (!isTauri()) return
    let closing = false
    const requestExit = (): void => {
      if (closing) return
      closing = true
      void (async () => {
        const approved = new Map(
          [...workspaces.current.values()].map((value) => [
            value,
            value.editor.getSnapshot().documents.map((doc) => ({ id: doc.id, contentRevision: doc.contentRevision }))
          ])
        )
        for (const value of approved.keys()) if (!(await value.editor.prepareShutdown())) return
        // Confirmation for one project cannot approve later edits in another project.
        if (approved.size !== workspaces.current.size) return
        for (const [value, documents] of approved) {
          const current = value.editor.getSnapshot().documents
          if (
            current.length !== documents.length ||
            current.some(
              (doc) =>
                !documents.some((before) => before.id === doc.id && before.contentRevision === doc.contentRevision)
            )
          )
            return
        }
        await invoke("workspace_exit")
      })()
        .catch(report)
        .finally(() => {
          closing = false
        })
    }
    const exitListener = listen("workspace:shutdown", requestExit)
    return () => {
      void exitListener.then((stop) => stop()).catch(report)
    }
  }, [])
  useEffect(() => {
    if (lifecycle.current.signal.aborted) lifecycle.current = new AbortController()
    const activeLifecycle = lifecycle.current
    const currentWorkspaces = workspaces.current
    const currentOpening = opening.current
    return () => {
      activeLifecycle.abort()
      currentWorkspaces.clear()
      currentOpening.clear()
      pendingChanges.current.clear()
      changeHandlers.current.clear()
    }
  }, [])
  useEffect(() => {
    if (!isTauri() || workspace === null || !visible) return
    const owner = workspace
    let cancelled = false
    const listener = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return
      const payload = event.payload
      void (async () => {
        const scale = await getCurrentWindow().scaleFactor()
        if (cancelled) return
        const element = document.elementFromPoint(payload.position.x / scale, payload.position.y / scale)
        if (!element?.closest(".file-workspace-tree")) return
        const row = element.closest<HTMLElement>("[data-file-path]")
        let destination = owner.root
        if (row !== null) {
          const path = row.getAttribute("data-file-path")
          if (path === null) throw new Error("File drop target is missing its path")
          destination = row.dataset.fileKind === "directory" ? path : dirname(path)
        }
        await invoke("workspace_import", { root: owner.root, destination, paths: payload.paths })
        await owner.tree.refresh()
      })().catch(report)
    })
    return () => {
      cancelled = true
      void listener.then((stop) => stop()).catch(report)
    }
  }, [workspace, visible])
  useEffect(() => {
    let disposed = false
    const newTab = (): void => {
      if (disposed || document.querySelector('[role="dialog"]')) return
      const previous = displayedWorkspace.current
      const generation = ++requestGeneration.current
      const owner = cwd
      void ensure(cwd)
        .then((target) => {
          if (disposed || generation !== requestGeneration.current || owner !== currentCwd.current) return
          if (
            target === previous ||
            target.tabs.getSnapshot().tabs.length !== 1 ||
            target.tabs.getSnapshot().tabs[0].kind !== "new"
          )
            target.tabs.openNewTab()
          setWorkspace(target)
          setVisible(true)
        })
        .catch(report)
    }
    const closeTab = (): void => {
      const target = displayedWorkspace.current
      if (disposed || !target || document.querySelector('[role="dialog"]')) return
      const id = target.tabs.getSnapshot().activeId
      if (id !== null) void target.tabs.requestClose(id).catch(report)
    }
    const reopenTab = (): void => {
      const target = displayedWorkspace.current
      if (disposed || !target || document.querySelector('[role="dialog"]')) return
      void target.tabs
        .reopenClosed()
        .then(() => {
          if (!disposed) setVisible(true)
        })
        .catch(report)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (key === "t") {
        event.preventDefault()
        if (event.shiftKey) reopenTab()
        else newTab()
      } else if (key === "w" && !event.shiftKey && visibleRef.current) {
        event.preventDefault()
        closeTab()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    const subscriptions = isTauri()
      ? [
          getCurrentWindow().listen("menu:new-tab", newTab),
          getCurrentWindow().listen("menu:close-tab", closeTab),
          getCurrentWindow().listen("menu:reopen-closed-tab", reopenTab)
        ]
      : []
    return () => {
      disposed = true
      window.removeEventListener("keydown", onKeyDown)
      for (const subscription of subscriptions) void subscription.then((stop) => stop()).catch(report)
    }
  }, [cwd, ensure])
  const revealEntry = useCallback(
    async (path: string, root: string): Promise<void> => {
      const target = await ensure(root)
      await target.tree.reveal(path)
      target.tree.select(path)
      setWorkspace(target)
      setVisible(true)
      setTreeVisible(true)
    },
    [ensure, setTreeVisible]
  )
  const hasWorkspace = workspace !== null
  const directoryReady = hasWorkspace && cwd !== null
  const context = useMemo(
    () => ({ visible, viewMode, directoryReady, toggle, showProjectTree, openFile, openProject, revealEntry }),
    [visible, viewMode, directoryReady, toggle, showProjectTree, openFile, openProject, revealEntry]
  )
  const treeLabels: FileTreeLabels = {
    files: t("workspace.files"),
    filter: t("workspace.filter"),
    empty: t("workspace.empty"),
    loading: t("workspace.loading"),
    refresh: t("workspace.refresh"),
    newFile: t("workspace.newFile"),
    newFolder: t("workspace.newFolder"),
    rename: t("workspace.rename"),
    remove: t("workspace.remove"),
    copy: t("workspace.copy"),
    cut: t("workspace.cut"),
    paste: t("workspace.paste"),
    hidden: t("workspace.hidden"),
    openExternal: t("workspace.openExternal")
  }
  const editorLabels: EditorLabels = {
    empty: t("workspace.selectFile"),
    save: t("workspace.save"),
    saveAs: t("workspace.saveAs"),
    saving: t("workspace.saving"),
    close: t("workspace.close"),
    edit: t("workspace.edit"),
    preview: t("workspace.preview"),
    source: t("workspace.source"),
    viewMode: t("workspace.viewMode"),
    reload: t("workspace.reload"),
    changed: t("workspace.changed"),
    unsupported: t("workspace.unsupported"),
    openExternal: t("workspace.openExternal"),
    loading: t("workspace.loading"),
    loadFailed: t("workspace.loadFailed"),
    retry: t("workspace.retry")
  }
  // `workspace === null` used to make the whole preview column disappear (`visible && workspace !==
  // null`) while the 文件栏 button kept running. Render an actionable empty state in that column
  // instead; a bare loading line covers the short gap before `ensure(cwd)` resolves for a real
  // project. All three 文件栏 entries funnel through `showProjectTree`.
  const emptyStateNode: ReactNode =
    emptyReason === null ? (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("workspace.loading")}
      </div>
    ) : (
      <WorkspaceEmptyState
        reason={emptyReason}
        directory={
          emptyReason === "invalid"
            ? (invalidDirectory ?? cwd ?? projectDirectoryAttempt(projectBindingKey)?.directory ?? null)
            : cwd
        }
        bindingKey={projectBindingKey}
        guidance={guidance}
        onRetry={retryWorkspace}
      />
    )
  return (
    <WorkspaceContext.Provider value={context}>
      <ChatContextMenu target={previewMenu} onClose={() => setPreviewMenu(null)} onAddToChat={addSelectionToChat} />
      {/* HTML frames and in-document previews both quote into the conversation's composer. */}
      <SelectionMenu
        containerRef={noSelectionRoot}
        sessionId={composerSessionId}
        external={
          visible && previewExtension === null && previewSelection?.path === activePath ? previewSelection : null
        }
        onDismiss={dismissPreviewSelection}
        scope="preview"
        portalTarget={previewEditorRef.current}
      />
      {showMainControls &&
        headerTarget !== null &&
        workspaceAllowed &&
        createPortal(
          <div className="file-workspace-toolbar">
            {/* A second copy of the tree toggle for the window header; the tree's own toolbar
                keeps its toggle so the control is reachable from both places. */}
            {/* Tooltip, not `title`: the sibling workspace button opens instantly, and a native
                title next to it reads as a bug. */}
            {/* Chat-only controls need a real project. 四方格 and 文件栏 stay visible even without
                one: they are the buttons that explain/repair a missing directory. */}
            {hasProjectDirectory && !(visible && previewExtension === null && markdownPreview) && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      data-testid="header-comments-toggle"
                      aria-label={t(commentsOff ? "workspace.showComments" : "workspace.hideComments")}
                      aria-pressed={!commentsOff}
                      onClick={() => {
                        const next = !commentsOff
                        setCommentsOff(next)
                        setCommentsHidden(next)
                      }}
                    >
                      <MessageSquare />
                    </Button>
                  }
                />
                <TooltipContent side="bottom">
                  {t(commentsOff ? "workspace.showComments" : "workspace.hideComments")}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="workspace-explorer-toggle"
                    data-testid="header-tree-toggle"
                    aria-label={t(
                      treeVisible && visible && workspace !== null ? "workspace.hideTree" : "workspace.showTree"
                    )}
                    aria-expanded={visible && workspace !== null && treeVisible}
                    onClick={() => (visible && workspace !== null ? setTreeVisible(!treeVisible) : showProjectTree())}
                  >
                    <FolderTree />
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                {t(treeVisible && visible && workspace !== null ? "workspace.hideTree" : "workspace.showTree")}
                <span className="ms-1.5 text-muted-foreground">⌘⇧E</span>
              </TooltipContent>
            </Tooltip>
            {hasProjectDirectory && (
              <ChatCondenseEntry
                cwd={cwd}
                controller={drive}
                controls={driveControls}
                locale={i18n.language.startsWith("zh") ? "zh-CN" : "en"}
                host={condenseHost}
                onBackgroundError={report}
                onCondense={(scope, job) => {
                  setCondenseJob(job)
                  setCondenseScope(scope)
                }}
              />
            )}
            {windowsControls === null && <WorkspaceButton />}
          </div>,
          headerTarget
        )}
      {showMainControls &&
        windowsControls !== null &&
        workspaceAllowed &&
        createPortal(
          <div className="file-workspace-toolbar">
            <WorkspaceButton />
          </div>,
          windowsControls
        )}
      <WorkspacePanels
        controlsRef={panelControls}
        visible={visible && workspaceAllowed}
        maximized={visible && workspace !== null && viewMode}
        onMaximizedChange={setViewMode}
        onVisibleChange={(next) => {
          setVisible(next)
          if (!next) setViewMode(false)
        }}
        chat={children}
        preview={
          workspace === null ? (
            emptyStateNode
          ) : (
            <PreviewSurface
              treeVisible={treeVisible}
              onTreeVisibleChange={setTreeVisible}
              onShowProjectTree={showProjectTree}
              maximized={viewMode}
              onMaximize={() => setViewMode((value) => !value)}
              onClose={() => {
                setVisible(false)
                setViewMode(false)
                closePreviewExtension()
              }}
              editorRef={previewEditorRef}
              tree={
                hasWorkspace ? (
                  <FileTree
                    controller={workspace.tree}
                    collapsed={!treeVisible}
                    explorerControl={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="workspace-explorer-toggle"
                        data-testid="tree-toggle"
                        aria-label={t(treeVisible ? "workspace.hideTree" : "workspace.showTree")}
                        title={t(treeVisible ? "workspace.hideTree" : "workspace.showTree")}
                        shortcut="CmdOrCtrl+Shift+E"
                        aria-expanded={treeVisible}
                        onClick={() => setTreeVisible(!treeVisible)}
                      >
                        <FolderTree />
                      </Button>
                    }
                    isDark={resolvedTheme === "dark"}
                    iconTheme={iconTheme ?? workspace.iconTheme}
                    activePath={activeDocument ? activeDocument.path : null}
                    labels={treeLabels}
                    onError={report}
                    onOpenFile={(path) => {
                      closePreviewExtension()
                      // The tree has no promise slot of its own: report a failed open here instead of
                      // letting it land in the window's unhandled-rejection handler.
                      void workspace.treeOpener.open(path).catch(report)
                    }}
                    renderActions={(paths) => {
                      const path = paths[0]
                      if (
                        paths.length > 1 &&
                        driveState?.running &&
                        paths.every((path) => {
                          const hit = resolveDriveRoot(path, driveState.roots)
                          return hit !== null && hit.root.canWrite && path !== hit.base
                        })
                      )
                        return (
                          <ContextMenuItem onClick={() => setPublishSources({ owner: workspace, paths })}>
                            {t("workspace.publishTo")}
                          </ContextMenuItem>
                        )
                      return paths.length === 1 &&
                        path !== undefined &&
                        driveState?.running &&
                        driveState.roots.some((root) => containsPath(root.localPath, path)) ? (
                        <DriveTreeActions
                          path={path}
                          isDirectory={workspace.tree
                            .getSnapshot()
                            .rows.some((row) => row.path === path && row.kind === "directory")}
                          onSharing={setSharingPath}
                          onCondense={(scope) => {
                            setCondenseJob(undefined)
                            setCondenseScope(scope)
                          }}
                          onMove={(path, kind) => setMoveTarget({ path, kind })}
                          onPublish={(path) => setPublishSources({ owner: workspace, paths: [path] })}
                          saveDocument={saveDriveDocument}
                        />
                      ) : null
                    }}
                    renderDecoration={(row) => (
                      <DriveBadge
                        controller={drive}
                        path={row.path}
                        isDirectory={row.kind === "directory"}
                        locale={i18n.language.startsWith("zh") ? "zh-CN" : "en"}
                      />
                    )}
                    onPinFile={(path) => void workspace.treeOpener.open(path, true).catch(report)}
                    onOpenExternal={openExternal}
                    onReveal={(path) => revealItemsInDir(path)}
                    onCopyPath={writeText}
                    onMove={(paths) => {
                      return Promise.try(() => {
                        setMoveSources({ owner: workspace, paths })
                      })
                    }}
                    onImport={async (destination, directory) => {
                      const paths = await openDialog({
                        directory,
                        multiple: true,
                        title: t(directory ? "workspace.importFolder" : "workspace.importFiles")
                      })
                      if (paths === null) return
                      await invoke("workspace_import", { root: workspace.root, destination, paths })
                      await workspace.tree.refresh()
                    }}
                    explorerLabels={{
                      explorer: t("workspace.explorer"),
                      search: t("workspace.search"),
                      collapse: t("workspace.collapse"),
                      more: t("workspace.more"),
                      ignored: t("workspace.ignored"),
                      newMarkdown: t("workspace.newMarkdown"),
                      copyPath: t("workspace.copyPath"),
                      copyRelativePath: t("workspace.copyRelativePath"),
                      moveTo: t("workspace.moveTo"),
                      reveal: t("workspace.reveal"),
                      importFiles: t("workspace.importFiles"),
                      importFolder: t("workspace.importFolder"),
                      open: t("workspace.open"),
                      closeSearch: t("workspace.closeSearch"),
                      previousMatch: t("workspace.previousMatch"),
                      nextMatch: t("workspace.nextMatch")
                    }}
                    requestName={(action, current) =>
                      ask({
                        title: t(
                          action === "rename"
                            ? "workspace.rename"
                            : action === "file"
                              ? "workspace.newFile"
                              : "workspace.newFolder"
                        ),
                        detail: workspace.root,
                        initial: current,
                        choices: [{ label: t("workspace.confirm"), value: "confirm" }]
                      })
                    }
                    confirmDelete={async (paths) =>
                      (await ask({
                        title: t("workspace.remove"),
                        detail: paths.join("\n"),
                        choices: [{ label: t("workspace.remove"), value: "delete" }]
                      })) === "delete"
                    }
                  />
                ) : (
                  emptyStateNode
                )
              }
              editor={({ leading, trailing }) => {
                const onlineBi = previewExtension === ONLINE_BI_VIEW_ID
                return previewExtension !== null ? (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {leading}
                        <ChartColumn className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="shrink-0 truncate text-sm font-medium">
                          {onlineBi ? t("sidebar.onlineBi") : t("sidebar.biMetrics")}
                        </span>
                        {onlineBi && (
                          <input
                            aria-label={t("settings.onlineBiUrl")}
                            value={biDraft}
                            onChange={(event) => setBiDraft(event.currentTarget.value)}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter") return
                              event.preventDefault()
                              loadBiUrl(biDraft)
                            }}
                            spellCheck={false}
                            placeholder="https://bi.finture.id/"
                            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-[11px] tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                          />
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {onlineBi && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              refreshBiSrc()
                              setBiReload((count) => count + 1)
                            }}
                          >
                            <RefreshCw aria-hidden="true" />
                            {t("workspace.refresh")}
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={closePreviewExtension}>
                          <FolderOpen aria-hidden="true" />
                          {t("workspace.backToFiles")}
                        </Button>
                        {/* `trailing` carries the editor's own 最大化 and close buttons. Neither
                            behaved for the BI panel — maximize left the native view mis-sized and
                            close could not dismiss it — and 返回文件 already closes the panel, so
                            they are simply not rendered here (2026-11-08). */}
                      </div>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col">
                      {onlineBi ? (
                        /* Native view, not an iframe: WKWebView withholds cookies from a
                           cross-site frame, and the dashboard's session is a cookie. */
                        <OnlineBiNativeView src={biSrc ?? ONLINE_BI_URL} reload={biReload} />
                      ) : (
                        <ExtensionMount id={previewExtension} />
                      )}
                    </div>
                  </div>
                ) : (
                  <DriveDocumentSurface host={previewHost} path={markdownPreview ? null : activePath}>
                    <ChatDirectoryContext.Provider value={workspace.root}>
                      <div className="contents" data-workspace-selection-owner="" onContextMenu={previewContextMenu}>
                        <WorkspaceEditor
                          tabs={workspace.tabs}
                          leading={leading}
                          trailing={trailing}
                          iconTheme={iconTheme ?? workspace.iconTheme}
                          isDark={resolvedTheme === "dark"}
                          readOnly={driveReadOnly}
                          sourceReadOnly={driveFile?.state === "collab" || activeCollaborationOwner !== undefined}
                          controller={workspace.editor}
                          labels={editorLabels}
                          compactToolbar
                          rootPath={navigator.platform.includes("Win") ? normalizePath(workspace.root) : workspace.root}
                          onRevealPath={(path) => workspace.tree.reveal(path)}
                          onReveal={(document) => revealItemsInDir(document.path)}
                          onCopyPath={(document) => writeText(document.path)}
                          tabLabels={{
                            closeOthers: t("workspace.closeOthers"),
                            closeRight: t("workspace.closeRight"),
                            closeSaved: t("workspace.closeSaved"),
                            closeAll: t("workspace.closeAll"),
                            copyPath: t("workspace.copyPath"),
                            reveal: t("workspace.reveal")
                          }}
                          actionsLabel={t("workspace.more")}
                          onError={report}
                          onOpenExternal={(document) => openExternal(document.path)}
                          previews={previews}
                          requestSaveAs={async (document) =>
                            ask({
                              title: t("workspace.saveAs"),
                              detail: workspace.root,
                              initial: document.path,
                              choices: [{ label: t("workspace.save"), value: "save" }]
                            })
                          }
                          renderTextEditor={(props) => (
                            <Suspense
                              fallback={
                                <div className="p-6 text-sm text-muted-foreground">{t("workspace.loading")}</div>
                              }
                            >
                              <CodeEditor
                                {...props}
                                controller={workspace.editor}
                                settings={settings}
                                onError={report}
                                position={navigation?.path === props.document.path ? navigation.position : undefined}
                              />
                            </Suspense>
                          )}
                        />
                      </div>
                    </ChatDirectoryContext.Provider>
                  </DriveDocumentSurface>
                )
              }}
            />
          )
        }
      />
      {publishSources && (
        <MoveToDialog
          mode="publish"
          sources={publishSources.paths}
          rootPath={publishSources.owner.root}
          fs={publishSources.owner.fs}
          tree={publishSources.owner.tree}
          onClose={() => setPublishSources(null)}
          onMoveTo={() => {
            return Promise.reject(new Error("Publishing cannot move local files"))
          }}
        />
      )}
      {moveSources && (
        <MoveToDialog
          sources={moveSources.paths}
          rootPath={moveSources.owner.root}
          fs={moveSources.owner.fs}
          tree={moveSources.owner.tree}
          onClose={() => setMoveSources(null)}
          onMoveTo={async (paths, directory) =>
            moveWorkspaceFiles(paths, directory, {
              owners: [...workspaces.current.values()],
              invokeMove: async (sources, destination) => {
                const result = await invoke<WorkspaceMoveOutcome>("workspace_move_to", {
                  root: moveSources.owner.root,
                  sources,
                  destination
                })
                const profile = drive.getSnapshot().snapshot
                for (const moved of result.moves)
                  rebaseDrivePins(`${profile?.baseUrl ?? ""}|${profile?.localRoot ?? ""}`, moved.from, moved.to)
                for (const owner of workspaces.current.values()) {
                  try {
                    await owner.tree.refresh()
                  } catch (error) {
                    report(error)
                  }
                }
                return result
              },
              open: async (path, pinned, active) => {
                const match = resolveDriveRoot(path, drive.getSnapshot().snapshot?.roots ?? [])
                const target = await ensure(match?.base ?? directory)
                const previousActive = target.editor.getSnapshot().activeId
                const document = await target.editor.open(path)
                if (pinned) target.editor.pin(document.id)
                if (active) setWorkspace(target)
                else if (previousActive !== null) target.editor.activate(previousActive)
              }
            })
          }
        />
      )}
      <Dialog
        open={condenseScope !== null}
        onOpenChange={(open) => {
          if (!open) setCondenseScope(null)
        }}
      >
        <DialogContent className={driveDialogClassName}>
          <DialogHeader>
            <DialogTitle>{i18n.language.startsWith("zh") ? "沉淀为知识" : "Condense into knowledge"}</DialogTitle>
          </DialogHeader>
          {condenseScope && (
            <DriveCondense
              key={`${condenseScope.projectId}:${condenseJob?.id ?? "manual"}`}
              initialJob={condenseJob}
              controller={drive}
              controls={driveControls}
              scope={condenseScope}
              locale={i18n.language.startsWith("zh") ? "zh-CN" : "en"}
              onClose={() => setCondenseScope(null)}
              onOpenExternal={openExternal}
              onOpenFile={async (path) => {
                await workspace?.treeOpener.open(path)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={moveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMoveTarget(null)
        }}
      >
        <DialogContent className={driveDialogClassName}>
          <DialogHeader>
            <DialogTitle>{i18n.language.startsWith("zh") ? "移动到其他项目" : "Move to another project"}</DialogTitle>
          </DialogHeader>
          {moveTarget && (
            <DriveMoveDialog
              {...moveTarget}
              controller={drive}
              controls={driveControls}
              locale={i18n.language.startsWith("zh") ? "zh-CN" : "en"}
              onClose={() => setMoveTarget(null)}
              host={{
                confirm: (message) => confirm(message, { title: i18n.t("drive.confirmTitle"), kind: "warning" }),
                prepareMove: async (path) => {
                  for (const owner of workspaces.current.values()) {
                    const ids = owner.editor
                      .getSnapshot()
                      .documents.filter((doc) => containsPath(path, doc.path))
                      .map((doc) => doc.id)
                    if (!(await owner.editor.requestCloseMany(ids))) return false
                  }
                  return true
                },
                onMoved: async (source, destination) => {
                  const profile = drive.getSnapshot().snapshot
                  rebaseDrivePins(`${profile?.baseUrl ?? ""}|${profile?.localRoot ?? ""}`, source, destination)
                  for (const owner of workspaces.current.values()) await owner.tree.refresh()
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {dialog}
      <DriveSharingDialog path={sharingPath} onClose={() => setSharingPath(null)} />
    </WorkspaceContext.Provider>
  )
}
