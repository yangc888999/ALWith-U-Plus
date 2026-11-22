import { isFormElicitation } from "@alwith/api"
import { exportDraft, type FormAction, importDraft, setComposerDraft } from "@alwith/module-chat/conversation"
import { hasAccount, type RateLimitSnapshot } from "@nyssance/codex-acp-v2/client"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { info } from "@tauri-apps/plugin-log"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { createPortal, flushSync } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useShallow } from "zustand/react/shallow"

import type { SessionSummary } from "@/agent/client"
import { NATIVE_MODEL_GROUP, nativeGroupModels } from "@/agent/native-models"
import { watchSessionList } from "@/agent/session-list-refresh"
import { commands, events } from "@/bindings"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { SidebarInset } from "@/components/ui/sidebar"
import { WallpaperBackground } from "@/features/appearance/wallpaper/background"
import { ActionCard, ElicitationFormDialog } from "@/features/chat/action-card"
import { ChatView } from "@/features/chat/chat-view"
import { DRAFT_SESSION_ID, DraftChat } from "@/features/chat/draft-chat"
import { newChatDirectory } from "@/features/chat/new-chat-directory"
import { registerSessionJump } from "@/features/chat/session-jump"
import { isQuickChatDirectory } from "@alwith/module-chat/session-list"
import { ChatProjectMenu } from "@/features/chat/project-session-popover"
import { useDriveArchive } from "@/features/drive/archive-runtime"
import { DriveDeleteConfirmation, DrivePage, DriveStatus, useDriveConnection } from "@/features/drive/drive"
import { useDrivePluginBridge } from "@/features/drive/plugin-bridge-hook"
import { sendExtensionMessage, setExtensionDraft } from "@/features/extensions/chat/chat"
import { connectExtensionNavigation } from "@/features/extensions/chat/navigation"
import { ExtensionNavigation } from "@/features/extensions/extension-navigation"
import { ExtensionStatusBar } from "@/features/extensions/extension-outlets"
import { ExtensionMount, ExtensionPage } from "@/features/extensions/extension-view"
import { showExtensionLimitations } from "@/features/extensions/legacy/limitations"
import { reportExtensionError } from "@/features/extensions/runtime"
import { useExtensions } from "@/features/extensions/use-extensions"
import { ClientVersionPopover } from "@/features/layout/components/client-version-popover"
import { LeadingNavigation } from "@/features/layout/components/leading-navigation"
import { MainSidebarLayout } from "@/features/layout/components/main-sidebar-layout"
import { TrailingBoard } from "@/features/layout/components/trailing-board"
import { CommandPalette } from "@/features/palette/command-palette"
import { recentMainActivity } from "@/features/sessions/recent-main-activity"
import { selectSession } from "@/features/sessions/select-session"
import { SessionSidebar } from "@/features/sessions/session-sidebar"
import { TitleBarLeadingActions } from "@/features/sessions/title-bar-leading"
import { HotkeysDialog } from "@/features/settings/hotkeys-dialog"
import { syncNeutralAccentWithTheme, useAccentDataAttribute } from "@/features/settings/accent-store"
import { serveAutomationBridge } from "@/features/automation/automation-bridge"
import {
  executeAutomationRun,
  serialAutomationExecutor,
  startAutomationScheduler
} from "@/features/automation/automation-scheduler"
import { getTask, patchRunRecord, setTaskMonitorSession } from "@/features/automation/task-store"
import type { OnRunTask } from "@/features/automation/types"
import { useVoiceHandoff } from "@/features/voice/use-voice-handoff"
import { WorkspaceHeaderContext } from "@/features/workspace/context"
import { createChatDirectory, isTemporaryChatDir } from "@/lib/quick-chat"
import { FileWorkspace } from "@/features/workspace/file-workspace"
import {
  bindProjectDirectory,
  DRAFT_DIRECTORY_KEY,
  isGroupsRoot,
  resolveProjectDirectory,
  shouldOpenFourColumns,
  useBoundProjectDirectory
} from "@/features/workspace/project-directory"
import { usePreviewVisiblePreference } from "@/features/workspace/preview-visible-preference"
import { closeOnlineBiWindow } from "@/features/workspace/online-bi"
import { usePreviewExtension } from "@/features/workspace/preview-extension"
import { logBackgroundError, reportBackgroundError } from "@/lib/background-errors"
import { notify } from "@/lib/notifications"
import { automationSessionRows, automationTitleOf, rememberAutomationSessionId } from "@/lib/automation-sessions"
import { playCompletionSound, soundForRunState } from "@/lib/completion-sound"
import { bumpDockBadge, clearDockBadge } from "@/lib/dock-badge"
import { settingsStore } from "@/lib/settings-store"
import { startFreeModelWatch } from "@/features/providers/free-model-watch"
import { startAppearanceMode, startAppearanceSync } from "@/lib/appearance-mode"
import { startPriceRefresh } from "@/features/settings/price-refresh"
import { installChatShortcut } from "@/lib/chat-shortcut"
import {
  openChatWindow,
  releaseChatWindow,
  serveChatSurface,
  setChatWindowHostReady,
  syncChatWindowSurface
} from "@/lib/chat-window"
import { serveChatClient } from "@/lib/chat-window-client"
import { describeError } from "@/lib/error-text"
import { notifyConversation } from "@/lib/notify"
import { useMainWindowSurface } from "@/lib/chat-window-state"
import { client, markRead, useApp, useSession, watchRunStates } from "@/lib/client"
import { watchForNotifications } from "@/lib/notifications"
import { type Preferences, savePreference } from "@/lib/preferences"
import { ensureDefaultGroupRoles } from "@/lib/group-roles"
import { groupByDirectory } from "@/lib/groups"
import { groupSessionRows } from "@/lib/group-sessions"
import { ensureProjectMemory } from "@/lib/project-memory"
import { applyProvidersWhenIdle } from "@/lib/providers"
import {
  type CachedRateLimits,
  hasRateLimitWindows,
  readCachedRateLimits,
  writeCachedRateLimits
} from "@/lib/rate-limit-cache"
import { onHubExit } from "@/lib/runtime"
import { markStartupReady, startupSilent } from "@/lib/startup-window"
import { useStartupSilent, useStartupStalled } from "@/lib/use-startup-silent"
import { serveSettingsBridge, type SettingsNativeModels } from "@/lib/settings-bridge"
import { useProjectMemory } from "@/lib/use-project-memory"
import { useProviders } from "@/lib/use-providers"
import { useReadVisibleSession } from "@/lib/use-read-visible-session"
import { useSurfaceOperation } from "@/lib/use-surface-operation"
import { useWindowFocus } from "@/lib/window-focus"
import { openSettingsWindow } from "@/lib/window-manager"

// Matches `lib/startup-window.ts#FALLBACK_MS`: a startup failure keeps retrying while the silent
// window is open, and this is how long that window lasts at most before the banner may speak.
const STARTUP_RECOVERY_MS = 20_000

// Pages behind a navigation click. Keeping them out of the startup chunk leaves the first paint
// with only the chat surface to parse, which is what the window shows anyway; each page's chunk
// arrives while the click is still being animated. The always-visible shell stays eager.
const StoryPage = lazy(() => import("@/features/story/story-page").then((module) => ({ default: module.StoryPage })))
const ArchivedChatsPage = lazy(() =>
  import("@/features/sessions/archived-chats-page").then((module) => ({ default: module.ArchivedChatsPage }))
)
const PluginsPage = lazy(() =>
  import("@/features/plugins/plugins-page").then((module) => ({ default: module.PluginsPage }))
)
const ExtensionsSection = lazy(() =>
  import("@/features/extensions/extensions-section").then((module) => ({ default: module.ExtensionsSection }))
)
// 定时任务 lives on the leading screen now: the sidebar row opened the settings window, which
// pushed the reader out of the app they were working in (2026-11-08).
const AutomationPage = lazy(() =>
  import("@/features/automation/automation-page").then((module) => ({ default: module.AutomationPage }))
)
const UsagePage = lazy(() => import("@/features/usage/usage-page").then((module) => ({ default: module.UsagePage })))
const SkillsPage = lazy(() => import("@/features/plugins/skills-page").then((module) => ({ default: module.SkillsPage })))

