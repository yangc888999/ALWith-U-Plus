import type { Session } from "@alwith/api"
import { ConversationView } from "@alwith/module-chat/conversation"
import { info } from "@tauri-apps/plugin-log"
import { ChevronUpIcon, Loader2Icon } from "lucide-react"
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import type { SessionSummary } from "@/agent/client"
import { CollectionPicker } from "@/features/collection/collection-menu"
import { SessionPreview } from "@/features/computer/session-preview"
import { GroupDiscussionBar } from "@/features/groups/group-bar"
import { useGroupDiscussion } from "@/features/groups/use-group-discussion"
import type { VoiceResume } from "@/features/voice/use-voice-handoff"
import { getConversationDetail, subscribeChatDisplayPreferences } from "@/lib/chat-display-preferences"
import { client } from "@/lib/client"
import { groupByDirectory } from "@/lib/groups"
import { snapshotProjectMemory } from "@/lib/project-memory"
import { isTemporaryChatDir } from "@/lib/quick-chat"

import { ChatActionsMenu } from "./chat-actions-menu"
import { ModelEntry } from "./composer/model-entry"
import { ChatBranchProvider } from "./chat-branches"
import {
  ChatContextMenu,
  type ContextMenuTarget,
  contextMenuText,
  isEditableTarget,
  selectionRectOf
} from "./chat-context-menu"
import { ChatEdgeActions } from "./chat-edge-actions"
import { ChatHeader } from "./chat-header"
import { useChatHost, useTimelineSlots } from "./chat-host"
import { ChatComposer } from "./composer"
import { ChatSearch } from "./dialogs/chat-search"
import { FilePreviewModal } from "./dialogs/file-preview-modal"
import { ImageLightbox } from "./dialogs/image-lightbox"
import { ChatDirectoryContext, ChatOpenSessionContext } from "./file-actions"
import { appendQuote, SelectionMenu } from "./selection-menu"
import { useOrchestrationProviderWarning } from "./use-orchestration-provider-warning"

type ChatViewProps = {
  session: Session
  voiceResume?: VoiceResume
  onSelectSession?: (sessionRow: SessionSummary) => void
  onOpenWindow?: () => void
  onReturnToMain?: () => void
  headerTarget?: HTMLElement | null
  projectMenu?: ReactNode
  onNewChat: () => void
  onNewProject?: () => void
  /** Opens a fresh thread in the given project so the agent stops carrying old context. */
  onClearContext?: (cwd: string) => void
  onDeleted: (sessionId: string) => void
}

// Issue #3: message-level lazy loading. Historical sessions can hold thousands of items and the
// external ConversationView renders every item it is handed, so we only pass it the most recent
// window of turns and let the user pull earlier history on demand. Windowing is turn-aware so a
// user message is never split from its following assistant reply.
const INITIAL_TURNS = 30
const TURN_STEP = 30
// Only emit perf diagnostics for conversations big enough that the bottleneck is real.
const PERF_MIN_ITEMS = 20
// A replay lands in the store as 16ms batches while `restoring`. Re-rendering the window on every
// batch re-paints up to 30 turns ~60 times a second and competes with the ingest itself, which is
// what makes opening a long history feel stuck. While a replay runs the transcript handed to the
// conversation is refreshed on this calm cadence instead; the store keeps every item either way.
const REPLAY_RENDER_INTERVAL_MS = 400

/** Walk backwards from the tail instead of indexing the whole transcript: on a 10k-item replay
 *  this touches ~30 turns rather than 10k items on every streamed update. */
function sliceLastTurns(items: Session["items"], turns: number): Session["items"] {
  if (turns <= 0) return items
  let seen = 0
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.kind !== "user") continue
    seen += 1
    if (seen === turns) return items.slice(index)
  }
  return items
}

/** Console for devtools, file log for the field: opening a big history is exactly the case where
 * the numbers are needed after the fact, and the webview console is gone by then. */
function perf(line: string): void {
  console.info(line)
  try {
    void info(`[chat-perf] ${line}`).catch(() => {})
  } catch {
    // Outside Tauri (tests, plain browser): the console line above is the whole story.
  }
}

