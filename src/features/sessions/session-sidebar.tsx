/**
 * SessionSidebar — U's sidebar: header navigation and the account footer. The chat list itself is
 * `@alwith/module-chat`'s SessionList, whose rows carry U's collection and drive actions in their
 * hover cards. 收藏 / 活动 (and 资料库 when Drive is on) live in the window title bar, so the panel
 * is always the conversation list unless one of those is open.
 */

import {
  HoverInfoAction,
  isQuickChatDirectory,
  NavigationStack,
  QUICK_CHATS_GROUP,
  SessionList,
  type SessionListExpansion,
  SessionRow
} from "@alwith/module-chat/session-list"
import { ScrollArea } from "@base-ui/react/scroll-area"
import {
  BlocksIcon,
  BoxesIcon,
  CalendarClockIcon,
  ChartColumnIcon,
  ChevronRightIcon,
  CirclePlusIcon,
  CloudIcon,
  FolderIcon,
  FolderMinusIcon,
  type LucideIcon,
  MessagesSquareIcon,
  PuzzleIcon,
  SearchIcon,
  SettingsIcon,
  SmartphoneIcon,
  SparklesIcon,
  UsersIcon
} from "lucide-react"
import type { ReactNode } from "react"
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"

import type { SessionSummary } from "@/agent/client"
import { Pane } from "@/components/alwith-ui/pane"
import { ShortcutHint } from "@/components/alwith-ui/shortcut-hint"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Separator } from "@/components/ui/separator"
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ProjectSessionPopover } from "@/features/chat/project-session-popover"
import { AddToCollectionAction } from "@/features/collection/collection-menu"
import { CollectionPanel } from "@/features/collection/collection-panel"
import { dispatchCollection, reportCollection } from "@/features/collection/store"
import { DriveArchiveAction } from "@/features/drive/archive-action"
import { useDriveVisible } from "@/features/drive/use-drive-visible"
import { useDriveEnabledPreference } from "@/lib/drive-visible-preference"
import { GroupPanel } from "@/features/groups/group-panel"
import { GuideButton } from "@/features/guide/guide-button"
import {
  type MainScreen,
  SidebarRailContext,
  SidebarToggleContext
} from "@/features/layout/components/main-sidebar-layout"
import { useDisplayProfile } from "@/features/profile/use-display-profile"
import { UpdateStatusButton } from "@/features/updater/components/update-status-button"
import { ONLINE_BI_VIEW_ID } from "@/features/workspace/online-bi"
import { usePreviewExtension } from "@/features/workspace/preview-extension"
import { automationSessionRows, automationTitleOf, subscribeAutomationSessionRows } from "@/lib/automation-sessions"
import { useApp } from "@/lib/client"
import { isGroupDirectory } from "@/lib/groups"
import { cn } from "@/lib/utils"
import { openSettingsWindow, toggleSettingsWindow } from "@/lib/window-manager"

import { ActivityPanel } from "./activity-panel"
import { SessionListHostProvider } from "./session-list-host"
import { SidebarAccountMenu } from "./sidebar-account-menu"
import { SidebarMenuRow } from "./sidebar-menu-row"
import { useSessionsUiStore } from "./store"
import { useActivityNotification } from "./use-activity-notification"

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
        <span className="min-w-0 flex-1 truncate text-start">{`${t("sidebar.automationRuns")} (${rows.length})`}</span>
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

/** One icon button in the collapsed-sidebar rail: the header menu rows, reduced to icons. */
type RailDestination = {
  id: string
  label: string
  icon: LucideIcon
  onSelect: () => void
  active?: boolean
}

type SidebarRailItem = {
  id: string
  label: string
  icon: LucideIcon
  active?: boolean
  muted?: boolean
  hint?: string
  onSelect: () => void
  /** Sub-entries surfaced in a hover card instead of a plain tooltip; the icon itself still
   *  performs its own (default) action on click. */
  destinations?: RailDestination[]
}

