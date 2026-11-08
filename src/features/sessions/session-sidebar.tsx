/**
 * SessionSidebar — U's sidebar: header navigation and the account footer. The chat list itself is
 * `@alwith/module-chat`'s SessionList, whose rows carry U's collection and drive actions in their
 * hover cards. 收藏 / 活动 (and 资料库 when Drive is on) live in the window title bar, so the panel
 * is always the conversation list unless one of those is open.
 */

import {
  HoverInfoAction,
  NavigationStack,
  SessionList,
  type SessionListExpansion,
  SessionRow
} from "@alwith/module-chat/session-list"
import { ScrollArea } from "@base-ui/react/scroll-area"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BlocksIcon,
  BoxesIcon,
  CalendarClockIcon,
  ChartColumnIcon,
  ChevronRightIcon,
  CirclePlusIcon,
  CloudIcon,
  FolderMinusIcon,
  PuzzleIcon,
  UsersIcon,
  SearchIcon,
  SparklesIcon
} from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import { ONLINE_BI_VIEW_ID } from "@/features/workspace/online-bi"
import type { SessionSummary } from "@/agent/client"
import { Pane } from "@/components/alwith-ui/pane"
import { ShortcutHint } from "@/components/alwith-ui/shortcut-hint"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ProjectSessionPopover } from "@/features/chat/project-session-popover"
import { AddToCollectionAction } from "@/features/collection/collection-menu"
import { CollectionPanel } from "@/features/collection/collection-panel"
import { dispatchCollection, reportCollection } from "@/features/collection/store"
import { DriveArchiveAction } from "@/features/drive/archive-action"
import { useDriveVisible } from "@/features/drive/use-drive-visible"
import { usePreviewExtension } from "@/features/workspace/preview-extension"
import { GuideButton } from "@/features/guide/guide-button"
import type { MainScreen } from "@/features/layout/components/main-sidebar-layout"
import { UpdateStatusButton } from "@/features/updater/components/update-status-button"
import { isQuickChatDirectory, QUICK_CHATS_GROUP } from "@alwith/module-chat/session-list"

import { useApp } from "@/lib/client"
import { automationSessionRows, automationTitleOf, subscribeAutomationSessionRows } from "@/lib/automation-sessions"
import { cn } from "@/lib/utils"

import { ActivityPanel } from "./activity-panel"
import { GroupPanel } from "@/features/groups/group-panel"
import { SessionListHostProvider } from "./session-list-host"
import { SidebarAccountMenu } from "./sidebar-account-menu"
import { SidebarMenuRow } from "./sidebar-menu-row"
import { useActivityNotification } from "./use-activity-notification"
import { useSessionsUiStore } from "./store"

/** U's own hover-card actions on a session row: collections, then drive. */
function SessionRowActions({ sessionRow, collectionId }: { sessionRow: SessionSummary; collectionId?: string }) {
  const { t } = useTranslation()
  return (
    <>
      <AddToCollectionAction sessionId={sessionRow.sessionId} allowRemove={collectionId === undefined} />
      {collectionId !== undefined && (
        <HoverInfoAction
          icon={<FolderMinusIcon />}
          label={t("collection.removeFromGroup")}
          onClick={() =>
            reportCollection(dispatchCollection({ type: "remove", collectionId, sessionId: sessionRow.sessionId }))
          }
        />
      )}
      <DriveArchiveAction sessionId={sessionRow.sessionId} />
    </>
  )
}

/** How many scheduled runs the sidebar shows before 显示更多. */
const AUTOMATION_ROWS = 5

/**
 * Scheduled task runs, kept as their own top-level section next to 聊天 and 项目.
 * Every run is a real conversation, but they share one title and one project, so a job that fires
 * three times a day turns a project group into a wall of identical rows. They therefore never
 * enter `state.sessionList`: the client diverts them here (by the id the scheduler recorded, or by
 * the `#` heading older `codex exec` runs carried). The section opens to its five newest runs and
 * keeps the rest behind 显示更多.
 */