export function App({ initialPreferences }: { initialPreferences: Preferences }) {
  useAccentDataAttribute()
  // 纯色 + 系统主题：只有主窗口是配色写入者，设置窗口靠 storage 事件跟随。
  useEffect(() => syncNeutralAccentWithTheme({ writer: true }), [])
  useDriveConnection()
  useDrivePluginBridge()
  useDriveArchive()
  const { host: extensions, runtime: extensionRuntime, state: extensionState } = useExtensions()
  const { t } = useTranslation()
  const connection = useApp((state) => state.connection)
  const connectionError = useApp((state) => state.connectionError)
  // 引擎第一次 ready 之前是「启动静默期」：连接横幅绝不显示红色错误，而且连中性的
  // 「正在启动」也要等 800ms 之后才允许出现 —— 热启动只要几百毫秒，画了再抹就是"闪一下"。
  // 这段窗口由 lib/startup-window.ts 统一维护（主窗口 / 草稿页 / 浮窗 / toast 读同一个状态），
  // 早先这里是各自的 5 秒定时器，冷启动慢一点就会先红一下再消失（2026-11-08）。
  const stalled = useStartupStalled()
  const silent = useStartupSilent()
  // The silent window is closed by `connect()` once providers are applied — not here. Closing it
  // on the `connection` event opened a hole between `client.connect()` and
  // `applyProvidersWhenIdle()`, and a failure inside that hole reached the reader as a raw toast.
  const globalActions = useApp(useShallow((state) => state.actions.filter((action) => action.sessionId === null)))
  const globalForms = globalActions.filter(
    (action): action is FormAction => action.kind === "elicitation" && isFormElicitation(action.params)
  )
  const globalInlineActions = globalActions.filter((action) => !globalForms.some((form) => form.id === action.id))
  // Launch lands on the home screen like the official app; no thread is resumed until the
  // user opens one.
  const [driveSidebar, setDriveSidebar] = useState<HTMLDivElement | null>(null)
  const [workspaceToolbar, setWorkspaceToolbar] = useState<HTMLDivElement | null>(null)
  // macOS docks the workspace toolbar (condense + workspace toggle) in the top-right header.
  // Windows keeps the focused-window controls, so this target is only used when it exists.
  const [workspaceTrailing, setWorkspaceTrailing] = useState<HTMLDivElement | null>(null)
  // Every launch opens a fresh draft. A conversation is only opened by an explicit click; there
  // is deliberately no "last session" restore, because reopening the thread from the previous
  // quit hid the new-task screen that is now the launch surface (2026-11-22).
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // While a picked conversation is being prepared, show an explicit "opening" surface instead of
  // the draft composer. A stalled cloud/engine call must neither look like a dead click nor invite
  // typing into a draft that is about to be replaced.
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null)
  // Monotonic token: only the last click is allowed to finish its preparation chain.
  const selectionRef = useRef(0)
  useEffect(() => {
    if (isTauri()) void commands.bridgeSetActiveSession({ sessionId: selectedId })
  }, [selectedId])
  // The group panel lists members by role: seed the five defaults on launch, so a roster the user
  // has not opened settings for yet still reads as configured (and a 群聊 has people in it).
  useEffect(() => {
    ensureDefaultGroupRoles()
  }, [])
  const [submittingDraftId, setSubmittingDraftId] = useState<string | null>(null)
  const [surfaceGeneration, setSurfaceGeneration] = useState(0)
  const voiceHandoff = useVoiceHandoff(selectedId, surfaceGeneration)
  const [chatRevealRequest, setChatRevealRequest] = useState(0)
  const [lastDirectory, setLastDirectory] = useState<string | null>(() =>
    initialPreferences.defaultStartSurface === "chat" ? null : initialPreferences.lastProjectDirectory
  )
  const providerSnapshot = useProviders()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [hotkeysOpen, setHotkeysOpen] = useState(false)
  // Management pages share the leading screen; the offscreen chat stays mounted.
  const [view, setView] = useState<
    "chat" | "plugins" | "extensions" | "archives" | "story" | "extension" | "automation" | "usage" | "skills"
  >("chat")
  const [leadingPage, setLeadingPage] = useState<
    "plugins" | "extensions" | "archives" | "automation" | "usage" | "skills"
  >("plugins")
  const leading =
    view === "plugins" ||
    view === "extensions" ||
    view === "extension" ||
    view === "archives" ||
    view === "automation" ||
    view === "usage" ||
    view === "skills"
  const [extensionView, setExtensionView] = useState<string | null>(null)
  const openExtension = useCallback(
    (id: string): void => {
      const contribution = extensionRuntime.host.snapshot().views.find((item) => item.id === id)
      if (contribution)
        showExtensionLimitations(
          extensionRuntime.snapshot().native?.installations.find((item) => item.id === contribution.extensionId)
        )
      setExtensionView(id)
      setLeadingPage("extensions")
      setView("extension")
    },
    [extensionRuntime]
  )
  const openArchives = useCallback(() => {
    setLeadingPage("archives")
    setView("archives")
  }, [])
  const [pluginsVisited, setPluginsVisited] = useState(false)
  const openPlugins = useCallback(() => {
    setPluginsVisited(true)
    setLeadingPage("plugins")
    setView("plugins")
  }, [])
  const openSkills = useCallback(() => {
    setLeadingPage("skills")
    setView("skills")
  }, [])
  const openExtensions = useCallback(() => {
    setLeadingPage("extensions")
    setView("extensions")
  }, [])
  /** 定时任务: a page inside the main window, exactly like WorkBuddy — the sidebar stays put. */
  const openAutomation = useCallback(() => {
    setLeadingPage("automation")
    setView("automation")
  }, [])
  const openUsage = useCallback(() => {
    setLeadingPage("usage")
    setView("usage")
  }, [])
  /** 扩展 lives in Settings' 应用扩展 page; the leading screen stays for extension surfaces. */
  const openExtensionSettings = useCallback(() => {
    void openSettingsWindow("extensions").catch((error: unknown) => toast.error(describeError(error)))
  }, [])
  const openLeading = useCallback((): void => {
    if (leadingPage === "extensions") openExtensions()
    else if (leadingPage === "archives") openArchives()
    else if (leadingPage === "automation") openAutomation()
    else if (leadingPage === "usage") openUsage()
    else if (leadingPage === "skills") openSkills()
    else openPlugins()
  }, [leadingPage, openExtensions, openArchives, openAutomation, openUsage, openSkills, openPlugins])
  // The online BI surface is a child webview of the main window, so it stays glued on top when the
  // canvas slides to the leading screen (the main content is only `inert`, never unmounted). Close
  // both the preview extension and the standalone BI window the moment we leave the main screen, so
  // the floating BI panel auto-dismisses instead of lingering over the leading view.
  const closePreviewExtension = usePreviewExtension((state) => state.close)
  useEffect(() => {
    if (!leading) return
    closePreviewExtension()
    void closeOnlineBiWindow().catch(() => {})
  }, [leading, closePreviewExtension])
  const session = useSession(selectedId)
  const draftSessions = useApp((state) => state.draftSessions)
  const { busy, operation } = useSurfaceOperation(() =>
    toast.error(t("errors.handoffStalled"), { id: "surface-handoff-stalled" })
  )
  const extensionSession = useRef(session)
  extensionSession.current = session
  useEffect(() => {
    const dependencies = {
      session: (targetId: string) => {
        const target = client.state.sessions[targetId]
        return extensionSession.current?.id === targetId && target?.attached && !target.readOnly
          ? { cwd: target.cwd }
          : null
      },
      skills: async (cwd: string) => {
        const catalog = await client.listSkills([cwd], true)
        return catalog.data.flatMap((entry) => entry.skills)
      },
      present: () => setView("chat"),
      prompt: async (targetId: string, prompt: string) => {
        await client.prompt(targetId, [{ type: "text", text: prompt }])
      },
      writeDraft: setComposerDraft
    }
    return connectExtensionNavigation({
      currentSession: () => {
        const selected = extensionSession.current
        return selected?.attached
          ? {
              id: selected.id,
              cwd: selected.cwd,
              title: selected.title ?? selected.id
            }
          : null
      },
      openView: openExtension,
      send: (id, text, required, check) =>
        operation.run(() => sendExtensionMessage(id, text, required, { ...dependencies, check })),
      setDraft: (id, text, required, check) =>
        operation.run(() => setExtensionDraft(id, text, required, { ...dependencies, check }))
    })
  }, [openExtension, operation])
  const [mainVisible, setMainVisible] = useState(false)
  const focused = useWindowFocus()
  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Window-level question, window-level API: `getCurrentWindow()` resolves the webview
      // that currently has focus, and a child webview (在线 BI) has no window of its own — asking
      // it threw "current webview is not a WebviewWindow" on every click into that pane.
      const window = getCurrentWindow()
      const visible = (focused || (await window.isVisible())) && !(await window.isMinimized())
      if (!cancelled) {
        setMainVisible(visible)
        useMainWindowSurface.setState({
          sessionId: selectedId,
          visible: visible && view === "chat"
        })
      }
    })().catch((error) => toast.error(describeError(error)))
    return () => {
      cancelled = true
    }
  }, [selectedId, focused, view])

  useReadVisibleSession(selectedId, focused && view === "chat")
  useProjectMemory()

  const select = useCallback(
    (sessionRow: SessionSummary) => {
      // A project opened from history must have its memory file too, not only the ones picked in
      // the composer: the read-memory action would otherwise find nothing on older projects.
      void ensureProjectMemory(sessionRow.cwd)
      // One directory source for the whole surface. A 拉会 session is a project like any other;
      // binding its cwd here is what makes the four columns, the file tree and the preview appear
      // on the very first frame instead of waiting for a lookup that never ran.
      bindProjectDirectory(
        sessionRow.sessionId,
        sessionRow.cwd,
        groupByDirectory(sessionRow.cwd)?.id ?? null
      )
      const token = ++selectionRef.current
      const isCurrent = () => token === selectionRef.current
      // Codex refuses to resume an archived session; opening one restores it first, as the
      // official client does. `selectSession` switches the view immediately and prepares the engine
      // in the background, so no surface-operation lock is held here: holding one made the whole
      // window inert while a preparation step stalled, which read as a dead click on the sidebar.
      // The token replaces that lock's one-at-a-time guarantee with last-click-wins.
      selectSession(
        sessionRow,
        {
          connect: async () => {
            await client.connect()
            if (client.state.draftSessions[sessionRow.sessionId] !== "main") await client.discardDraft("main")
          },
          unarchive: (id) => client.unarchive(id),
          release: async (id) => {
            const transfer = await releaseChatWindow(id)
            await client.transferDraft(id, "main")
            return transfer
          },
          importDraft,
          include: (sessionRow) => client.includeSession(sessionRow),
          open: (id, cwd) => {
            // Clicking a conversation is an explicit open: the replay breaker must not answer it
            // with a cached refusal from an earlier attempt (the reader saw a dead click).
            client.retryReplay("main")
            return client.open(id, cwd)
          },
          show: (id) => {
            setOpeningSessionId(id)
            setSurfaceGeneration((value) => value + 1)
            setView("chat")
            setSelectedId(id)
          },
          onOpenError: (error: unknown) => toast.error(describeError(error)),
          onSettled: () => {
            if (isCurrent()) setOpeningSessionId(null)
          }
        },
        isCurrent
      )
    },
    []
  )

  // Expose this `select` to the rest of the app as the one entrance for opening a conversation
  // (toasts, command palette, deep links). It is stable (`[]` deps), so registering on mount is enough.
  useEffect(() => {
    registerSessionJump(select)
  }, [select])

  // Bumped when the reader picks a project folder for a new chat. The workspace opens its columns
  // once per project per run, so without this signal a project already visited would stay in two
  // columns after an explicit "create a chat here".
  const [columnsRequest, setColumnsRequest] = useState(0)
  const chooseDraftFolder = useCallback((directory: string | null, groupId: string | null = null) => {
    setLastDirectory(directory)
    // The draft surface has no session id, so the meeting's folder is bound under the shared draft
    // key. Without it a "新开一场" looked like a chat with no directory and opened only two columns.
    if (directory !== null) bindProjectDirectory(DRAFT_DIRECTORY_KEY, directory, groupId)
    if (directory !== null && !isQuickChatDirectory(directory)) setColumnsRequest((value) => value + 1)
    // Every project a chat is opened in gets a memory.md, including composer folder picks.
    // Temporary chats (quick-chat directory) are not projects and must not create one.
    if (directory === null || !isQuickChatDirectory(directory)) void ensureProjectMemory(directory)
    void savePreference("lastProjectDirectory", directory).catch((error: unknown) => toast.error(describeError(error)))
  }, [])

  // One reaction per conversation settle: system notification + Dock badge + (opt-in) sound.
  // The recorded state makes this idempotent across the frequent run-state republishes.
  const runStates = useApp((state) => state.runStates)
  const knownSessions = useApp((state) => state.sessionList)
  const notifiedStates = useRef(new Map<string, string>())
  const settledBaseline = useRef(false)
  useEffect(() => {
    // The first pass after mount replays states that settled before this window existed. Recording
    // them without reacting is what keeps a relaunch from chiming and re-badging old conversations.
    if (!settledBaseline.current) {
      for (const [id, record] of Object.entries(runStates)) notifiedStates.current.set(id, record.state)
      settledBaseline.current = true
      return
    }
    for (const [id, record] of Object.entries(runStates)) {
      const state = record.state
      if (state !== "done" && state !== "requires_action") {
        notifiedStates.current.set(id, state)
        continue
      }
      if (notifiedStates.current.get(id) === state) continue
      notifiedStates.current.set(id, state)
      // Group and automation rows are not in `sessionList` (the sidebar keeps them apart), so the
      // notification has to look in their stores too or it falls back to a session UUID.
      const title =
        knownSessions.find((row) => row.sessionId === id)?.title ??
        automationTitleOf(automationSessionRows().find((row) => row.sessionId === id)?.title ?? null) ??
        automationSessionRows().find((row) => row.sessionId === id)?.title ??
        groupSessionRows().find((row) => row.sessionId === id)?.title ??
        id
      void notifyConversation(title, state === "done" ? "对话已完成" : "需要你的操作")
      // Two audibly different outcomes: a finished turn vs one waiting for the user's approval.
      // A failed turn stays silent; it still gets the notification and the badge.
      const kind = soundForRunState(state)
      if (kind !== null && settingsStore.get<boolean>("automation.completionSound") === true) {
        playCompletionSound(kind)
      }
      bumpDockBadge()
    }
  }, [runStates, knownSessions])

  // VITE_AUTOTEST=1: 自测模式——逐个打开侧边栏会话，结果写入 ~/Library/Logs/ai.alwith.u/autotest.log
  const autotestRan = useRef(false)
  useEffect(() => {
    if (
      import.meta.env.VITE_AUTOTEST !== "1" ||
      autotestRan.current ||
      connection !== "ready" ||
      knownSessions.length === 0
    )
      return
    autotestRan.current = true
    void (async () => {
      const mark = (line: string): Promise<void> =>
        invoke("append_diagnostic", { line })
          .catch(() => undefined)
          .then(() => undefined)
      await mark(`=== autotest ${new Date().toISOString()} sessions=${knownSessions.length} ===`)
      for (const row of knownSessions.slice(0, 30)) {
        const started = Date.now()
        try {
          // A wedged engine must not freeze the whole run: report the session as a timeout and
          // move on, so one bad chat cannot hide the state of the other eighteen.
          await Promise.race([
            client.open(row.sessionId, row.cwd),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout after 20s")), 20_000))
          ])
          const error = client.state.sessions[row.sessionId]?.error ?? null
          await mark(
            JSON.stringify({
              id: row.sessionId,
              title: row.title,
              ok: error === null,
              error,
              ms: Date.now() - started
            })
          )
        } catch (error) {
          await mark(
            JSON.stringify({
              id: row.sessionId,
              title: row.title,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              ms: Date.now() - started
            })
          )
        }
      }
      await mark("=== autotest done ===")
    })()
  }, [connection, knownSessions])

  // One directory for the whole surface. The old `session?.cwd ?? lastDirectory` resolved to null
  // whenever a resumed conversation had not published its cwd yet, and `isTemporaryChatDir(null)`
  // then turned a real project/meeting into a two-column "temporary chat". A binding written by
  // select / 新开一场 / 查看会议文件 wins over the session cwd, so 拉会 always has a directory even
  // on the very first frame. Subscribing keeps this value fresh on every binding write.
  const directoryKey = selectedId ?? DRAFT_DIRECTORY_KEY
  const boundDirectory = useBoundProjectDirectory(directoryKey)
  const projectDirectory = resolveProjectDirectory({
    sessionId: selectedId,
    sessionCwd: session?.cwd ?? null,
    lastDirectory
  })
  const directory = projectDirectory.directory
  const directoryReason = projectDirectory.reason
  // `readOnly` is deliberately NOT a condition: an account-model recovery session is still a
  // project with files, and hiding its columns because the composer is locked was the reported bug.
  const isTemporaryChat = directoryReason === "temporary"
  // 首页/聊天默认两栏，只有真正进入项目才可能四栏，且仍受「显示预览栏」设置约束。
  // 根因（2026-11-16）：`resolveProjectDirectory` 在没有绑定时会回退到 `lastDirectory`，
  // 于是首次进入/新聊天被当成项目、自动弹出预览栏，把对话栏挤到 17%、输入框挤成一条缝。
  // 因此这里不能用回退后的 `directoryReason` 判定，只看当前 key 的明确绑定或会话自身 cwd。
  // 设置里关掉预览栏时，即使是项目也保持两栏（`shouldOpenFourColumns` 内统一处理）。
  const [previewVisible] = usePreviewVisiblePreference()
  const defaultFourColumns = shouldOpenFourColumns({
    boundDirectory: boundDirectory?.directory ?? null,
    sessionCwd: session?.cwd ?? null,
    previewVisible,
    invalidDirectory: directoryReason === "invalid"
  })
  const directoryGuidance = t(
    directoryReason === "invalid"
      ? "workspace.invalidDirectoryHint"
      : directoryReason === "missing"
        ? "workspace.noDirectoryHint"
        : "workspace.selectFileHint"
  )
  const invalidDirectory = directoryReason === "invalid" ? (session?.cwd ?? lastDirectory) : null

  /**
   * 查看会议文件: show a meeting's folder (group.md / memory.md / 资料 / 产出) without creating a
   * conversation. Binds the current surface — session id, or the draft key before the first turn —
   * then reopens the four columns through the same signal a new project chat uses.
   */
  const openMeetingFiles = useCallback(
    (meetingDirectory: string, groupId: string): void => {
      if (meetingDirectory.trim() === "" || isGroupsRoot(meetingDirectory)) {
        toast.error(t("workspace.invalidDirectory"))
        return
      }
      bindProjectDirectory(directoryKey, meetingDirectory, groupId)
      setLastDirectory(meetingDirectory)
      setColumnsRequest((value) => value + 1)
    },
    [directoryKey, t]
  )

  const [draftCollection, setDraftCollection] = useState<{
    id: string
    generation: number
  } | null>(null)
  const newChatInDirectory = useCallback(
    (cwd?: string | null, collectionId?: string, groupId: string | null = null) => {
      void operation
        .run(async () => {
          const directory = newChatDirectory(cwd === undefined ? (extensionSession.current?.cwd ?? lastDirectory) : cwd)
          await client.discardDraft("main")
          setDraftCollection(
            collectionId === undefined ? null : { id: collectionId, generation: surfaceGeneration + 1 }
          )
          // A group draft still owns the meeting folder; binding it here keeps four columns and the
          // group's files visible before the first message creates a session id.
          chooseDraftFolder(directory, groupId)
          importDraft(DRAFT_SESSION_ID, null)
          setSurfaceGeneration((value) => value + 1)
          setChatRevealRequest((value) => value + 1)
          setView("chat")
          setSelectedId(null)
        }, { handoff: true })
        .catch((error: unknown) => toast.error(describeError(error)))
    },
    [chooseDraftFolder, lastDirectory, operation, surfaceGeneration]
  )

  /** 新建会话: a temporary chat in its own folder under the quick-chat root, never inside a project. */
  const newChat = useCallback(() => {
    void createChatDirectory()
      .then((directory) => newChatInDirectory(directory))
      .catch((error: unknown) => toast.error(describeError(error)))
  }, [newChatInDirectory])

  /** A recent-project card opens that project's newest conversation, not another blank draft. */
  const openRecentProject = useCallback(
    (cwd: string, sessionId?: string) => {
      const exact = sessionId === undefined ? undefined : knownSessions.find((row) => row.sessionId === sessionId)
      const latest =
        exact ??
        [...knownSessions]
          .filter((row) => row.cwd === cwd && !row.archived)
          .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))[0]
      if (latest !== undefined) {
        select(latest)
        return
      }
      newChatInDirectory(cwd)
    },
    [knownSessions, newChatInDirectory, select]
  )

  /** 新建项目: pick a directory, then start a chat inside it (four-column layout by default). */
  const newProject = useCallback(() => {
    void commands
      .pickProjectDirectory()
      .then((directory) => {
        if (directory !== null) newChatInDirectory(directory)
      })
      .catch((error: unknown) => toast.error(describeError(error)))
  }, [newChatInDirectory])

  /**
   * Clears the context of the conversation on screen without leaving it.
   *
   * Codex has no in-place reset, so the thread itself has to be replaced; the old one is archived
   * (still recoverable) instead of being left in the sidebar, and the replacement takes over the
   * same project, model and effort. What the user sees is the current chat starting over rather
   * than a new conversation piling up next to it.
   */
  const clearContextInPlace = useCallback(
    (sessionId: string, cwd: string) => {
      void operation
        .run(async () => {
          // Park the model and effort before the thread goes away; the first turn of the
          // replacement re-applies them.
          client.rememberCurrentForNextChat(sessionId)
          await client.discardDraft("main")
          await client.archive(sessionId)
          // Clearing the context means the next visit starts on a fresh draft in the same project,
          // not on the chat that was just archived. The project itself is remembered separately.
          chooseDraftFolder(cwd)
          importDraft(DRAFT_SESSION_ID, null)
          setSurfaceGeneration((value) => value + 1)
          setChatRevealRequest((value) => value + 1)
          setView("chat")
          setSelectedId(null)
        }, { handoff: true })
        .catch((error: unknown) => toast.error(describeError(error)))
    },
    [chooseDraftFolder, operation]
  )

  const draftCreated = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  useEffect(() => {
    let disposed = false
    const shortcut = installChatShortcut(() => {
      void openChatWindow().catch((error) => toast.error(describeError(error)))
    })
    const ready = (async () => {
      const stopClient = await serveChatClient(client, undefined, (error) => toast.error(describeError(error)))
      const stopSurface = await serveChatSurface(async (action) => {
        switch (action.type) {
          case "present":
            return operation.run(async (signal) => {
              const transfer = action.transfer
              if (!transfer) throw new Error("Returning to main requires a chat transfer")
              await client.connect()
              // The watchdog may have handed the lock to a newer request while this handoff was
              // wedged. Stop before rewriting draft/window state that belongs to the newer one.
              if (signal.abandoned) return null
              if (transfer.sessionId !== null) {
                if (transfer.cwd === null) throw new Error("A chat session must have a working directory")
                await client.transferDraft(transfer.sessionId, "main")
                if (signal.abandoned) return null
                await client.open(transfer.sessionId, transfer.cwd)
              } else {
                await client.discardDraft("main")
              }
              if (signal.abandoned) return null
              importDraft(transfer.sessionId ?? DRAFT_SESSION_ID, transfer.draft)
              setLastDirectory(transfer.cwd)
              setSelectedId(transfer.sessionId)
              setSurfaceGeneration((value) => value + 1)
              setChatRevealRequest((value) => value + 1)
              setView("chat")
              const win = getCurrentWindow()
              await win.unminimize()
              await win.show()
              await win.setFocus()
              return null
            }, { handoff: true })
          case "markRead":
            await markRead(action.sessionId)
            return null
          case "shortcut":
            await shortcut.set(action.shortcut)
            return null
          default:
            throw new Error("Unsupported main window action")
        }
      })
      if (disposed) {
        stopClient()
        stopSurface()
        return () => {}
      }
      void syncChatWindowSurface().catch((error) => toast.error(describeError(error)))
      void shortcut
        .set(initialPreferences.chatWindowShortcut ?? "Alt+Space", false)
        .catch((error) => toast.error(describeError(error)))
      return () => {
        stopClient()
        stopSurface()
      }
    })()
    setChatWindowHostReady(ready)
    return () => {
      disposed = true
      void ready.then((stop) => stop()).catch((error) => toast.error(describeError(error)))
      void shortcut.dispose().catch((error) => toast.error(describeError(error)))
    }
  }, [initialPreferences.chatWindowShortcut, operation])

  // Run states come over the Runtime port; a new port (after alwith-runtime restarted) needs a
  // new subscription, so the watch is restarted with every connect.
  const connect = useCallback(async () => {
    try {
      await client.connect()
      // Restore choices must be checked against the applied provider catalog.
      await applyProvidersWhenIdle()
      // Close the silent window here, not on the `connection` event. `client.connect()` flips
      // `connection` to "ready" before providers are applied; closing on the event left the gap
      // between the two unguarded, and a provider-apply failure in that gap surfaced as a raw
      // `acpRequest: …` toast (2026-11-08). Now the window survives until the engine can serve.
      markStartupReady()
      void info(`connected to ${client.state.agent?.info.name} ${client.state.agent?.info.version}`)
    } catch (error) {
      if (client.state.connection === "failed" || client.state.connection === "disconnected")
        logBackgroundError("runtime-connect", error)
      else reportBackgroundError("provider-startup", error)
    }
  }, [])

  useEffect(() => {
    if (connection === "ready") return watchSessionList(client)
  }, [connection])

  // The engine process can exit on its own (a crash, a killed child). The connection then drops to
  // "disconnected" and every surface that reads the agent goes red until somebody reconnects — the
  // reader had to press "重新连接" for something the app knows how to fix. This is THE connection
  // owner reconnecting: one attempt at a time, bounded backoff, and it stops the moment a connect
  // lands (`connection` leaves "disconnected").
  const lastAutoReconnect = useRef(0)
  useEffect(() => {
    if (connection !== "disconnected") return
    // A surface handoff (the floating chat window returning to main) drops this connection while
    // the other side is still tearing its agent down. Reconnecting inside that window restarts the
    // engine the handoff is already replacing, and the new exit drops the connection again — a
    // self-sustaining restart loop (2026-11-18). Keep a minimum gap between automatic attempts, but
    // never drop the attempt: returning early here left the app disconnected forever once the gap
    // swallowed the only try (an inert 「重新连接」).
    let cancelled = false
    let timer: number | undefined
    const run = async (round: number): Promise<void> => {
      if (cancelled) return
      const wait = Math.max(0, 4_000 - (Date.now() - lastAutoReconnect.current))
      if (wait > 0) {
        timer = window.setTimeout(() => void run(round), wait)
        return
      }
      lastAutoReconnect.current = Date.now()
      await connect()
      if (cancelled || client.state.connection !== "disconnected" || round >= 3) return
      timer = window.setTimeout(() => void run(round + 1), 600 * 2 ** round)
    }
    timer = window.setTimeout(() => void run(0), 400)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [connection, connect])

  useEffect(() => {
    if (focused && connection === "ready" && client.state.sessionListLoaded)
      void client.listSessions({ reset: true }).catch(() => undefined)
  }, [focused, connection])

  // Either window can reconnect the owner; refresh Runtime subscriptions for every ready port.
  useEffect(() => {
    if (connection !== "ready") return
    const stop = watchRunStates()
    void stop.catch((error: unknown) => toast.error(describeError(error)))
    return () => {
      void stop.then(
        (unsubscribe) => unsubscribe(),
        () => undefined
      )
    }
  }, [connection])

  // Passive history replay and draft initialization never overwrite the user's last choice.
  useEffect(() => {
    client.setModelSelections(initialPreferences.modelSelections)
    let saving = Promise.resolve()
    const models = { ...initialPreferences.modelSelections }
    return client.onConfirmedModel((owner, model) => {
      models[owner] = model
      const selection = { ...models }
      saving = saving
        .then(() => savePreference("modelSelections", selection))
        .catch((error) => {
          toast.error(describeError(error))
        })
    })
  }, [initialPreferences.modelSelections])

  // The settings window has no agent connection of its own: it asks this window for the
  // engine identity and for sign-out, and provider keys saved there are applied here.
  const bundledNativeModels: { current: SettingsNativeModels | null } = {
    current: null
  }
  // Last rate-limit snapshot that actually reached ChatGPT. The endpoint lives on chatgpt.com, so
  // a VPN hiccup or an offline moment used to turn the panel into "暂无用量数据" even though the
  // numbers were known a minute ago; the panel now shows this snapshot and labels its age. It is
  // persisted so a restart inside a network outage still has something to show.
  const rateLimitCache = useRef<CachedRateLimits | null>(readCachedRateLimits())
  const rememberLimits = (snapshot: RateLimitSnapshot | null): void => {
    // Only real windows are cached. An empty 200 otherwise wipes the last good snapshot and the
    // panel has nothing to show on the next failed read.
    if (snapshot === null || !hasRateLimitWindows(snapshot)) return
    rateLimitCache.current = { snapshot, capturedAt: Date.now() }
    writeCachedRateLimits(rateLimitCache.current)
  }
  useEffect(() => {
    const stopBridge = serveSettingsBridge({
      agent: () => {
        const agent = client.state.agent
        if (client.state.connection !== "ready" || !agent?.info) return null
        return {
          name: agent.info.title ?? agent.info.name,
          version: agent.info.version,
          authMethods: agent.authMethods ?? [],
          actions: client.state.actions.filter((action) => action.sessionId === null)
        }
      },
      subscribe: (listener) => client.store.subscribe(listener),
      logout: () => client.logout(),
      login: (methodId, extra) => client.login(methodId, extra),
      respond: (actionId, answer) => client.respond(actionId, answer),
      account: async () => {
        if (client.state.connection !== "ready" || !hasAccount(client.state.agent)) return null
        const account = await client.readAccount()
        let rateLimits: RateLimitSnapshot | null = null
        let stale = false
        let failed = false
        try {
          const fresh = await client.readRateLimits()
          if (hasRateLimitWindows(fresh)) {
            rememberLimits(fresh)
            rateLimits = fresh
          } else {
            // A successful-but-empty answer is still not fresh data (token being replaced). Keep
            // the last real numbers, label them with their capture time, and keep retrying.
            rateLimits = rateLimitCache.current?.snapshot ?? null
            stale = rateLimits !== null
            failed = rateLimits === null
          }
        } catch {
          // chatgpt.com is unreachable (no VPN, endpoint down). The last good snapshot beats a
          // blank panel; `rateLimitsStale` tells the UI to say how old it is, and `rateLimitsError`
          // lets it distinguish "read failed" from "this plan really has no windows".
          rateLimits = rateLimitCache.current?.snapshot ?? null
          stale = rateLimits !== null
          failed = rateLimits === null
        }
        return {
          account,
          rateLimits,
          rateLimitsCapturedAt: rateLimitCache.current?.capturedAt ?? null,
          rateLimitsStale: stale,
          rateLimitsError: failed
        }
      },
      onRateLimits: (listener) =>
        client.onRateLimits((limits) => {
          // Never push an empty snapshot into the settings window: it would replace good numbers
          // with "暂无用量数据" mid-session for no reason.
          if (!hasRateLimitWindows(limits)) return
          rememberLimits(limits)
          listener(limits)
        }),
      // Every live session carries the same integrated model group in its picker; the settings
      // window has no agent connection of its own and asks for it here. With no session open
      // (fresh install, all chats closed) the picker falls back to the bundled catalog.
      nativeModels: () => {
        const session = Object.values(client.state.sessions).find((entry) => entry.configOptions.length > 0)
        if (session !== undefined) {
          const group = nativeGroupModels(session.configOptions)
          // A live session's own picker is the only catalog that may be read as authoritative: it
          // is what the engine actually offers this machine right now. `null` (this session has no
          // integrated group) is a real answer, so it stays null rather than being padded.
          return group === null ? null : { ...group, sourceKind: "session" as const }
        }
        return bundledNativeModels.current
      }
    })
    // No live session yet (fresh install, all chats closed): the picker's integrated group
    // comes straight from the bundled Codex catalog instead of waiting for a first session.
    void invoke<
      Array<{
        slug: string
        name: string
        efforts: string[]
        defaultEffort: string | null
      }>
    >("codex_bundled_models")
      .then(
        (
          entries: Array<{
            slug: string
            name: string
            efforts: string[]
            defaultEffort: string | null
          }>
        ) => {
          if (!Array.isArray(entries) || entries.length === 0) return
          bundledNativeModels.current = {
            id: NATIVE_MODEL_GROUP.id,
            name: NATIVE_MODEL_GROUP.name,
            // Partial by construction: the bundled catalog ships with the app, so it lags the
            // engine and must never be diffed against the user's saved rows.
            sourceKind: "bundled",
            models: entries.map((entry) => ({
              id: entry.slug,
              label: entry.name,
              efforts: entry.efforts,
              defaultEffort: entry.defaultEffort
            }))
          }
          stopBridge.republish()
        }
      )
      .catch(() => {
        // The engine catalog is best-effort; the picker stays provider-only without it.
      })
    return () => stopBridge.stop()
  }, [])

  // 定时任务：主窗口常驻调度器 + 设置窗口「立即运行」共用一个执行器。
  // 只要 App 开着（主窗口在），到点就新建会话发提示词，完全不依赖设置窗口是否打开；
  // 运行记录也由主窗口写进共享 KV，设置窗口通过 store-changed 自动刷新。
  // 用 newSession 的对象形式（而非默认 draft slot）是为了不抢占当前打开的对话。
  useEffect(() => {
    const run: OnRunTask = async (request) => {
      try {
        const cwd = request.cwd.trim() !== "" ? request.cwd : await commands.quickChatDirectory()
        // One task = one monitor conversation, named after the task. Every run appends to that
        // same thread, so the sidebar keeps a single 「监控」row instead of growing a chat a day.
        // After an app restart the thread is no longer attached: re-open it with the options form
        // of `open`, which only attaches/replays and does not steal the user's active chat slot.
        let sessionId: string = request.monitorSessionId ?? ""
        let created = false
        if (sessionId !== "" && !client.holds(sessionId)) {
          try {
            await client.open(sessionId, cwd, {})
          } catch {
            // A deleted or unreadable rollout must not block the schedule: start a fresh monitor.
            sessionId = ""
          }
        }
        if (sessionId === "" || !client.holds(sessionId)) {
          sessionId = await client.newSession(cwd, {
            draft: false,
            meta: { codex: { mode: request.fullAccess ? "agent-full-access" : "workspace-write" } }
          })
          created = true
        }
        // A task may pin its own model. setConfig("model") also re-applies that model's effort
        // ladder (client.landModelSwitch), so a scheduled run never inherits the previous default
        // model's effort. Leaving it empty keeps the session default untouched.
        if (request.model.trim() !== "") {
          await client.setConfig(sessionId, "model", request.model.trim())
        }
        // Explicit overrides come *after* the model switch: landModelSwitch re-applies that
        // model's default effort/fast-mode, so writing them first would be silently overwritten.
        // The client clamps both against what the new model actually publishes — a task that saved
        // "max" and was later re-pointed at a model with three levels must still run.
        if (request.effort.trim() !== "" || request.fastMode) {
          await client.applyRunOverrides(sessionId, request.effort.trim(), request.fastMode)
        }
        // Mark the origin by id, not by title: a task's first prompt has no `#` heading, which is
        // the only signal the old `codex exec` runs gave the sidebar to divert them out of 项目.
        if (created) {
          // Name the monitor after the task. The engine persists the rename, so the sidebar row
          // stays recognisable across restarts. A failed rename must not cost the run itself.
          try {
            await client.renameSession(sessionId, request.taskName)
          } catch {
            // The thread still works with its default title.
          }
          setTaskMonitorSession(request.taskId, sessionId)
        }
        rememberAutomationSessionId(sessionId)
        // A task without full access can hit a permission prompt the engine parks in
        // `requires_action`. Nobody is at the keyboard to approve it, so it would otherwise
        // sit in "运行中" forever. Poll the session state while the turn runs; the moment it
        // parks, flag the run record and raise a desktop notification so the user knows to
        // step in. The flag is advisory only — the turn still resolves on its own (or times
        // out) and the record is finalized normally below.
        let needsAuthSeen = false
        const authProbe = window.setInterval(() => {
          const state = client.session(sessionId)?.state
          if (state === "requires_action" && !needsAuthSeen) {
            needsAuthSeen = true
            patchRunRecord(request.runId, { needsAuth: true })
            void notify(
              t("automation.runNeedsAuthTitle"),
              t("automation.runNeedsAuth", { name: request.taskName })
            )
          }
        }, 2000)
        try {
          const before = client.state.sessions[sessionId]?.items.length ?? 0
          // Same thread, many runs: label each run with its timestamp in the visible timeline so
          // the monitor reads as a dated log. `display` only changes what the reader sees; the
          // agent still receives the untouched prompt.
          const started = new Date()
          const pad2 = (value: number): string => String(value).padStart(2, "0")
          const runStamp = `${started.getFullYear()}-${pad2(started.getMonth() + 1)}-${pad2(started.getDate())} ${pad2(started.getHours())}:${pad2(started.getMinutes())}`
          await client.prompt(
            sessionId,
            [{ type: "text", text: request.prompt }],
            { display: [{ type: "text", text: `【${runStamp} 运行】\n${request.prompt}` }] }
          )
          // The ACP stop reason ("end_turn") is meaningless to a reader. Push and record what the
          // agent actually wrote in this turn; an empty string means there was no readable answer.
          const answer = client.answerSince(sessionId, before)
          return {
            runId: request.runId,
            taskId: request.taskId,
            status: "success",
            summary: answer,
            sessionId,
            error: null,
            finishedAt: Date.now()
          }
        } finally {
          window.clearInterval(authProbe)
        }
      } catch (error) {
        return {
          runId: request.runId,
          taskId: request.taskId,
          status: "failed",
          summary: "",
          sessionId: null,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: Date.now()
        }
      }
    }
    // 定时器和「立即运行」共用一条队列：引擎是单进程，并行发起只会让两个任务互相等。
    // Completion cues are handled once in the runStates effect above, for every conversation;
    // playing a chime here too would make a scheduled task sound twice.
    // A queued run may wait up to 15 minutes behind another turn. Re-read the task at dequeue
    // time so deleting, disabling or editing it while queued cancels that run. Requests without
    // taskFiredAt come from the user's "run now" button and are exempt.
    const taskStillRunnable = (request: { taskId: string; taskFiredAt?: number }): boolean => {
      if (request.taskFiredAt === undefined) return true
      const task = getTask(request.taskId)
      return task !== undefined && task.enabled && task.updatedAt <= request.taskFiredAt
    }
    const execute = serialAutomationExecutor(async (request) => {
      const result = await executeAutomationRun(run, request)
      // Notifications are best effort: a Lark outage must never turn a successful task into a
      // failed one, and the run record is already written by the time we get here.
      if (request.larkNotify && request.larkTargets.length > 0) {
        const now = new Date()
        const pad = (value: number): string => String(value).padStart(2, "0")
        const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
        const body =
          result.status === "success"
            ? result.summary.trim() !== ""
              ? result.summary.trim()
              : t("automation.larkEmptyResult")
            : (result.error ?? t("automation.toastRunFailed"))
        const header =
          result.status === "success" ? stamp : `${stamp} · ${t("automation.runStatusFailed")}`
        // The message IS the result — no task/session ids, no "状态：完成" shell around an empty
        // body. Only a failed run gets an explicit failure marker.
        const text = [`【${request.taskName}】`, header, "", body].join("\n").slice(0, 4000)
        void commands
          .larkCliSend({ targets: request.larkTargets, text, identity: request.larkIdentity })
          .then((failures) => {
            if (failures.length > 0) toast.error(`飞书推送部分失败：${failures.join("；")}`)
          })
          .catch((cause: unknown) => toast.error(describeError(cause)))
      }
      return result
    }, taskStillRunnable)
    const bridge = serveAutomationBridge(execute)
    // 引擎未就绪时跳过这一轮，不消耗排期、不写失败记录；连上后下一轮自然会跑。
    const stopScheduler = startAutomationScheduler(execute, () => client.state.connection === "ready")
    return () => {
      bridge.stop()
      stopScheduler()
    }
  }, [])

  // A Dock badge left over from the previous session has no meaning after a relaunch.
  useEffect(() => clearDockBadge(), [])
  // 外观材质（Liquid Glass / Aero / 纯色）：启动就把存下来的模式落到 DOM 与窗口上。
  useEffect(() => {
    startAppearanceMode()
    startAppearanceSync()
  }, [])
  // App 开着就检查 OpenRouter 有没有新上架的 :free 模型（开关默认关，设置页可开）。
  useEffect(() => startFreeModelWatch(), [])
  // 用量页价格自动刷新：启动时到期就跑，之后每 6 小时一次；失败静默，不打断当前操作。
  useEffect(() => startPriceRefresh(), [])

  useEffect(() => {
    let cancelled = false
    // Retry on a *time* budget, not a round count. Six rounds is ~8 s of backoff, and the other
    // Mac's cold start needed 8 s to reach `provider: completed` — the budget ran out a few hundred
    // milliseconds before the engine was usable, so the banner showed a failure that was already
    // healing. A successful `connect()` closes the silent window itself, which stops this loop;
    // the 20 s fallback still lets a real failure through.
    const deadline = Date.now() + STARTUP_RECOVERY_MS
    const attempt = async (round: number): Promise<void> => {
      await connect()
      if (cancelled || !startupSilent() || Date.now() >= deadline) return
      window.setTimeout(() => {
        if (!cancelled) void attempt(round + 1)
      }, Math.min(400 * 2 ** Math.min(round, 2), 2000))
    }
    void attempt(0)
    const stopNotifications = watchForNotifications(client)
    // alwith-runtime gone: the port is reset, the client drops to "disconnected", and Reconnect
    // asks Rust for a fresh alwith-runtime. 启动期的退出会被 toast 闸门吞掉，只留日志。
    const stopHubExit = onHubExit((exit) => {
      toast.error(
        t("connection.runtimeExited", {
          code: exit.code ?? exit.signal ?? "?"
        })
      )
      client.disconnect()
    })
    return () => {
      cancelled = true
      stopNotifications()
      void stopHubExit.then((stop) => stop())
    }
  }, [connect, t])

  // Native menu items (macOS, Linux) arrive as events; where there is no native menu
  // (Windows) the keyboard handler below covers the same shortcuts.
  useEffect(() => {
    const webview = getCurrentWindow()
    const listeners = Promise.all([
      webview.listen<null>(events["menu:new-chat"].name, () => void newChat()),
      webview.listen<null>(events["menu:open-settings"].name, () => void openSettingsWindow()),
      webview.listen<null>(events["menu:command-palette"].name, () => setPaletteOpen((open) => !open)),
      webview.listen<null>(events["menu:open-hotkeys"].name, () => setHotkeysOpen(true))
    ])
    return () => {
      void listeners.then((stops) => {
        for (const stop of stops) stop()
      })
    }
  }, [newChat])

  useEffect(() => {
    if (!navigator.platform.includes("Win")) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return
      if (event.key === "n") {
        event.preventDefault()
        void newChat()
      } else if (event.key === "k") {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      } else if (event.key === ",") {
        event.preventDefault()
        void openSettingsWindow()
      } else if (event.key === "/") {
        event.preventDefault()
        setHotkeysOpen(true)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [newChat])

  const main = (() => {
    // The engine starts in the background; the home screen is there from the first frame, as
    // in Desktop and the official app. Only a failed or dropped connection says so, inline.
    //
    // 启动静默期（引擎还没第一次 ready）内一律只显示中性文案：这段时间的失败是过程态
    // （冷启动、config 自愈、runtime 重启），红了再消失就是"一启动就报错"。
    // 静默期一结束（ready，或 20 秒兜底过期），真失败照常显示，且带重连按钮。
    const connectionBroken = connection === "failed" || connection === "disconnected"
    const showConnectionError = connectionBroken && !silent
    const showConnecting = stalled && connection !== "ready"
    const connectionNotice = showConnectionError ? (
      <div className="mx-auto w-full max-w-3xl px-6 pt-12">
        <Alert variant="destructive">
          <AlertTitle>{connection === "failed" ? t("connection.failed") : t("connection.disconnected")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {connectionError !== null && (
              <span className="font-mono" title={describeError(connectionError)}>
                {describeError(connectionError)}
              </span>
            )}
            {/* The ACP layer only ever says "agent codex exited". The real reason (bad engine
                override, blocked binary, broken config) is written to the boot log by the
                adapter, so point at it instead of leaving a dead end. */}
            {connectionError !== null && /agent .*exited|Codex process has exited/i.test(connectionError) && (
              <p className="w-full text-xs text-muted-foreground">{t("connection.engineExitedHint")}</p>
            )}
            <Button size="sm" variant="outline" onClick={() => void connect()}>
              {t("connection.reconnect")}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    ) : showConnecting ? (
      <div className="mx-auto w-full max-w-3xl px-6 pt-12">
        <Alert variant="default">
          <AlertTitle>{t("connection.connecting")}</AlertTitle>
          <AlertDescription>{t("connection.connectingHint")}</AlertDescription>
        </Alert>
      </div>
    ) : null
    if (view === "story")
      return (
        <Suspense fallback={null}>
          <StoryPage />
        </Suspense>
      )
    // Keyed: the thread and the composer keep per-session state (draft, scroll memory) and start fresh per session.
    const moveToWindow = (): void => {
      void operation
        .run(async () => {
          await openChatWindow({
            sessionId: selectedId,
            cwd: session?.cwd ?? lastDirectory,
            draft: await exportDraft(selectedId ?? DRAFT_SESSION_ID)
          })
          const replacement = recentMainActivity(client.state, selectedId)
          setSelectedId(replacement?.sessionId ?? null)
          importDraft(DRAFT_SESSION_ID, null)
          setSurfaceGeneration((value) => value + 1)
          // The handoff is accepted before replacing the source, even when restoring history fails.
          if (replacement) {
            setLastDirectory(replacement.cwd)
            await client.open(replacement.sessionId, replacement.cwd)
          }
        }, { handoff: true })
        .catch((error) => toast.error(describeError(error)))
    }
    const newProjectChat = newChat

    const deleted = (sessionId: string): void => {
      setSelectedId((current) => (current === sessionId ? null : current))
      // A temporary chat owns its folder, so deleting the conversation takes it along. Only the
      // conversation on screen is known here: a background one was released before this callback
      // and its cwd is gone. Say so instead of deleting a guessed path — and tell the reader how to
      // get the folder cleaned up, which is to open that conversation and delete it from there.
      if (session !== null && session.id === sessionId) {
        if (isTemporaryChatDir(session.cwd) && session.cwd !== null) {
          const path = session.cwd
          void commands.deleteChatDirectory({ path }).catch(() => {})
        }
      } else if (draftSessions[sessionId] === undefined) {
        toast.info(t("chat.folderLeftBehind"), { id: "chat-folder-left", duration: 8000 })
      }
    }
    // A picked conversation whose preparation is still running gets its own surface. Rendering the
    // draft composer here would let the reader type into a draft that `transferDraft`/`importDraft`
    // is about to replace, and a slow resume would look like the click never landed. Matching the
    // id also clears this state for every other path that changes the selection (new chat, clear
    // context, a handoff back from the chat window).
    if (openingSessionId !== null && openingSessionId === selectedId && session === null)
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <span className="size-5 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground" />
          <span>{t("chat.openingSession")}</span>
        </div>
      )
    if (session !== null && !draftSessions[session.id] && submittingDraftId !== session.id)
      return (
        <ChatView
          key={`${session.id}-${surfaceGeneration}`}
          session={session}
          voiceResume={voiceHandoff.resume}
          projectMenu={
            <ChatProjectMenu
              cwd={session.cwd}
              currentSessionId={session.id}
              onSelect={select}
              onNewChat={newProjectChat}
            />
          }
          onSelectSession={select}
          onOpenWindow={moveToWindow}
          onNewChat={newProjectChat}
          onClearContext={(cwd) => clearContextInPlace(session.id, cwd)}
          onDeleted={deleted}
        />
      )
    return (
      <>
        {connectionNotice}
        <DraftChat
          collectionId={draftCollection?.generation === surfaceGeneration ? draftCollection.id : undefined}
          owner="main"
          key={`draft-${surfaceGeneration}`}
          onNewChat={newProjectChat}
          startSurface={initialPreferences.defaultStartSurface}
          cwd={lastDirectory}
          projectMenu={
            <ChatProjectMenu
              cwd={lastDirectory}
              currentSessionId={selectedId}
              onSelect={select}
              onNewChat={newProjectChat}
            />
          }
          onCwdChange={chooseDraftFolder}
          onOpenProject={openRecentProject}
          onCreated={draftCreated}
          onSendingChange={(id, sending) =>
            setSubmittingDraftId((current) => (sending ? id : current === id ? null : current))
          }
          onVoiceHandoff={voiceHandoff.accept}
          onAuthRequired={() => void openSettingsWindow("provider")}
          providerSnapshot={providerSnapshot}
          runOperation={operation.run}
          onOpenWindow={moveToWindow}
        />
      </>
    )
  })()

  const actionCards = globalInlineActions.length > 0 && (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 pt-12">
      {globalInlineActions.map((action) => (
        <ActionCard key={action.id} action={action} />
      ))}
    </div>
  )
  const globalFormDialog = globalForms[0] !== undefined && (
    <ElicitationFormDialog action={globalForms[0]} total={globalForms.length} />
  )

  return (
    // `aria-busy` only announces the handoff. The old root `inert` froze the sidebar, the file tree
    // and every retry whenever a window request wedged; overlapping requests are already rejected by
    // the surface-operation lock itself, and a stalled one now releases that lock on a watchdog.
    <div className="h-full" aria-busy={busy}>
      <WallpaperBackground onError={reportExtensionError}>
        <MainSidebarLayout
          chatMode={isTemporaryChat}
          sidebarHidden={leading}
          // A launch always opens on the new-conversation screen with the sidebar out: the rail is
          // something the reader collapses on purpose during a session, never a state the app
          // restores. Reopening into a collapsed rail (or onto a management screen) after a
          // resize/sleep/display change was the last way the window could come back looking empty
          // (2026-11-18). The stored preference still drives the Settings switch below.
          initialPinned
          screen={leading ? "leading" : "main"}
          onScreenChange={(screen) => {
            if (screen === "main") setView("chat")
            else openLeading()
          }}
          sidebar={leading ? null : (
            <SessionSidebar
              screen={leading ? "leading" : "main"}
              leadingPage={leadingPage}
              selectedId={view === "chat" && mainVisible ? selectedId : null}
              onSelect={select}
              onNewChat={newChat}
              onNewProject={newProject}
              onSearch={() => setPaletteOpen(true)}
              onNewProjectChat={newChatInDirectory}
              onViewFiles={openMeetingFiles}
              onOpenSettings={() => void openSettingsWindow()}
              onEditProfile={() => void openSettingsWindow("account")}
              onOpenPlugins={openPlugins}
              onOpenSkills={openSkills}
              onOpenExtensions={openExtensionSettings}
              onOpenAutomation={openAutomation}
              drivePanel={<div ref={setDriveSidebar} className="min-h-0 flex-1 overflow-auto" />}
              onSwitchScreen={() => {
                if (leading) setView("chat")
                else openLeading()
              }}
            />
          )}
          leading={
            <>
              <LeadingNavigation
                // 定时任务 不在这一列（插件 / 扩展 / 归档）里，所以它打开时整列都不高亮。
                activePage={view === "extension" || leadingPage === "automation" ? null : leadingPage}
                onOpenArchives={openArchives}
                onOpenPlugins={openPlugins}
                onOpenExtensions={openExtensions}
                onOpenUsage={openUsage}
                onOpenSkills={openSkills}
              >
                <ExtensionNavigation
                  host={extensions}
                  manifests={extensionState.native?.installations.map((item) => item.manifest) ?? []}
                  activeView={view === "extension" ? extensionView : null}
                  onOpenSurface={openExtension}
                  onError={reportExtensionError}
                />
              </LeadingNavigation>
              <SidebarInset className="main-chat-surface flex min-h-0 flex-col">
                {view === "archives" && (
                  <Suspense fallback={null}>
                    <ArchivedChatsPage />
                  </Suspense>
                )}
                {pluginsVisited && (
                  <div className={leadingPage === "plugins" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                    <Suspense fallback={null}>
                      <PluginsPage cwd={directory} active={view === "plugins"} />
                    </Suspense>
                  </div>
                )}
                {view === "extension" && extensionView !== null ? (
                  <ExtensionPage id={extensionView} onClose={() => setView("chat")} />
                ) : leadingPage === "automation" ? (
                  <div className="min-h-0 flex-1 overflow-auto">
                    <Suspense fallback={null}>
                      <AutomationPage />
                    </Suspense>
                  </div>
                ) : leadingPage === "extensions" ? (
                  <div className="min-h-0 flex-1 overflow-auto">
                    <div className="w-full min-w-0 px-8 py-8">
                      <Suspense fallback={null}>
                        <ExtensionsSection onOpenSurface={openExtension} />
                      </Suspense>
                    </div>
                  </div>
                ) : leadingPage === "usage" ? (
                  <div className="min-h-0 flex-1 overflow-auto">
                    <Suspense fallback={null}>
                      <UsagePage />
                    </Suspense>
                  </div>
                ) : leadingPage === "skills" ? (
                  <div className="min-h-0 flex-1 overflow-auto">
                    <Suspense fallback={null}>
                      <SkillsPage />
                    </Suspense>
                  </div>
                ) : null}
              </SidebarInset>
            </>
          }
          trailing={<TrailingBoard />}
          toolbar={<div ref={setWorkspaceToolbar} hidden={leading} className="main-workspace-toolbar" />}
          headerTrailing={
            <div ref={setWorkspaceTrailing} hidden={leading} className="main-workspace-toolbar" />
          }
          leadingActions={
            <TitleBarLeadingActions
              onOpenWindow={() => void openChatWindow().catch((error) => toast.error(describeError(error)))}
            />
          }
          statusBar={
            <>
              <div className="main-extension-status pointer-events-none flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
                <div className="min-w-0 flex-1">
                  <ExtensionStatusBar views={extensions.views} renderView={(item) => <ExtensionMount id={item.id} />} />
                </div>
                <div className="flex h-8 shrink-0 items-center">
                  <DriveStatus />
                </div>
              </div>
              <div className="flex size-8 shrink-0 items-center justify-center">
                <ClientVersionPopover />
              </div>
            </>
          }
          main={
            <SidebarInset className="main-chat-surface main-workspace-surface flex min-h-0 flex-col">
              {!leading && actionCards}
              <WorkspaceHeaderContext.Provider value={workspaceTrailing ?? workspaceToolbar}>
                <FileWorkspace
                  cwd={directory}
                  sessionId={session?.id ?? null}
                  chatRevealRequest={chatRevealRequest}
                  columnsRequest={columnsRequest}
                  busy={session != null && session.state !== "idle"}
                  reason={directoryReason}
                  guidance={directoryGuidance}
                  invalidDirectory={invalidDirectory}
                  directoryKey={directoryKey}
                  // Projects and a conversation's own quick-chat folder open with the preview when
                  // four columns is on; a brand-new task keeps the workspace and tree shut.
                  // `readOnly` never suppresses the columns: a recovery session is still a project.
                  defaultOpen={defaultFourColumns}
                  draft={selectedId === null || draftSessions[selectedId] !== undefined}
                  chat={isTemporaryChat}
                >
                  <DriveDeleteConfirmation />
                  <div className="flex min-h-0 flex-1 flex-col">{main}</div>
                  {driveSidebar &&
                    createPortal(
                      <DrivePage
                        currentSessionId={selectedId}
                        onSelectSession={select}
                        currentProject={directory}
                        onOpenProject={(root) =>
                          operation.run(async () => {
                            await client.discardDraft("main")
                            flushSync(() => {
                              chooseDraftFolder(root.localPath)
                              importDraft(DRAFT_SESSION_ID, null)
                              setSurfaceGeneration((value) => value + 1)
                              setSelectedId(null)
                              setView("chat")
                            })
                          }, { handoff: true })
                        }
                      />,
                      driveSidebar
                    )}
                </FileWorkspace>
              </WorkspaceHeaderContext.Provider>
            </SidebarInset>
          }
        >
          <HotkeysDialog open={hotkeysOpen} onOpenChange={setHotkeysOpen} />
          {globalFormDialog}
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            onNewChat={newChat}
            onOpenSettings={() => void openSettingsWindow()}
            onOpenPlugins={openPlugins}
            onOpenHotkeys={() => setHotkeysOpen(true)}
            onOpenExtension={openExtension}
            onSelect={select}
          />
        </MainSidebarLayout>
      </WallpaperBackground>
    </div>
  )
}