/** The rail's account entry: the user's avatar, clicking straight into 设置 → 账户. */
function RailAvatarButton({ onSelect }: { onSelect: () => void }) {
  const { t } = useTranslation()
  const profile = useDisplayProfile()
  // Avatar.Root context is required even when signed out: the fallback lives inside it.
  const avatar = (
    <Avatar className="size-6 after:border-0">
      {profile?.avatarUrl && <AvatarImage src={profile.avatarUrl} alt="" />}
      <AvatarFallback className="bg-primary text-xs text-primary-foreground">{profile?.initials ?? "?"}</AvatarFallback>
    </Avatar>
  )
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={profile?.displayName ?? "account"}
            onClick={onSelect}
            className="size-9 justify-center rounded-[10px] p-0 text-muted-foreground hover:text-foreground [&_svg]:size-5"
          />
        }
      >
        {avatar}
      </TooltipTrigger>
      <TooltipContent side="inline-end">{profile?.displayName ?? t("sidebar.settings.account")}</TooltipContent>
    </Tooltip>
  )
}

function SidebarRailButton({ label, icon: Icon, active, muted, hint, onSelect, destinations }: SidebarRailItem) {
  const trigger = (
    <Button
      variant="ghost"
      size="icon"
      aria-label={hint ?? label}
      aria-current={active ? "page" : undefined}
      aria-disabled={muted || undefined}
      onClick={() => onSelect()}
      className={cn(
        "size-9 rounded-[10px] text-muted-foreground hover:text-foreground aria-[current=page]:bg-foreground/5 aria-[current=page]:text-foreground",
        muted && "opacity-55"
      )}
    >
      <Icon aria-hidden="true" className="size-[18px]" />
    </Button>
  )
  // Multi-destination entries (工具箱) trade the plain tooltip for a hover card listing the
  // sub-entries; the icon click keeps its own default destination.
  if (destinations !== undefined && destinations.length > 0) {
    return (
      <HoverCard>
        {/* A near-instant 120ms dwell: the card must feel attached to the pointer, and the
            close delay keeps it alive across the seam onto the menu itself. */}
        <HoverCardTrigger render={trigger} delay={120} closeDelay={150} />
        <HoverCardContent side="inline-end" sideOffset={10} className="w-auto min-w-36 p-1.5">
          <div className="flex flex-col gap-0.5">
            {destinations.map((destination) => {
              const DestinationIcon = destination.icon
              return (
                <button
                  key={destination.id}
                  type="button"
                  onClick={destination.onSelect}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs hover:bg-foreground/5",
                    destination.active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <DestinationIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">{destination.label}</span>
                </button>
              )
            })}
          </div>
        </HoverCardContent>
      </HoverCard>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent side="inline-end">{hint ?? label}</TooltipContent>
    </Tooltip>
  )
}

type SessionSidebarProps = {
  screen: MainScreen
  leadingPage: "plugins" | "extensions" | "archives" | "automation" | "usage" | "skills"
  selectedId: string | null
  onSelect: (sessionRow: SessionSummary) => void
  onNewChat: () => void
  /** Creates a project: the user picks a directory first. The header carries the button. */
  onNewProject?: () => void
  onNewProjectChat: (cwd: string | null, collectionId?: string, groupId?: string | null) => void
  /** 查看会议文件: opens a meeting's folder in the four-column workspace without a new chat. */
  onViewFiles?: (directory: string, groupId: string) => void
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
  onViewFiles,
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
  const listedSessions = useApp((state) => state.sessionList)
  // A meeting belongs to 群聊, never to 项目. The client diverts those rows when the list is built;
  // this filter is the same test applied to rows that were already cached (a restored history, a
  // healed folder, a record still pointing at the Groups root) so an old row cannot resurface here
  // as a project after an update.
  const sessions = useMemo(() => listedSessions.filter((row) => !isGroupDirectory(row.cwd)), [listedSessions])
  // Scheduled runs are kept out of `sessionList` by the client; their section reads this store.
  const automationRows = useSyncExternalStore(
    subscribeAutomationSessionRows,
    automationSessionRows,
    automationSessionRows
  )
  // 收藏 / 活动 are title-bar buttons now; the panel still clears the badge when it is opened.
  useActivityNotification(view)
  const driveVisible = useDriveVisible()
  // Two different reasons the row can be unusable, and they need opposite treatments: the reader
  // switching Drive off means "I do not want this here" → hide it. Missing an account means "this
  // exists but you cannot use it yet" → keep it, dimmed. Collapsing both into one flag left the row
  // sitting in the sidebar after the switch was turned off (2026-11-08).
  const driveEnabled = useDriveEnabledPreference()
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
  // The collapsed sidebar leaves a one-column icon rail on the leading edge (hosted by the
  // layout); the same header actions run from it, so nothing is unreachable while collapsed.
  const railNode = useContext(SidebarRailContext)
  const sidebarToggle = useContext(SidebarToggleContext)
  const expandSidebar = sidebarToggle?.expand
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
  const projectCount = new Set(sessions.filter((row) => !isQuickChatDirectory(row.cwd ?? "")).map((row) => row.cwd))
    .size

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

  // View-based destinations live inside the panel itself. While the panel is collapsed they
  // also bring it back, otherwise the view would switch behind an invisible column.
  const openWithSidebar = (next: "sessions" | "drive" | "groups"): void => {
    // The home surface is strictly four columns: sidebar, chat, preview and files. Any
    // preview-extension child webview must be torn down before returning to sessions; otherwise
    // the native BI child can survive the canvas switch and remain visible on another monitor.
    if (next !== "sessions") closePreviewExtension()
    setView(next)
    if (sidebarToggle?.docked !== true) sidebarToggle?.toggle()
  }

  const railItems: SidebarRailItem[] = [
    { id: "new-task", label: t("sidebar.newTask"), icon: CirclePlusIcon, onSelect: onNewChat },
    {
      id: "toolbox",
      label: t("sidebar.toolbox"),
      icon: BoxesIcon,
      // Skills is the default destination: the icon click lands there directly; the hover
      // card lists 插件 / 扩展 / 技能 for the other two.
      onSelect: onOpenSkills ?? onOpenPlugins,
      destinations: [
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
          onSelect: () => onOpenSkills?.(),
          active: screen === "leading" && leadingPage !== "plugins" && leadingPage !== "extensions"
        }
      ]
    },
    {
      id: "automation",
      label: t("settings.automation"),
      icon: CalendarClockIcon,
      active: screen === "leading" && leadingPage === "automation",
      onSelect: () => (screen === "leading" && leadingPage === "automation" ? onSwitchScreen() : onOpenAutomation())
    },
    ...(driveEnabled
      ? [
          {
            id: "drive",
            label: t("sidebar.driveLibrary"),
            icon: CloudIcon,
            active: view === "drive",
            muted: !driveVisible,
            hint: driveVisible ? undefined : t("sidebar.driveNeedsAccount"),
            onSelect: () => {
              if (!driveVisible) {
                void openSettingsWindow("account")
                return
              }
              closePreviewExtension()
              openWithSidebar(view === "drive" ? "sessions" : "drive")
            }
          }
        ]
      : []),
    {
      id: "online-bi",
      label: t("sidebar.onlineBi"),
      icon: ChartColumnIcon,
      active: previewExtension === ONLINE_BI_VIEW_ID,
      onSelect: () => {
        setView("sessions")
        if (previewExtension === ONLINE_BI_VIEW_ID) closePreviewExtension()
        else openPreviewExtension(ONLINE_BI_VIEW_ID)
      }
    },
    {
      id: "groups",
      label: t("sidebar.groups"),
      icon: UsersIcon,
      active: view === "groups",
      onSelect: () => openWithSidebar(view === "groups" ? "sessions" : "groups")
    },
    // 聊天 and 项目 are sections of the session list, not separate views: the rail entries
    // bring the panel back with the list showing, mirroring the two headings they name.
    {
      id: "chats",
      label: t("sidebar.quickChats"),
      icon: MessagesSquareIcon,
      // Switching back to the home session list must tear down the native preview child first.
      // Otherwise `online-bi-embed` remains a separate top-level window and can be left on the
      // other monitor even though the main canvas is now showing chat.
      onSelect: () => {
        closePreviewExtension()
        expandSidebar?.()
        openWithSidebar("sessions")
      }
    },
    {
      id: "projects",
      label: t("sidebar.projects"),
      icon: FolderIcon,
      onSelect: () => {
        closePreviewExtension()
        expandSidebar?.()
        openWithSidebar("sessions")
      }
    }
  ]

  return (
    <>
      {railNode !== null &&
        createPortal(
          <>
            {/* Rail items pin to the top; the account entry pins to the bottom, mirroring the
                expanded panel's footer (account + settings live at the bottom there too). */}
            <div className="flex w-full flex-col items-center gap-2 pt-2">
              {railItems.map((item) => (
                <SidebarRailButton key={item.id} {...item} />
              ))}
            </div>
            <div className="mt-auto flex w-full flex-col items-center gap-1 pb-1">
              {/* Avatar and gear toggle Settings: a second click hides the window again. */}
              <RailAvatarButton onSelect={() => void toggleSettingsWindow("account")} />
              <SidebarRailButton
                id="rail-settings"
                label={t("sidebar.settings")}
                icon={SettingsIcon}
                onSelect={() => void toggleSettingsWindow("general")}
              />
            </div>
          </>,
          railNode
        )}
      <Sidebar
        collapsible="none"
        // Keep spacing aligned with the panel's pixel gutters when WebKit clamps rem-based fonts at low zoom.
        className="h-full min-h-0 shrink-0 bg-transparent [--navigation-row-height:30px] [--spacing:4px]"
      >
        <SidebarHeader className="shrink-0 gap-1 p-1 px-2" data-tauri-drag-region="deep">
          <div className="flex h-8 items-center gap-0.5 px-1" data-tauri-drag-region="deep">
            <span className="flex min-w-0 flex-1 items-center gap-1.5" data-tauri-drag-region="deep">
              <span className="truncate text-sm font-semibold">{t("app.wordmark")}</span>
              {/* The edition reads as a badge, not as part of the name: red pill, white lettering. */}
              <span className="shrink-0 rounded-full bg-red-500 px-1.5 py-[1px] text-[10px] leading-[1.2] font-semibold text-white">
                {t("app.plus")}
              </span>
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
            <SidebarMenuRow label={t("sidebar.newTask")} icon={CirclePlusIcon} onPrimary={onNewChat} />
            <SidebarMenuRow
              label={t("sidebar.toolbox")}
              icon={BoxesIcon}
              active={screen === "leading" && (leadingPage === "plugins" || leadingPage === "extensions")}
              onPrimary={onOpenSkills ?? onOpenPlugins}
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
              onPrimary={() =>
                screen === "leading" && leadingPage === "automation" ? onSwitchScreen() : onOpenAutomation()
              }
            />
            {/* Kept in place without an account: hiding it made a working destination look broken.
              Dimmed, with the reason on hover, and a click lands on the page that can fix it —
              opening the panel itself would only show a wall of failed requests. */}
            {driveEnabled && (
              <SidebarMenuRow
                label={t("sidebar.driveLibrary")}
                icon={CloudIcon}
                active={view === "drive"}
                muted={!driveVisible}
                hint={driveVisible ? undefined : t("sidebar.driveNeedsAccount")}
                onPrimary={() => {
                  if (!driveVisible) {
                    void openSettingsWindow("account")
                    return
                  }
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
              <GroupPanel
                onSelect={onSelect}
                onNewChat={(cwd, groupId) => onNewProjectChat(cwd, undefined, groupId ?? null)}
                onViewFiles={onViewFiles}
              />
            ) : view === "collections" ? (
              <CollectionPanel
                renderRow={renderRow}
                onSelect={onSelect}
                onNewChat={(id) => onNewProjectChat(null, id)}
              />
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
          {/* Hairline between the navigation rows above and the account block: identity is not
            another destination in the list. */}
          <Separator className="mx-1 my-1" />
          <div className="flex h-8 items-center gap-1">
            <div className="min-w-0 flex-1">
              <SidebarAccountMenu onOpenSettings={onOpenSettings} onEditProfile={onEditProfile} />
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("mobile.connectButton")}
                    onClick={() => void openSettingsWindow("mobile")}
                  >
                    <SmartphoneIcon />
                  </Button>
                }
              />
              <TooltipContent side="inline-end">{t("mobile.connectButton")}</TooltipContent>
            </Tooltip>
            <GuideButton />
          </div>
        </SidebarFooter>
      </Sidebar>
    </>
  )
}
