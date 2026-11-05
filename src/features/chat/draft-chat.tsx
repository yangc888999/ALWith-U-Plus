// A draft owns a real ACP session before the first send, as in Desktop.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { createSession } from "@alwith/api"
import { drafts, importDraft, ModelMenu, SessionActions } from "@alwith/module-chat/conversation"
import { invoke } from "@tauri-apps/api/core"
import { MessageCircleIcon, SparklesIcon } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import type { DraftOwner } from "@/agent/client"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { dispatchCollection, reportCollection } from "@/features/collection/store"
import { client, useApp, useSession } from "@/lib/client"
import { describeError } from "@/lib/error-text"
import type { ProviderSnapshot } from "@/lib/providers"
import { startupSilent } from "@/lib/startup-window"
import { useStartupSilent, useStartupStalled } from "@/lib/use-startup-silent"

import { ChatActionsMenu } from "./chat-actions-menu"
import { SelectionMenu } from "./selection-menu"
import { isQuickChatDirectory } from "@alwith/module-chat/session-list"
import { ChatEdgeActions } from "./chat-edge-actions"
import { ChatHeader } from "./chat-header"
import { ChatHostProvider } from "./chat-host"
import { ChatComposer } from "./composer"
import { DraftModelSelect } from "./composer/draft-model-select"
import { chatModelMenu } from "./composer/model-catalog"
import { FilePreviewModal } from "./dialogs/file-preview-modal"
import { DraftProjectPicker } from "./draft-project-picker"

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
  onCreated,
  collectionId,
  onSendingChange,
  onVoiceHandoff,
  onAuthRequired,
  providerSnapshot,
  onOpenWindow,
  onReturnToMain,
  runOperation,
  headerTarget,
  projectMenu,
  onNewChat,
  onNewProject
}: {
  owner: DraftOwner
  cwd: string | null
  onCwdChange: (cwd: string) => void
  /** Bind the precreated session to this surface without materializing a history entry. */
  onCreated: (sessionId: string) => void
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
  projectMenu?: ReactNode
  onNewChat: () => void
  onNewProject?: () => void
}) {
  const { t } = useTranslation()
  const sessionRows = useApp((state) => state.sessionList)
  const connection = useApp((state) => state.connection)
  // 只关心"连上了没有"这个布尔量：以前直接把 connection 放进准备 effect 的依赖里，
  // connecting → failed 的每一次翻转都会重跑一遍、把 error 清空再设回去，卡片就这么闪（2026-11-08）。
  const connected = connection === "ready"
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
  const temporaryChat = (session?.cwd ?? cwd) !== null && isQuickChatDirectory((session?.cwd ?? cwd) as string)
  const [preparing, setPreparing] = useState(true)
  const [error, setError] = useState<unknown>(null)
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
  const [model, setModel] = useState<string | null>(() => {
    const inherited = client.takeInherited()
    inheritedEffort.current = inherited?.effort ?? null
    return inherited?.model ?? null
  })
  const callbacks = useRef({ onCwdChange, onCreated })
  callbacks.current = { onCwdChange, onCreated }
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
  const providerRevision = providerSnapshot?.revision
  const recentProjects = useMemo(
    () => [
      ...new Set(
        [...sessionRows]
          .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
          .map((sessionRow) => sessionRow.cwd)
      )
    ],
    [sessionRows]
  )

  useEffect(() => {
    // Explicit retries and provider revisions invalidate preparation.
    void attempt
    void providerRevision
    void providerSnapshot?.status
    let active = true
    setPreparing(true)
    setError(null)
    const pending = (async (): Promise<string | null> => {
      const directory = await invoke<string>("draft_directory", { cwd })
      await client.connect()
      if (!active) return null
      const current = currentId.current
      // Normalizing the default directory may rerun this effect after the first
      // prompt has materialized its session. Keep that conversation selected.
      if (current !== null && client.state.sessions[current]?.cwd === directory && !client.state.draftSessions[current])
        return current
      const next = await client.prepareDraft(owner, directory, model)
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
      if (active && cwd !== directory) callbacks.current.onCwdChange(directory)
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
        setPreparing(false)
      }
    )
    // Cleanup does not close the session: remounts and handoffs are not abandonment.
    return () => {
      active = false
    }
  }, [owner, cwd, providerRevision, providerSnapshot?.status, attempt, model, connected])

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
        inheritedEffort.current = null
        await client.setConfig(target, "effort", effort).catch(() => {})
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
          cwd={session?.cwd ?? cwd}
          recentProjects={recentProjects}
          onChange={onCwdChange}
          preparing={preparing}
        />
        {temporaryChat && (
          <span
            className="chat-mode-badge inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium"
            title={t("chat.sessionMode")}
          >
            <MessageCircleIcon aria-hidden="true" className="size-3" />
            {t("chat.sessionMode")}
          </span>
        )}
      </div>
    </div>
  )
  return (
    <ChatHostProvider>
      <div
        ref={selectionRoot}
        data-chat-drop-zone
        className="relative mx-auto flex h-full min-h-0 w-full max-w-[1120px] flex-col"
      >
        {/* The main window has nothing to title before the first message, so the draft shows
            only the conversation; the floating window keeps its drag bar and its menus. */}
        {headerTarget !== undefined && (
          <ChatHeader target={headerTarget} title={t("sidebar.newChat")} project={projectMenu}>
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
        <Empty className="flex-1">
          <EmptyHeader>
            <div className="welcome-accent-chip mb-2" aria-hidden="true">
              <SparklesIcon className="size-7" />
            </div>
            <EmptyTitle className="text-[28px] font-normal">{t("welcome.title")}</EmptyTitle>
            <EmptyDescription>{t("welcome.description")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
        {/* 启动静默期（引擎还没 ready）里只说「正在启动」：这段时间的失败是冷启动 / config 自愈的
            过程态，红卡一闪再消失就是用户说的"启动就报错"。静默窗结束仍失败才走下面的错误卡。 */}
        {stalled && (
          <div className="mx-auto flex w-full max-w-3xl px-6 py-2 text-sm text-muted-foreground" role="status">
            {t("connection.connecting")}
          </div>
        )}
        {!silent && !preparing && (error !== null || connection !== "ready") && (
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-6 py-2 text-sm" role="status">
            <span>{error !== null ? describeError(error) : t("connection.disconnected")}</span>
            <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              {t("actions.retry")}
            </Button>
            <>
              <Button variant="outline" size="sm" onClick={onAuthRequired}>
                {t("chat.draft.configureProvider")}
              </Button>
              <DraftModelSelect
                snapshot={providerSnapshot}
                model={model}
                onChange={(value) => {
                  setPreparing(true)
                  setModel(value)
                }}
              />
            </>
          </div>
        )}
        {id !== null && <SessionActions sessionId={id} />}
        {/* A draft is still a conversation in this project: clearing the context lands here, and
            the project memory must stay reachable without first sending a message (it used to be
            missing exactly after 清除上下文 + reopening). Compress/clear have nothing to act on
            yet — compress listens on a live session, clearing is what produced this draft. */}
        {!temporaryChat && (
          <ChatEdgeActions
            sessionId={id ?? DRAFT_SESSION_ID}
            onSend={
              // `send()` already waits for the preparation promise. Gating this on `id !== null &&
              // !preparing` lost clicks in the one-frame gap between the draft materialising and
              // React re-rendering: the memory prompt was silently parked in the composer instead
              // of being sent. Only a real connection/startup failure should fall back to parking.
              error === null && connection === "ready"
                ? (text) => send([{ type: "text", text }])
                : undefined
            }
          />
        )}
        <SelectionMenu containerRef={selectionRoot} sessionId={DRAFT_SESSION_ID} />
        <ChatComposer
          inputHeader={picker}
          session={session ?? pendingComposer}
          allowPendingInput
          preparing={preparing}
          modelSelector={
            session ? (
              <ModelMenu
                {...chatModelMenu}
                sessionId={session.id}
                options={session.configOptions}
                disabled={
                  preparing ||
                  error !== null ||
                  connection !== "ready" ||
                  !session.attached ||
                  session.restoring ||
                  session.readOnly
                }
                onModelChange={(value) => {
                  // A conversation that already started keeps its stream: park the choice for the
                  // next turn instead of re-preparing a draft, which would swap the surface out
                  // from under a running first turn.
                  const started =
                    session !== null &&
                    (session.items.length > 0 ||
                      session.state !== "idle" ||
                      client.state.runStates[session.id]?.state === "running" ||
                      client.state.draftSessions[session.id] === undefined)
                  if (started && session !== null) {
                    void client.setConfig(session.id, "model", value).catch(() => {})
                    return
                  }
                  setPreparing(true)
                  setModel(value)
                }}
              />
            ) : undefined
          }
          disabled={session === null || preparing || error !== null || connection !== "ready"}
          onSubmit={runOperation ? (prompt, accept) => runOperation(() => send(prompt, accept)) : send}
          onHandOff={onVoiceHandoff}
        />
        <FilePreviewModal />
      </div>
    </ChatHostProvider>
  )
}