function AutomationRuns({
  rows,
  selectedId,
  renderRow
}: {
  rows: SessionSummary[]
  selectedId: string | null
  renderRow: (sessionRow: SessionSummary, onHoverCardOpenChange: (open: boolean) => void) => ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const [limit, setLimit] = useState(AUTOMATION_ROWS)
  useEffect(() => {
    // Opening one of these from the palette or another window has to reveal the section it lives in.
    if (rows.some((row) => row.sessionId === selectedId)) setOpen(true)
  }, [rows, selectedId])
  if (rows.length === 0) return null
  return (
    <div className="mt-1" data-automation-runs="">
      <button
        type="button"
        title={t("sidebar.automationHint")}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 rounded-md px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate text-start">
          {`${t("sidebar.automationRuns")} (${rows.length})`}
        </span>
      </button>
      {open && (
        <div>
          {rows
            .slice(0, limit)
            .map((row) => renderRow({ ...row, title: automationTitleOf(row.title) ?? row.title }, () => {}))}
          {rows.length > limit && (
            <button
              type="button"
              onClick={() => setLimit(rows.length)}
              className="w-full rounded-md px-2 py-1 text-start text-xs text-muted-foreground hover:bg-foreground/5"
            >
              {t("sidebar.automationShowAll", { count: rows.length - limit })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

type SessionSidebarProps = {
  screen: MainScreen
  leadingPage: "plugins" | "extensions" | "archives" | "automation"
  selectedId: string | null
  onSelect: (sessionRow: SessionSummary) => void
  onNewChat: () => void
  /** Creates a project: the user picks a directory first. The header carries the button. */
  onNewProject?: () => void
  onNewProjectChat: (cwd: string | null, collectionId?: string) => void
  onSearch: () => void
  onOpenSettings: () => void
  /** Opens Settings on the profile editor (nickname and avatar). */
  onEditProfile?: () => void
  onOpenPlugins: () => void
  /** Opens Settings on the Skills page. */
  onOpenSkills?: () => void
  /** Opens the BI Metrics company app: its installed surface, or 应用扩展 when absent. */
  extensionNavigation?: ReactNode
  drivePanel?: ReactNode
  onOpenExtensions: () => void
  /** 定时任务 renders as a page inside the main window, not the settings window. */
  onOpenAutomation: () => void
  onSwitchScreen: () => void
}

export function SessionSidebar(props: SessionSidebarProps) {
  return (
    <SessionListHostProvider>
      <SidebarPanels {...props} />
    </SessionListHostProvider>
  )
}

function SidebarPanels({
  screen,
  leadingPage,
  selectedId,
  onSelect,
  onNewChat,
  onNewProjectChat,
  onSearch,
  onOpenSettings,
  onEditProfile,
  onOpenPlugins,
  onOpenSkills,
  onOpenExtensions,
  onOpenAutomation,
  extensionNavigation,
  drivePanel,
  onSwitchScreen
}: SessionSidebarProps) {
  const { t } = useTranslation()
  // Keep expansion state in the shared in-memory store, as in Desktop; preserve it while the app runs and reset it on restart.
  const revealed = useSessionsUiStore((s) => s.revealed)
  const reveal = useSessionsUiStore((s) => s.reveal)
  const revealMany = useSessionsUiStore((s) => s.revealMany)
  const projectOpen = useSessionsUiStore((s) => s.projectOpen)
  const setProjectOpen = useSessionsUiStore((s) => s.setProjectOpen)
  // Sidebar panel (Desktop's activeNavigationItem): session list or activity.
  const view = useSessionsUiStore((s) => s.view)
  const setView = useSessionsUiStore((s) => s.setView)
  const sessions = useApp((state) => state.sessionList)
  // Scheduled runs are kept out of `sessionList` by the client; their section reads this store.
  const automationRows = useSyncExternalStore(
    subscribeAutomationSessionRows,
    automationSessionRows,
    automationSessionRows
  )
  // 收藏 / 活动 are title-bar buttons now; the panel still clears the badge when it is opened.
  useActivityNotification(view)
  const driveVisible = useDriveVisible()
  const previewExtension = usePreviewExtension((state) => state.id)
  const openPreviewExtension = usePreviewExtension((state) => state.open)
  const closePreviewExtension = usePreviewExtension((state) => state.close)
  const [driveVisited, setDriveVisited] = useState(false)
  useEffect(() => {
    if (!driveVisible && view === "drive") setView("sessions")
    if (!driveVisible) setDriveVisited(false)
    else if (view === "drive") setDriveVisited(true)
  }, [driveVisible, view, setView])
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)

  // Projects are all visible by default; "展开显示" only appears after a collapse.
  const [allProjectsShown, setAllProjectsShown] = useState(true)
  // 会话 previews three rows; a project lists its recent conversations, with the rest behind its
  // own "Show all" (lazy disclosure at the UI level so a project with hundreds of sessions still
  // paints instantly instead of mounting every row at once).
  const QUICK_CHAT_ROWS = 3
  const PROJECT_SESSION_ROWS = 50
  // Default expansion: the 会话 section shows its three most recent rows (the rest behind its
  // own "show more"), while every project starts expanded to its first PROJECT_SESSION_ROWS rows
  // — enough that ordinary projects show everything, and only very large ones need "Show all".
  const expansionInitialized = useRef(false)
  useEffect(() => {
    if (expansionInitialized.current || sessions.length === 0) return
    expansionInitialized.current = true
    // Seed the groups this mount has never seen and leave the rest alone. The store is the
    // authority: a sidebar that remounts (main ⇄ 负一屏) used to flatten every project back to
    // collapsed, throwing away what the reader had just opened.
    const store = useSessionsUiStore.getState()
    const open = new Map(store.projectOpen)
    const entries: Array<[string, number]> = []
    // 会话 shows its three latest rows; projects list every conversation (no "show more" — the
    // folder row is the only collapse). Groups start expanded. Batch the initial expansion into a
    // single store write so the sidebar re-renders once instead of once per project.
    if (!open.has(QUICK_CHATS_GROUP)) open.set(QUICK_CHATS_GROUP, true)
    if (!store.revealed.has(QUICK_CHATS_GROUP)) entries.push([QUICK_CHATS_GROUP, QUICK_CHAT_ROWS])
    for (const row of sessions) {
      if (isQuickChatDirectory(row.cwd ?? "")) continue
      if (!store.revealed.has(row.cwd)) entries.push([row.cwd, PROJECT_SESSION_ROWS])
      // Projects start COLLAPSED: opening every project to PROJECT_SESSION_ROWS rows at once made
      // the first paint mount ~50×N rows and feel slow. Collapsing keeps the initial DOM tiny; the
      // per-group lazy cap (limits/collapse) still applies once a project is expanded.
      if (!open.has(row.cwd)) open.set(row.cwd, false)
    }
    if (entries.length > 0) revealMany(entries)
    setProjectOpen(open)
  }, [revealMany, sessions])

  const groupLimits = new Map<string, number>([[QUICK_CHATS_GROUP, QUICK_CHAT_ROWS]])
  for (const row of sessions) {
    if (!isQuickChatDirectory(row.cwd ?? "")) groupLimits.set(row.cwd, PROJECT_SESSION_ROWS)
  }

  const expansion: SessionListExpansion = {
    open: projectOpen,
    setOpen: (cwd, open) => setProjectOpen(new Map(projectOpen).set(cwd, open)),
    revealed,
    reveal: (cwd) => reveal(cwd, Number.POSITIVE_INFINITY),
    limits: groupLimits,
    // "收起显示" puts a group back to the rows it started with.
    collapse: (cwd) => reveal(cwd, groupLimits.get(cwd) ?? QUICK_CHAT_ROWS),
    allProjects: allProjectsShown,
    showAllProjects: () => setAllProjectsShown(true)
  }

  // The "项目" section label sits above the first project group. Which group that is depends on
  // the list's own ordering, and the list re-renders without this component (StrictMode renders
  // it twice), so "first call wins" state cannot survive. Every project group therefore carries
  // the label and the stylesheet shows only the first one (see index.css).
  const projectCount = new Set(
    sessions.filter((row) => !isQuickChatDirectory(row.cwd ?? "")).map((row) => row.cwd)
  ).size

  const renderRow = (
    sessionRow: SessionSummary,
    onHoverCardOpenChange: (open: boolean) => void,
    collectionId?: string
  ) => (
    <SessionRow
      key={sessionRow.sessionId}
      onHoverCardOpenChange={onHoverCardOpenChange}
      sessionRow={sessionRow}
      active={sessionRow.sessionId === selectedId}
      onSelect={onSelect}
      actions={<SessionRowActions sessionRow={sessionRow} collectionId={collectionId} />}
    />
  )

  return (
    <Sidebar
      collapsible="none"
      // Keep spacing aligned with the panel's pixel gutters when WebKit clamps rem-based fonts at low zoom.
      className="h-full min-h-0 shrink-0 bg-transparent [--navigation-row-height:30px] [--spacing:4px]"
    >
      <SidebarHeader className="shrink-0 gap-1 p-1 px-2" data-tauri-drag-region>
        <div className="flex h-8 items-center gap-0.5 px-1" data-tauri-drag-region>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold" data-tauri-drag-region>
            {t("app.name")}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={t("sidebar.search")} onClick={onSearch}>
                  <SearchIcon />
                </Button>
              }
            />
            <TooltipContent>
              <ShortcutHint label={t("sidebar.search")} shortcut="CmdOrCtrl+K" />
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-col gap-1">
          <SidebarMenuRow
            label={t("sidebar.newTask")}
            icon={CirclePlusIcon}
            onPrimary={onNewChat}
          />
          <SidebarMenuRow
            label={t("sidebar.toolbox")}
            icon={BoxesIcon}
            active={screen === "leading" && (leadingPage === "plugins" || leadingPage === "extensions")}
            onPrimary={onOpenPlugins}
            destinations={[
              {
                id: "plugins",
                label: t("sidebar.plugins"),
                icon: PuzzleIcon,
                onSelect: onOpenPlugins,
                active: screen === "leading" && leadingPage === "plugins"
              },
              {
                id: "extensions",
                label: t("sidebar.extensions"),
                icon: BlocksIcon,
                onSelect: onOpenExtensions,
                active: screen === "leading" && leadingPage === "extensions"
              },
              {
                id: "skills",
                label: t("settings.skills"),
                icon: SparklesIcon,
                onSelect: () => onOpenSkills?.()
              }
            ]}
          />
          {/* 定时任务：主窗口内的一页，像 WorkBuddy 一样就地展开，不再跳设置窗口。 */}
          <SidebarMenuRow
            label={t("settings.automation")}
            icon={CalendarClockIcon}
            active={screen === "leading" && leadingPage === "automation"}
            onPrimary={() => (screen === "leading" && leadingPage === "automation" ? onSwitchScreen() : onOpenAutomation())}
          />
          {driveVisible && (
            <SidebarMenuRow
              label={t("sidebar.driveLibrary")}
              icon={CloudIcon}
              active={view === "drive"}
              onPrimary={() => {
                closePreviewExtension()
                setView(view === "drive" ? "sessions" : "drive")
              }}
            />
          )}
          {/* 在线 BI replaced the BI 指标 extension entry. It opens in the preview column; the
              frame gets its session from the token in 设置 → 在线 BI, because a cross-site frame
              never receives the sign-in cookie. */}
          {/* 群 is its own destination: a discussion has its own project, its own document and
              its own roster, so it gets a panel instead of a folder in the session list. */}
          <SidebarMenuRow
            label={t("sidebar.onlineBi")}
            icon={ChartColumnIcon}
            active={previewExtension === ONLINE_BI_VIEW_ID}
            onPrimary={() => {
              setView("sessions")
              if (previewExtension === ONLINE_BI_VIEW_ID) closePreviewExtension()
              else openPreviewExtension(ONLINE_BI_VIEW_ID)
            }}
          />
          <SidebarMenuRow
            label={t("sidebar.groups")}
            icon={UsersIcon}
            active={view === "groups"}
            onPrimary={() => setView(view === "groups" ? "sessions" : "groups")}
          />
        </div>
        {extensionNavigation}
      </SidebarHeader>
      <SidebarContent className="session-list-content gap-0 overflow-hidden px-0 py-1">
        {driveVisible && (driveVisited || view === "drive") && (
          <div
            hidden={view !== "drive"}
            className={cn("mx-2 min-h-0 flex-1 flex-col", view === "drive" ? "flex" : "hidden")}
          >
            {drivePanel}
          </div>
        )}
        <div
          className="contents select-none"
          // Session rows are chrome, not document text: suppress WebKit's native
          // "Look Up / Translate / Copy / Services" menu on right click. Inputs keep their menu.
          onContextMenu={(event) => {
            const target = event.target as HTMLElement | null
            if (!target?.closest("input, textarea, [contenteditable='true']")) event.preventDefault()
          }}
        >
        {view === "drive" ? null : view === "groups" ? (
          <GroupPanel onSelect={onSelect} onNewChat={(cwd) => onNewProjectChat(cwd)} />
        ) : view === "collections" ? (
          <CollectionPanel renderRow={renderRow} onSelect={onSelect} onNewChat={(id) => onNewProjectChat(null, id)} />
        ) : view === "activity" ? (
          <ActivityPanel selectedId={selectedId} onSelect={onSelect} />
        ) : (
          <Pane className="session-list-scroll" viewportRef={setViewport} viewportClassName="ps-2 pe-0 pb-1">
            {/* Observe content height as groups expand, collapse or reveal more rows. */}
            <ScrollArea.Content render={<NavigationStack />} style={{ minWidth: 0 }}>
              <SessionList
                selectedId={selectedId}
                onSelect={onSelect}
                viewport={viewport}
                expansion={expansion}
                wrapGroupHeader={(cwd, header) => {
                  // Quick chats already carry their own "会话" heading; the first project group
                  // gets a matching "项目" section label so the sidebar reads as two sections.
                  // A group's conversations are not projects and never reach this list (the client
                  // diverts them to the 群聊 panel), so every folder here is a real project.
                  const label =
                    cwd !== null ? (
                      <div
                        data-project-label=""
                        className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground"
                      >
                        {`${t("sidebar.projects")} (${projectCount})`}
                      </div>
                    ) : null
                  return (
                    <>
                      {label}
                      <ProjectSessionPopover
                        cwd={cwd}
                        trigger={header}
                        onSelect={onSelect}
                        onNewChat={() => onNewProjectChat(cwd)}
                      />
                    </>
                  )
                }}
                rowActions={(sessionRow) => <SessionRowActions sessionRow={sessionRow} />}
              />
              <AutomationRuns rows={automationRows} selectedId={selectedId} renderRow={renderRow} />
            </ScrollArea.Content>
          </Pane>
        )}
        </div>
      </SidebarContent>
      <SidebarFooter className="shrink-0 gap-1 p-1 px-2">
        <UpdateStatusButton />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            className={cn(
              "h-8 min-w-0 flex-1 rounded-[10px] px-2 [corner-shape:superellipse(1.5)] hover:bg-foreground/5",
              screen === "main" ? "justify-start" : "justify-end"
            )}
            aria-label={t(screen === "main" ? "sidebar.openLeading" : "sidebar.backToMain")}
            title={t(screen === "main" ? "sidebar.openLeading" : "sidebar.backToMain")}
            onClick={onSwitchScreen}
          >
            {screen === "main" ? <ArrowLeftIcon /> : <ArrowRightIcon />}
          </Button>
        </div>
        {/* Hairline between the navigation rows above and the account block: identity is not
            another destination in the list. */}
        <Separator className="mx-1 my-1" />
        <div className="flex h-8 items-center gap-1">
          <div className="min-w-0 flex-1">
            <SidebarAccountMenu onOpenSettings={onOpenSettings} onEditProfile={onEditProfile} />
          </div>
          <GuideButton />
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
