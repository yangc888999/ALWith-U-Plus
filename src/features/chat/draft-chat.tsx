// A draft owns a real ACP session before the first send, as in Desktop.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { createSession } from "@alwith/api"
import { drafts, importDraft, SessionActions } from "@alwith/module-chat/conversation"
import { relativeTime } from "@alwith/module-chat/session-list"
import { invoke } from "@tauri-apps/api/core"
import { ArrowUpRightIcon, FolderIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import type { DraftOwner } from "@/agent/client"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { dispatchCollection, reportCollection } from "@/features/collection/store"
import { useDisplayProfile } from "@/features/profile/use-display-profile"
import { client, useApp, useSession } from "@/lib/client"
import { describeError } from "@/lib/error-text"
import type { ProviderSnapshot } from "@/lib/providers"
import { isTemporaryChatDir } from "@/lib/quick-chat"
import { startupSilent } from "@/lib/startup-window"
import { useStartupSilent, useStartupStalled } from "@/lib/use-startup-silent"
import { cn } from "@/lib/utils"

import { ChatActionsMenu } from "./chat-actions-menu"
import { focusComposer, SelectionMenu } from "./selection-menu"
import { ChatMemoryButton } from "./chat-edge-actions"
import { ChatHeader } from "./chat-header"
import { ChatHostProvider } from "./chat-host"
import { ChatComposer } from "./composer"
import { ModelEntry } from "./composer/model-entry"
import { selectSessionModel } from "./composer/select-session-model"
import { FilePreviewModal } from "./dialogs/file-preview-modal"
import { chooseFolder, DraftProjectPicker } from "./draft-project-picker"
import { greetingKey, greetingPeriod, welcomeName, welcomeSubtitleKey } from "./welcome-greeting"
import { recentProjectsFrom } from "./welcome-projects"

export const DRAFT_SESSION_ID = "draft"

/** How long a startup-class failure keeps retrying before it is allowed on screen.
 *
 *  This used to be a *count* (`STARTUP_RECOVERY_LIMIT = 8`), which bottoms out at roughly
 *  9.25 s of backoff. On 2026-11-08 another Mac's log showed exactly why that is not enough:
 *  the process started at 16:30:10 and the provider only reached `completed` at 16:30:18 —
 *  eight seconds of cold start, with **no error written to any log**, yet the window kept a
 *  `Model provider 'alwith' not found` card. The retry budget had run out a few hundred
 *  milliseconds before the engine became usable, so the card was painted for a failure that
 *  was already healing. A time budget covers a slow cold start without hiding a real one:
 *  after this window the error is still shown. */
const STARTUP_RECOVERY_WINDOW_MS = 20_000

/** 只有"启动还没成功"这个阶段值得静默重试；静默期之外一律按真实错误处理。
 *  早先只匹配 config.toml 的两种字面量，导致 `alwith-runtime is not running` /
 *  `ECONNREFUSED` 这类更常见的启动失败第一次就上屏（2026-11-08 审计）。 */
function isStartupRecoverableError(error: unknown): boolean {
  if (startupSilent()) return true
  const message = error instanceof Error ? error.message : String(error ?? "")
  if (!/alwith|config\.toml/i.test(message)) return false
  return /model provider|invalid configuration|failed to load workspace requirements|codex process has exited|agent codex exited/i.test(
    message
  )
}

export function DraftChat({
  owner,
  cwd,
  onCwdChange,
  onCwdResolved = onCwdChange,
  onListed,
  onCreated,
  onPrepareFailed,
  collectionId,
  onSendingChange,
  onVoiceHandoff,
  onAuthRequired,
  providerSnapshot,
  onOpenWindow,
  onReturnToMain,
  runOperation,
  headerTarget,
  onNewChat,
  onNewProject,
  startSurface = "work",
  projectSession = false,
  directChat = false,
  onOpenProject
}: {
  owner: DraftOwner
  cwd: string | null
  onCwdChange: (cwd: string) => void
  onCwdResolved?: (cwd: string) => void
  onListed?: (sessionId: string, directory: string) => void
  /** Bind the precreated session to this surface without materializing a history entry. */
  onCreated: (sessionId: string) => void
  onPrepareFailed?: () => void
  collectionId?: string
  /** Hold this composer only while its own first send is waiting for acceptance. */
  onSendingChange: (sessionId: string, sending: boolean) => void
  onVoiceHandoff?: (sessionId: string, receipt: string) => void
  onAuthRequired: () => void
  providerSnapshot: ProviderSnapshot | null
  runOperation?: (operation: () => Promise<void>) => Promise<void>
  onOpenWindow?: () => void
  onReturnToMain?: () => void
  headerTarget?: HTMLElement | null
  onNewChat: () => void
  onNewProject?: () => void
  /** Which new-task tab opens first. Embedded test surfaces keep Work unless they say otherwise. */
  startSurface?: "chat" | "work"
  /** A new conversation started from a project folder: skip the generic hero and open directly. */
  projectSession?: boolean
  /** A newly created quick chat: skip the generic hero and land straight in its composer. */
  directChat?: boolean
  /** Opens the newest conversation in a recent project, or a fresh draft when it has none. */
  onOpenProject?: (cwd: string, sessionId?: string) => void
}) {
  const { t, i18n } = useTranslation()
  const sessionRows = useApp((state) => state.sessionList)
  const connection = useApp((state) => state.connection)
  // 准备 effect 不再观察"连上了没有"：连接抖动重跑它会顺手调 connect()，
  // 而 SDK 的 hold() 在 adopt 失败时会停掉健康引擎，于是抖动变成 1~3 秒一轮的互踢（2026-11-18）。
  // 连接状态仍供错误卡与输入框使用，见下方 `connection === "ready"`。
  const silent = useStartupSilent()
  // 热启动下始终 false：连灰字都不画，避免"闪一下"。
  const stalled = useStartupStalled()
  const [id, setId] = useState<string | null>(
    () => Object.keys(client.state.draftSessions).find((key) => client.state.draftSessions[key] === owner) ?? null
  )
  const session = useSession(id)
  // Local input exists before ACP does; this detached view never enters the client store.
  const pendingComposer = useMemo(() => createSession(DRAFT_SESSION_ID, cwd ?? ""), [cwd])
  // Select-text actions (copy / quote into the composer) work on the welcome screen too.
  const selectionRoot = useRef<HTMLDivElement>(null)
  // Temporary chats live in the quick-chat folder: no project may be picked from here.
  const [preparing, setPreparing] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const displayDirectory = error === null ? cwd ?? session?.cwd ?? null : session?.cwd ?? cwd
  const temporaryChat = isTemporaryChatDir(session?.cwd ?? cwd)
  const workProjectSelected = !temporaryChat
  const [surface, setSurface] = useState<"chat" | "work">(startSurface)
  const [projectReminderOpen, setProjectReminderOpen] = useState(false)
  const projectDraft = projectSession && !temporaryChat && displayDirectory !== null
  const directChatDraft = directChat && temporaryChat
  const minimalDraft = projectDraft || directChatDraft
  // A project conversation has no meaningful "temporary chat" tab: force the work composer even
  // when the previous surface preference was Chat.
  const chatSurface = directChatDraft || (!projectDraft && surface === "chat")
  // Startup config failures are transient: retry quietly instead of flashing the raw English ACP
  // error in the sidebar for one frame (the main window already has its own startup grace).
  const startupRecoveryAttempts = useRef(0)
  // `null` until the first startup-class failure; from then on the retry loop runs until this
  // instant, regardless of how many attempts it takes.
  const recoveryDeadline = useRef<number | null>(null)
  const [attempt, setAttempt] = useState(0)
  // A cleared context parks the previous model/effort; the draft starts from it so the next
  // conversation keeps what the user had dialled in rather than the provider default.
  const inheritedEffort = useRef<string | null>(null)
  // A saved provider catalog change (sign-in, logout, a new model list) can invalidate the
  // draft's model, so preparation follows the revision — never the connection status: that flips
  // on every catalog reset/apply and turned this effect into a connect()/restart loop (2026-11-18).
  const providerRevision = providerSnapshot?.revision
  const [model, setModel] = useState<string | null>(() => {
    const inherited = client.takeInherited()
    inheritedEffort.current = inherited?.effort ?? null
    return inherited?.model ?? null
  })
  const callbacks = useRef({ onCwdResolved, onListed, onCreated, onPrepareFailed })
  callbacks.current = { onCwdResolved, onListed, onCreated, onPrepareFailed }
  const currentId = useRef(id)
  currentId.current = id
  const mounted = useRef(false)
  const preparation = useRef<Promise<string | null> | null>(null)
  const context = useRef({ owner, cwd })
  context.current = { owner, cwd }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const projects = useMemo(
    () => recentProjectsFrom(sessionRows, Infinity, isTemporaryChatDir),
    [sessionRows]
  )
  const recentProjects = useMemo(() => projects.map((project) => project.cwd), [projects])
  const recentProjectItems = projects.slice(0, 4)
  const profile = useDisplayProfile()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    // A window left open across noon or midnight should not keep saying "早上好".
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const autoFocused = useRef(false)
  useEffect(() => {
    // The package focuses once on mount, but the textarea is disabled until preparation finishes.
    // That first focus is a no-op on WebKit, so a new conversation sometimes accepted typing
    // without ever showing the caret. Retry once the ready state turns the control on.
    if (autoFocused.current || preparing || error !== null || connection !== "ready") return
    autoFocused.current = true
    const timer = window.setTimeout(() => {
      const active = document.activeElement
      if (active === null || active === document.body) focusComposer(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [preparing, error, connection])
  const name = welcomeName(profile?.displayName, profile?.email)
  const period = greetingPeriod(now)
  const greeting = t(greetingKey(period, name !== null), { name: name ?? "" })
  const subtitle = t(welcomeSubtitleKey(period))

  useEffect(() => {
    // Explicit retries and provider revisions invalidate preparation. `connected` is deliberately
    // NOT a dependency: a dropped agent handle flips it, and re-running this effect on that flip
    // called `connect()` again, which the SDK answered by stopping and restarting the engine —
    // a 1-3 second reconnect storm that no page ever asked for (2026-11-18). The connection banner
    // and the error card (both explicit) own reconnection; preparation only re-runs on real input.
    void attempt
    let active = true
    const notifyListed = callbacks.current.onListed
    setPreparing(true)
    setError(null)
    const pending = (async (): Promise<string | null> => {
      // Path normalization and the engine connection are independent; awaiting them serially
      // added their latencies to every new chat before a session row could appear.
      const [directory] = await Promise.all([
        invoke<string>("draft_directory", { cwd }),
        client.connect()
      ])
      if (!active) return null
      const current = currentId.current
      // Normalizing the default directory may rerun this effect after the first
      // prompt has materialized its session. Keep that conversation selected.
      if (current !== null && client.state.sessions[current]?.cwd === directory && !client.state.draftSessions[current])
        return current
      const next = notifyListed === undefined
        ? await client.prepareDraft(owner, directory, model)
        : await client.prepareDraft(owner, directory, model, false, (id) => {
            if (active) notifyListed(id, directory)
          })
      const previous = currentId.current
      if (previous !== next) {
        const input = drafts.get(previous ?? DRAFT_SESSION_ID)
        if (input) importDraft(next, input)
        // The placeholder is consumed once a real session owns its input.
        if (previous === null) importDraft(DRAFT_SESSION_ID, null)
      }
      // Every committed replacement carries the input forward, even when a newer
      // directory request is pending. A later failure must leave a usable session.
      currentId.current = next
      if (!mounted.current) return next
      setId(next)
      callbacks.current.onCreated(next)
      if (active && cwd !== directory) callbacks.current.onCwdResolved(directory)
      return next
    })()
    preparation.current = pending
    void pending.then(
      () => {
        if (active) {
          startupRecoveryAttempts.current = 0
          recoveryDeadline.current = null
          setPreparing(false)
        }
      },
      (failure: unknown) => {
        if (!active) return
        // Startup-class failures retry on a *time* budget, so a cold start slower than ~9 s no
        // longer paints an error it is about to disprove. The backoff still maxes out at 1200 ms.
        if (isStartupRecoverableError(failure)) {
          if (recoveryDeadline.current === null) recoveryDeadline.current = Date.now() + STARTUP_RECOVERY_WINDOW_MS
          if (Date.now() < recoveryDeadline.current) {
            const count = ++startupRecoveryAttempts.current
            setPreparing(true)
            window.setTimeout(() => {
              if (active) setAttempt((value) => value + 1)
            }, Math.min(250 * 2 ** Math.min(count - 1, 4), 1200))
            return
          }
        }
        // 静默期内即使预算用完也不上屏：宁可继续显示"正在启动"，也不闪一次红字。
        // 真失败会在静默窗过期（20 秒）后由下面的错误卡接管。
        if (startupSilent()) {
          setPreparing(true)
          return
        }
        setError(failure)
        callbacks.current.onPrepareFailed?.()
        setPreparing(false)
      }
    )
    // Cleanup does not close the session: remounts and handoffs are not abandonment.
    return () => {
      active = false
    }
  }, [owner, cwd, providerRevision, attempt, model])

  // An engine that is already ready disproves a startup-class error: whatever it described is no
  // longer true, and leaving the card up only sends the reader to press a 「重试」 that has nothing
  // left to retry. Heal exactly once per mount — a failure that is still real re-paints the card
  // and stays there, so nothing is hidden.
  const startupHealed = useRef(false)
  useEffect(() => {
    if (startupHealed.current || connection !== "ready" || error === null) return
    if (!isStartupRecoverableError(error)) return
    startupHealed.current = true
    recoveryDeadline.current = null
    setError(null)
    setPreparing(true)
    setAttempt((value) => value + 1)
  }, [connection, error])

  const send = async (prompt: acp.ContentBlock[], accept?: (receipt: string) => void): Promise<void> => {
    let target: string | null
    // Follow preparation retries, but never send into a different project or abandoned surface.
    for (;;) {
      const pending = preparation.current
      if (pending === null) throw new Error("The draft session has not started preparing")
      try {
        target = await pending
      } catch (failure) {
        if (mounted.current && pending !== preparation.current) continue
        throw failure
      }
      if (!mounted.current || context.current.owner !== owner || (cwd !== null && context.current.cwd !== cwd))
        throw new Error("The draft changed before the message was sent")
      if (pending !== preparation.current) continue
      if (target === null) throw new Error("The draft session preparation was cancelled")
      break
    }
    onSendingChange(target, true)
    try {
      // The effort carried over from a cleared context applies to the first turn of the new
      // conversation — only now does the session exist to receive it.
      if (inheritedEffort.current !== null) {
        const effort = inheritedEffort.current
        await client.setConfig(target, "effort", effort)
        inheritedEffort.current = null
      }
      if (accept === undefined) await client.prompt(target, prompt)
      else accept(await client.prompt(target, prompt))
      if (collectionId !== undefined)
        reportCollection(dispatchCollection({ type: "add", collectionId, sessionId: target }))
    } finally {
      // On failure, keep the input and let native draft ownership decide the view:
      // a request dispatched without a receipt may already have started a turn.
      onSendingChange(target, false)
    }
  }
  const picker = (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <DraftProjectPicker
          cwd={displayDirectory}
          recentProjects={recentProjects}
          onChange={onCwdChange}
          preparing={preparing}
        />
        {!temporaryChat && (
          <ChatMemoryButton
            className="ms-auto"
            sessionId={id ?? DRAFT_SESSION_ID}
            onSend={
              error === null && connection === "ready"
                ? (text) => send([{ type: "text", text }])
                : undefined
            }
          />
        )}
      </div>
    </div>
  )
  return (
    <ChatHostProvider>
      <div
        ref={selectionRoot}
        data-chat-drop-zone
        className="relative mx-auto flex h-full min-h-0 w-full max-w-[var(--chat-column-width)] flex-col"
      >
        {/* The main window has nothing to title before the first message, so the draft shows
            only the conversation; the floating window keeps its drag bar and its menus. */}
        {headerTarget !== undefined && (
          <ChatHeader target={headerTarget} title={t("sidebar.newChat")}>
            <ChatActionsMenu
              surface="floating"
              onOpenWindow={session && !preparing ? onOpenWindow : undefined}
              onReturnToMain={preparing ? undefined : onReturnToMain}
              cwd={session?.cwd ?? cwd}
              onNewChat={onNewChat}
              onNewProject={onNewProject}
            />
          </ChatHeader>
        )}
        <div
          className="welcome-hero relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6"
          data-welcome-mode={projectDraft ? "work" : directChatDraft ? "chat" : surface}
          data-project-draft={projectDraft ? "true" : undefined}
          data-direct-chat={directChatDraft ? "true" : undefined}
        >
          {/* Only the greeting and composer form the centred hero. Recent projects hang below the
              composer without joining its height, so switching Work on/off never moves the hero. */}
          <div className="welcome-hero-core relative flex w-full flex-col items-center">
            {minimalDraft && (
              <div
                data-minimal-identity=""
                className="mb-5 flex w-full max-w-3xl items-center justify-center gap-3 px-2"
              >
                {profile !== null && (
                  <Avatar className="size-9 shrink-0 shadow-sm">
                    {profile.avatarUrl && <AvatarImage src={profile.avatarUrl} alt="" />}
                    <AvatarFallback className="bg-primary text-xs text-primary-foreground">
                      {profile.initials}
                    </AvatarFallback>
                  </Avatar>
                )}
                <div className="min-w-0 text-left">
                  <p className="truncate text-sm font-medium text-foreground">{greeting}</p>
                  <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
                </div>
              </div>
            )}
            {!minimalDraft && (
              <div className="flex w-full flex-col items-center gap-5">
                <div className="w-full max-w-4xl text-center">
                  <p className="text-[0.8125rem] leading-5 font-medium tracking-[0.01em] text-muted-foreground">
                    {greeting}
                  </p>
                  <h1 className="mt-1 text-[1.125rem] leading-7 font-medium tracking-[-0.01em] text-foreground/85 sm:text-[1.25rem]">
                    {subtitle}
                  </h1>
                </div>
                <div
                  role="tablist"
                  aria-label={t("welcome.startMode")}
                  className="grid w-[16rem] grid-cols-2 gap-1 rounded-full border border-border/70 bg-muted/55 p-1.5"
                >
                  {(["chat", "work"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="tab"
                      aria-selected={surface === mode}
                      className={cn(
                        "inline-flex h-10 w-full items-center justify-center rounded-full text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        surface === mode
                          ? "bg-background text-foreground shadow-sm ring-1 ring-border/70"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                      onClick={() => {
                        setSurface(mode)
                        requestAnimationFrame(() => focusComposer())
                      }}
                    >
                      {t(mode === "chat" ? "welcome.tabChat" : "welcome.tabWork")}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div
              className={cn("welcome-hero-composer w-full max-w-3xl", minimalDraft ? "mt-0" : "mt-5")}
              // A capture-phase guard runs before the package clears its draft and dispatches the
              // prompt. Clicking send or pressing Enter without a project therefore opens the reminder
              // while leaving every typed character and attachment in place.
              onSubmitCapture={(event) => {
                if (chatSurface || workProjectSelected) return
                event.preventDefault()
                event.stopPropagation()
                setProjectReminderOpen(true)
              }}
            >
              <ChatComposer
                inputHeader={chatSurface ? undefined : picker}
                session={session ?? pendingComposer}
                allowPendingInput
                preparing={preparing}
                modelSelector={
                  <ModelEntry
                    surface="draft"
                    session={session}
                    snapshot={providerSnapshot}
                    model={model}
                    preparing={preparing}
                    failure={error}
                    connected={connection === "ready"}
                    onChange={(value) => {
                      // A conversation that already started keeps its stream: park the choice for the
                      // next turn instead of re-preparing a draft, which would swap the surface out
                      // from under a running first turn. `null` is the picker's "native default" and
                      // only ever comes from the pre-session picker, which has no config option to write.
                      const started =
                        session !== null &&
                        value !== null &&
                        (session.items.length > 0 ||
                          session.state !== "idle" ||
                          client.state.runStates[session.id]?.state === "running" ||
                          client.state.draftSessions[session.id] === undefined)
                      if (started) {
                        void selectSessionModel(session.id, value)
                        return
                      }
                      if (value === model) {
                        if (error !== null) setAttempt((previous) => previous + 1)
                        return
                      }
                      setPreparing(true)
                      setModel(value)
                    }}
                  />
                }
                disabled={
                  session === null ||
                  preparing ||
                  error !== null ||
                  connection !== "ready"
                }
                onSubmit={runOperation ? (prompt, accept) => runOperation(() => send(prompt, accept)) : send}
                onHandOff={onVoiceHandoff}
              />
            </div>
            {/* 启动静默期（引擎还没 ready）里只说「正在启动」：这段时间的失败是冷启动 / config 自愈的
                过程态，红卡一闪再消失就是用户说的"启动就报错"。静默窗结束仍失败才走下面的错误卡。 */}
            {stalled && (
              <div className="mt-3 flex w-full max-w-3xl justify-center px-2 text-xs text-muted-foreground" role="status">
                {t("connection.connecting")}
              </div>
            )}
            {!silent && !preparing && (error !== null || connection !== "ready") && (
              <div className="mt-3 flex w-full max-w-3xl flex-wrap items-center justify-center gap-2 px-2 text-sm" role="status">
                <span>{error !== null ? describeError(error) : t("connection.disconnected")}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // An explicit press must reach the engine: the replay breaker answers automatic
                    // re-asks with the cached failure, and without this the button looked dead.
                    client.retryReplay(owner)
                    setAttempt((value) => value + 1)
                  }}
                >
                  {t("actions.retry")}
                </Button>
                {/* The picker belongs to the composer's bottom-right slot, never to this row: the
                    composer always renders a model entry, so a second one here showed two controls
                    for the same choice (2026-11-17). */}
                <Button variant="outline" size="sm" onClick={onAuthRequired}>
                  {t("chat.draft.configureProvider")}
                </Button>
              </div>
            )}
            {id !== null && (
              <div className="mt-3 w-full max-w-3xl">
                <SessionActions sessionId={id} />
              </div>
            )}
            {!chatSurface && !minimalDraft && recentProjectItems.length > 0 && (
              <section
                className="welcome-hero-recent absolute inset-x-0 top-[calc(100%+1.5rem)] mx-auto w-full max-w-3xl"
                aria-label={t("welcome.recentProjects")}
              >
                <h2 className="mb-2 px-1 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                  {t("welcome.recentProjects")}
                </h2>
                <div className="welcome-recent-grid grid grid-cols-1 gap-2">
                  {recentProjectItems.map((item) => (
                    <button
                      key={item.cwd}
                      type="button"
                      className="group flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-background/45 px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      title={item.cwd}
                      onClick={() => {
                        if (onOpenProject !== undefined) {
                          onOpenProject(item.cwd, item.sessionId ?? undefined)
                          return
                        }
                        onCwdChange(item.cwd)
                        requestAnimationFrame(() => focusComposer())
                      }}
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                        <FolderIcon aria-hidden="true" className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{item.name}</span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {item.title ?? item.cwd}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground/75">
                        {item.updatedAt !== null && relativeTime(item.updatedAt, i18n.language)}
                        <ArrowUpRightIcon
                          aria-hidden="true"
                          className="size-3.5 opacity-0 transition-opacity group-hover:opacity-70"
                        />
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
        <SelectionMenu containerRef={selectionRoot} sessionId={DRAFT_SESSION_ID} scope="transcript" />
        <FilePreviewModal />
        <AlertDialog open={projectReminderOpen} onOpenChange={setProjectReminderOpen}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>{t("chat.draft.projectRequiredTitle")}</AlertDialogTitle>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  void chooseFolder(session?.cwd ?? cwd).then((path) => {
                    if (path === null) return
                    onCwdChange(path)
                    setProjectReminderOpen(false)
                  })
                }}
              >
                {t("chat.draft.addProject")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </ChatHostProvider>
  )
}