// The scroll container is not exposed by the external module, so we locate the deepest element
// that actually scrolls by walking down from the conversation root.
function findScrollContainer(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null
  const candidates: HTMLElement[] = []
  const walk = (element: HTMLElement): void => {
    const overflowY = getComputedStyle(element).overflowY
    if ((overflowY === "auto" || overflowY === "scroll") && element.scrollHeight > element.clientHeight + 1) {
      candidates.push(element)
    }
    for (const child of Array.from(element.children)) {
      if (child instanceof HTMLElement) walk(child)
    }
  }
  walk(root)
  if (candidates.length === 0) return null
  const isAncestor = (ancestor: HTMLElement, node: HTMLElement): boolean => ancestor !== node && ancestor.contains(node)
  const deepest = candidates.filter((candidate) => !candidates.some((other) => isAncestor(other, candidate)))
  return deepest[0] ?? candidates[0]
}

function Conversation({
  session,
  voiceResume,
  onOpenWindow,
  onReturnToMain,
  headerTarget,
  projectMenu,
  onNewChat,
  onNewProject,
  onDeleted,
  rootRef
}: ChatViewProps & { rootRef: RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation()
  const host = useChatHost()
  const timeline = useTimelineSlots()
  // A conversation that lives in a group's directory discusses there: the roster takes the
  // session in turn once the user has spoken.
  useGroupDiscussion(session)
  // A session whose own options carry no `model` entry makes the shared picker render nothing at
  // all, while the composer keeps asking the reader to use it. That is the state a revoked account
  // model leaves behind — and the 拉会 surface passes no picker of its own, so it had no way out.
  //
  // What must *not* happen is flashing it while a chat is still opening: `createSession` starts
  // every chat at `configOptions: []` and the engine fills the list in during the replay. So the
  // fallback is withheld only in that window — replaying, nothing loaded yet. A chat whose replay
  // was *refused* (restoring gone, list still empty) needs it most of all: that is exactly the case
  // where nothing else can be rendered and the reader has to pick a model to get going again.
  //
  // That decision now lives in `ModelEntry`, next to the draft surface's, so the two can never
  // disagree about which control a conversation gets (2026-11-17).
  // A split saved with this chat may point at a provider that has since been closed.
  useOrchestrationProviderWarning(session.id)
  // Recount only when the transcript itself changes: a replayed session re-renders once per
  // streamed item, and counting every turn each time is quadratic on big threads.
  const turnCount = useMemo(
    () => session.items.reduce((count, item) => (item.kind === "user" ? count + 1 : count), 0),
    [session.items]
  )

  // ---- Issue #3: only render the most recent window of turns; older turns load on demand. ----
  const totalTurns = turnCount
  const [visibleTurns, setVisibleTurns] = useState(INITIAL_TURNS)
  // While a replay runs, hand the conversation a calm-cadence snapshot of the same session instead
  // of the live one: the store still receives every item on time, but 16ms ingest batches no longer
  // re-paint the window ~60 times a second. The snapshot settles to the live session the moment
  // the replay ends, so the tail window is exact the instant history is complete.
  const liveSession = useRef(session)
  liveSession.current = session
  const [renderedSession, setRenderedSession] = useState(session)
  useEffect(() => {
    // Both edges of a replay paint the session as it is right now: the start (empty transcript,
    // "restoring" state) and the end (complete transcript, exact tail window).
    setRenderedSession(session)
    if (!session.restoring) return
    const timer = setInterval(() => setRenderedSession(liveSession.current), REPLAY_RENDER_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [session.restoring, session.id])
  // The very first item paints immediately: a 400ms-wait spinner would read as a stall, and the
  // first page is exactly the moment the user learns the chat is opening.
  const firstItemPainted = useRef(false)
  useEffect(() => {
    if (firstItemPainted.current || !session.restoring || session.items.length === 0) return
    firstItemPainted.current = true
    setRenderedSession(liveSession.current)
  }, [session.items.length, session.restoring])
  const shownSession = session.restoring ? renderedSession : session
  const windowedItems = useMemo(
    () => sliceLastTurns(shownSession.items, visibleTurns),
    [shownSession.items, visibleTurns]
  )
  const windowedSession = useMemo(() => ({ ...shownSession, items: windowedItems }), [shownSession, windowedItems])
  const hasMoreHistory = windowedItems.length < shownSession.items.length

  const scrollAdjustRef = useRef<number | null>(null)
  const loadEarlier = useCallback(() => {
    const scroller = findScrollContainer(rootRef.current)
    if (scroller) scrollAdjustRef.current = scroller.scrollHeight - scroller.scrollTop
    // A click must not wait for the next replay pulse to show the older turns it asked for.
    setRenderedSession(liveSession.current)
    setVisibleTurns((value) => Math.min(value + TURN_STEP, totalTurns))
  }, [rootRef, totalTurns])
  // Keep the viewport anchored when earlier turns are prepended above the current top.
  useLayoutEffect(() => {
    if (scrollAdjustRef.current == null) return
    const scroller = findScrollContainer(rootRef.current)
    if (scroller) scroller.scrollTop = scroller.scrollHeight - scrollAdjustRef.current
    scrollAdjustRef.current = null
  }, [windowedItems, rootRef])

  // ---- Issue #3 diagnostics: separate data-replay cost from first-paint render cost. ----
  const openStartRef = useRef<number | null>(null)
  const lastLenRef = useRef(0)
  const firstItemRef = useRef(false)
  const firstPaintRef = useRef(false)
  const replayDoneRef = useRef(false)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    openStartRef.current = performance.now()
    lastLenRef.current = 0
    firstItemRef.current = false
    firstPaintRef.current = false
    replayDoneRef.current = false
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
  }, [session.id])
  // Phase: the first history item lands — the engine finished materializing and pages are flowing.
  useEffect(() => {
    if (openStartRef.current == null || firstItemRef.current || !session.restoring || session.items.length === 0) return
    firstItemRef.current = true
    if (session.items.length >= PERF_MIN_ITEMS) {
      perf(
        `[PERF] firstItem id=${session.id} items=${session.items.length} ${Math.round(performance.now() - openStartRef.current)}ms`
      )
    }
  }, [session.items.length, session.restoring, session.id])
  // Phase: the replay ends — every history item is in the store and the window is exact.
  useEffect(() => {
    if (openStartRef.current == null || replayDoneRef.current || session.restoring) return
    replayDoneRef.current = true
    if (session.items.length >= PERF_MIN_ITEMS) {
      perf(
        `[PERF] replayDone id=${session.id} totalItems=${session.items.length} ${Math.round(performance.now() - openStartRef.current)}ms`
      )
    }
  }, [session.restoring, session.items.length, session.id])
  // Phase: the transcript has been quiet for a moment — the view settled after the last batch.
  useEffect(() => {
    if (openStartRef.current == null) return
    const length = session.items.length
    if (length === lastLenRef.current) return
    lastLenRef.current = length
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
    settleTimerRef.current = setTimeout(() => {
      if (length >= PERF_MIN_ITEMS) {
        perf(
          `[PERF] settled id=${session.id} totalItems=${length} ${Math.round(performance.now() - (openStartRef.current ?? 0))}ms`
        )
      }
      settleTimerRef.current = null
    }, 200)
  }, [session.items.length, session.id])
  useLayoutEffect(() => {
    if (openStartRef.current == null || firstPaintRef.current) return
    if (windowedItems.length > 0) {
      firstPaintRef.current = true
      if (windowedItems.length >= PERF_MIN_ITEMS) {
        perf(
          `[PERF] firstPaint id=${session.id} visibleItems=${windowedItems.length} ${Math.round(performance.now() - openStartRef.current)}ms`
        )
      }
    }
  }, [windowedItems.length, session.id])

  return (
    <ConversationView
      session={windowedSession}
      client={client}
      host={host}
      rootRef={rootRef}
      timeline={timeline}
      header={
        <ChatHeader
          target={headerTarget}
          title={session.title ?? (session.items.length === 0 ? t("sidebar.newChat") : t("sidebar.untitled"))}
          project={projectMenu}
          turnCount={turnCount}
        >
          <div className="ms-1 flex shrink-0 items-center gap-1">
            <CollectionPicker sessionId={session.id} favorite />
            <ChatActionsMenu
              surface={headerTarget === undefined ? "main" : "floating"}
              onOpenWindow={onOpenWindow}
              onReturnToMain={onReturnToMain}
              session={session}
              cwd={session.cwd}
              onNewChat={onNewChat}
              onNewProject={onNewProject}
              onDeleted={onDeleted}
            />
          </div>
        </ChatHeader>
      }
      overlay={
        <>
          <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex flex-col items-center gap-1">
            {hasMoreHistory && (
              <button
                type="button"
                onClick={loadEarlier}
                className="pointer-events-auto flex items-center gap-1 rounded-full border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
              >
                <ChevronUpIcon className="size-3.5" />
                {totalTurns - visibleTurns <= TURN_STEP
                  ? t("chat.loadEarlier")
                  : t("chat.loadEarlierCount", { count: Math.min(TURN_STEP, totalTurns - visibleTurns) })}
              </button>
            )}
            {/* Replay progress: the transcript fills in page by page, so name what is still
                arriving instead of leaving the growing list unexplained. */}
            {session.restoring && session.items.length > 0 && (
              <div
                className="pointer-events-auto flex items-center gap-1.5 rounded-full border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur"
                data-history-loading
              >
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                {t("chat.historyLoadingCount", { count: session.items.length })}
              </div>
            )}
          </div>
          <div
            className="pointer-events-none absolute top-0 right-0 z-20 w-72 max-w-full [&>*]:pointer-events-auto"
            data-computer-preview-overlay
          >
            <SessionPreview key={session.id} sessionId={session.id} />
          </div>
          {/* Group speaking status is part of the composer stack now; nothing floats over the box
              the user has to type their interjection into. */}
          <ChatSearch rootRef={rootRef} sessionId={session.id} />
        </>
      }
      composer={
        <div className="flex flex-col" data-chat-drop-zone>
          <GroupDiscussionBar session={session} />
          <ChatComposer
            session={session}
            voiceResume={voiceResume}
            modelSelector={<ModelEntry surface="session" session={session} />}
          />
        </div>
      }
    >
      <FilePreviewModal />
      <ImageLightbox />
    </ConversationView>
  )
}

export function ChatView(props: ChatViewProps) {
  const { t } = useTranslation()
  const { session, onSelectSession, onClearContext } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<ContextMenuTarget | null>(null)
  // 简洁/详细：compact keeps finished tool groups collapsed, full spreads them open (CSS).
  const detail = useSyncExternalStore(subscribeChatDisplayPreferences, getConversationDetail, getConversationDetail)
  // A group discussion reads as a plain chat in the same surface; this flag lets the chat styles
  // strip the AI "thinking" blocks and bias bubbles WeChat-style for meeting transcripts only.
  const isGroupDiscussion = groupByDirectory(session.cwd) !== null
  // The floating header is a portal outside the conversation root: its right-click must open
  // the same menu, so the containment check admits the portal target as well.
  const headerRef = useRef<HTMLElement | null | undefined>(props.headerTarget)
  headerRef.current = props.headerTarget
  // Bound on the document, not the wrapper: the conversation body can render in a subtree the
  // wrapper does not own, so a wrapper-level handler never saw the event and the native English
  // menu opened anyway. Capturing matters too: the conversation surface can cancel the bubbling
  // event before a bubble-phase listener runs.
  useEffect(() => {
    const open = (event: MouseEvent): void => {
      // Only the conversation surface this view owns. The workspace keeps its own menu, so a
      // right-click in one place never opens two overlapping menus. The drop-zone query is a
      // fallback: if the module never binds the ref, the menu must not silently vanish.
      const target = event.target
      if (!(target instanceof Node)) return
      // The composer owns its own menu (data-composer); handing both would open two.
      if (target instanceof Element && target.closest("[data-composer]") !== null) return
      // Prefer a conversation root that actually contains the click: `querySelector` can pick a
      // hidden panel's root instead, and a missing root used to mean "no menu at all".
      const root =
        rootRef.current ??
        [...document.querySelectorAll("[data-chat-drop-zone]")].find((node) => node.contains(target)) ??
        null
      // This listener sits on the window in the capture phase, so without a containment check it
      // also swallowed every right-click in the chrome: the session list, the left navigation and
      // the file tree all opened the transcript's text menu, and their own menus never ran. Only
      // the conversation (and its portalled header) belongs to this menu now.
      const element = target instanceof Element ? target : null
      const inConversation =
        (root?.contains(target) ?? false) ||
        (headerRef.current?.contains(target) ?? false) ||
        element?.closest("[data-chat-drop-zone]") !== null
      // Fallback for the case the module never binds a conversation root: everything that is
      // visibly app chrome opts out by selector, and only genuinely unknown surfaces keep the old
      // "open anywhere" behaviour.
      const chrome =
        element?.closest(
          ".main-sidebar-shell, .main-sidebar-viewport, .session-list-content, .leading-navigation, .file-workspace-panel, .alwith-file-tree, [data-file-path]"
        ) ?? null
      if (!inConversation && (chrome !== null || root !== null)) return
      try {
        event.preventDefault()
        event.stopPropagation()
        setMenu({
          x: event.clientX,
          y: event.clientY,
          text: contextMenuText(target),
          editable: isEditableTarget(target),
          selectionRect: selectionRectOf()
        })
      } catch {
        // A measurement edge case must never cost the menu.
      }
    }
    // Secondary trigger on the press itself: WebKit can swallow the `contextmenu` event for a
    // right-click on selected text (it routes to its own text-interaction path), and the menu
    // then never opened. The coordinates match, so the later contextmenu event is idempotent.
    const press = (event: MouseEvent): void => {
      if (event.button !== 2) return
      open(event)
    }
    // Bound on the window, not the wrapper: the conversation body renders in a subtree this view
    // does not own, and the transcript can stop the event before a document-level listener runs.
    // Window capture is the earliest point a page can observe, so nothing upstream can hide it.
    window.addEventListener("mousedown", press, true)
    window.addEventListener("contextmenu", open, true)
    return () => {
      window.removeEventListener("mousedown", press, true)
      window.removeEventListener("contextmenu", open, true)
    }
  }, [])
  // A subagent's session lives in the same Codex home; it opens like any session of this project.
  const openSession = useCallback(
    (sessionId: string, title: string): void =>
      onSelectSession?.({ sessionId, cwd: session.cwd, title, updatedAt: null, archived: false }),
    [onSelectSession, session.cwd]
  )
  // A second, element-level path: some module surfaces stop the bubbling `contextmenu` before
  // the document listener sees it, so the view's own wrapper opens the same menu.
  const openContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Node)) return
    if (target instanceof Element && target.closest("[data-composer]") !== null) return
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      text: contextMenuText(target),
      editable: isEditableTarget(target),
      selectionRect: selectionRectOf()
    })
  }
  return (
    <ChatBranchProvider key={session.id} session={session} onSelect={onSelectSession}>
      <ChatOpenSessionContext value={openSession}>
        {/* Relative links and image paths resolve against the session's directory. */}
        <ChatDirectoryContext value={session.cwd}>
          {/* The edge actions are absolutely positioned, so they need a positioned ancestor of
              their own — without it they anchor to the window and drift behind the preview.
              Pure chat: with the preview and file columns closed the surface is the full window,
              so a narrow column leaves a dead band on both sides. A wider centred measure reads
              like WorkBuddy's single-column chat; in split view the pane is narrower than the cap,
              so this changes nothing there. Keep draft-chat.tsx in sync. */}
          <div
            className="relative mx-auto h-full min-h-0 w-full max-w-[1120px]"
            data-conversation-detail={detail}
            data-group-discussion={isGroupDiscussion ? "" : undefined}
            onContextMenu={openContextMenu}
          >
            <Conversation {...props} rootRef={rootRef} />
            {/* Temporary chats have no project memory: read/compress/clear do not apply. */}
            {isTemporaryChatDir(session.cwd) ? null : (
              <ChatEdgeActions
                sessionId={session.id}
                onClearContext={
                  onClearContext
                    ? () => {
                        // Carry the current model/effort into the next conversation instead of
                        // dropping back to the provider default.
                        client.rememberCurrentForNextChat(session.id)
                        onClearContext(session.cwd)
                      }
                    : undefined
                }
                // Archive first, compress second: a failed archive must abort the compression so
                // the pre-compression text is never destroyed without a copy in history.md.
                onCompressMemory={
                  session.state === "idle"
                    ? () => {
                        void snapshotProjectMemory(session.cwd)
                          .then(() =>
                            client.prompt(session.id, [{ type: "text", text: t("chat.compressMemoryPrompt") }])
                          )
                          .catch((error: unknown) =>
                            toast.error(error instanceof Error ? error.message : String(error))
                          )
                      }
                    : undefined
                }
                // Only a settled session can take a prompt; a busy one would reject it, so the
                // action falls back to filling the composer instead.
                onSend={
                  session.state === "idle" ? (text) => client.prompt(session.id, [{ type: "text", text }]) : undefined
                }
              />
            )}
            <ChatContextMenu
              target={menu}
              onClose={() => setMenu(null)}
              onAddToChat={(text) => {
                if (!appendQuote(session.id, text)) toast.error(t("chat.selectionAddFailed"))
                // Focus the composer so typing continues where the quote landed.
                document
                  .querySelector<HTMLElement>(
                    "[data-composer] textarea, [data-composer] [contenteditable='true'], [data-composer] [contenteditable='']"
                  )
                  ?.focus()
              }}
            />
            {/* Select-text floating actions: copy, or quote the passage into the composer. */}
            <SelectionMenu containerRef={rootRef} sessionId={session.id} />
          </div>
        </ChatDirectoryContext>
      </ChatOpenSessionContext>
    </ChatBranchProvider>
  )
}
