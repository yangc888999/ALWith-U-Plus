// The groups panel: the dedicated entry to the discussions. A group is a project of its own, so
// the panel offers what a group needs — reopen the latest session of it, or open a fresh one that
// carries the previous session's summary — and leaves the roles to 设置 → 拉会.
//
// The ＋ at the top of the section is now the primary way to create a meeting: the sidebar is
// where the user is when the idea arrives, and the create dialog (shared with edit mode) keeps
// them from having to detour through settings and back.

import type { SessionSummary } from "@/agent/client"
import {
  EllipsisIcon,
  FileTextIcon,
  FolderOpenIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  PlusIcon
} from "lucide-react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { openPath } from "@tauri-apps/plugin-opener"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { commands } from "@/bindings"
import {
  bindProjectDirectory,
  DRAFT_DIRECTORY_KEY,
  isGroupsRoot
} from "@/features/workspace/project-directory"
import { groupRoleFor } from "@/lib/group-roles"
import { groupSessionRows, subscribeGroupSessionRows } from "@/lib/group-sessions"
import { basename } from "@/lib/path"
import { groupByDirectory, groups, removeGroup, setGroup, subscribeGroups, type GroupConfig } from "@/lib/groups"

import { CreateMeetingDialog } from "./create-meeting-dialog"
import { GroupDocumentDialog } from "./group-document-dialog"

export function GroupPanel({
  onSelect,
  onNewChat,
  onViewFiles
}: {
  onSelect: (row: SessionSummary) => void
  onNewChat: (cwd: string, groupId?: string | null) => void
  /** Opens the meeting's folder in the workspace without creating a conversation. */
  onViewFiles?: (directory: string, groupId: string) => void
}) {
  const { t } = useTranslation()
  const list = useSyncExternalStore(subscribeGroups, groups, groups)
  // A group's conversations are kept out of `sessionList` (they are not projects); the panel is
  // the only place they are listed, so it reads them from the client's own store.
  const rows = useSyncExternalStore(subscribeGroupSessionRows, groupSessionRows, groupSessionRows)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<GroupConfig | null>(null)
  const [documentGroup, setDocumentGroup] = useState<GroupConfig | null>(null)
  const [removing, setRemoving] = useState<GroupConfig | null>(null)

  // Heal records the retired settings-page "attach" flow left pinned to a PARENT folder (often
  // `groups/` itself): the meeting's conversations live in `<parent>/<会议名>/`, so the record must
  // point there too — otherwise 新开一场 enters the parent and 继续上一次 never lights up. Runs on
  // mount (not on click) so the card is correct before the reader touches anything; each record is
  // attempted once per launch, and a heal that finds no named subfolder leaves it alone.
  const healedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const group of list) {
      if (group.directory === "" || group.name.trim() === "" || healedRef.current.has(group.id)) continue
      healedRef.current.add(group.id)
      void commands
        .groupDirectoryHeal({ name: group.name.trim(), directory: group.directory })
        .then((healed) => {
          if (healed === null) return
          // Re-read the stored record: the reader may have edited it while the check ran.
          const current = groups().find((entry) => entry.id === group.id)
          if (current === undefined || current.directory !== group.directory) return
          setGroup({ ...current, directory: healed.directory, document: healed.document })
          // The old heal was silent. Say it happened and hand the repaired folder to every surface
          // that already knows this meeting's conversations, so 文件栏 opens on the right folder.
          toast.success(t("groups.directoryHealed"))
          for (const row of groupSessionRows()) {
            if (row.cwd === healed.directory) bindProjectDirectory(row.sessionId, healed.directory, group.id)
          }
          if (current.sessionId !== null) bindProjectDirectory(current.sessionId, healed.directory, group.id)
        })
        .catch(() => undefined)
    }
  }, [list, t])

  const sessionsOf = (group: GroupConfig): SessionSummary[] =>
    rows
      .filter((row) => groupByDirectory(row.cwd)?.id === group.id)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))

  /**
   * Enter a meeting folder. A "新开一场" has no session id yet, so the directory is bound under
   * the draft key — otherwise the fresh draft looked like a chat with no project and showed only
   * two columns instead of the meeting's group.md, memory.md, 资料 and 产出.
   */
  const enter = (directory: string, groupId?: string | null): void => {
    if (directory === "") return
    if (isGroupsRoot(directory)) {
      toast.error(t("workspace.invalidDirectory"))
      return
    }
    bindProjectDirectory(DRAFT_DIRECTORY_KEY, directory, groupId ?? null)
    onNewChat(directory, groupId ?? null)
  }

  /** Reopen a meeting's latest conversation with its folder bound before the app resolves it. */
  const resume = (row: SessionSummary, group: GroupConfig): void => {
    bindProjectDirectory(row.sessionId, row.cwd, group.id)
    onSelect(row)
  }

  /**
   * 查看会议文件: with a session, open it (which binds + opens the four columns). With no session
   * yet, bind the current surface to the meeting's folder directly — a meeting is a project even
   * before the first turn, so its files must be reachable.
   */
  const viewFiles = (group: GroupConfig, latest: SessionSummary | undefined): void => {
    if (group.directory === "") {
      toast.info(t("groups.noMeetingSession"))
      return
    }
    if (isGroupsRoot(group.directory)) {
      toast.error(t("workspace.invalidDirectory"))
      return
    }
    if (latest !== undefined) {
      resume(latest, group)
      return
    }
    if (onViewFiles !== undefined) {
      onViewFiles(group.directory, group.id)
      return
    }
    bindProjectDirectory(DRAFT_DIRECTORY_KEY, group.directory, group.id)
    toast.info(t("groups.noMeetingSession"))
  }

  /**
   * 新开一场, from either button. A meeting whose folder was never materialised gets it created on
   * click — the primary action must not be greyed out with a hint to detour into settings.
   */
  const startNew = (group: GroupConfig): void => {
    if (group.directory !== "") {
      enter(group.directory, group.id)
      return
    }
    if (group.name.trim() === "") return
    void commands
      .groupDirectoryCreate({ name: group.name.trim(), parent: null })
      .then((created) => {
        setGroup({ ...group, directory: created.directory, document: created.document })
        enter(created.directory, group.id)
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 pb-1 pt-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">{t("sidebar.groups")}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={() => setCreating(true)}
        >
          <PlusIcon className="size-3" />
          {t("groups.createEntry")}
        </Button>
      </div>
      {list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
          <p className="text-xs leading-relaxed text-muted-foreground">{t("groups.panelEmptyV2")}</p>
          <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
            <PlusIcon className="size-3.5" />
            {t("groups.createEntry")}
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-1">
          {list.map((group) => {
            const sessions = sessionsOf(group)
            const latest = sessions[0]
            const members = group.roles.map((id) => groupRoleFor(id)).filter((role) => role !== null)
            return (
              <div key={group.id} className="rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5">
                <div className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium" title={group.name || group.directory}>
                      {group.name.trim() === "" ? basename(group.directory) : group.name}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {group.focus.trim() !== "" && (
                      <span
                        className="max-w-[6rem] truncate rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary"
                        title={`${t("groups.createFocusLabel")}：${group.focus.trim()}`}
                      >
                        {group.focus.trim()}
                      </span>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={t("groups.panelSessions")}
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <EllipsisIcon className="size-3.5" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-52">
                        <DropdownMenuLabel>{t("groups.panelSessions")}</DropdownMenuLabel>
                        {sessions.length === 0 && (
                          <DropdownMenuItem disabled>{t("groups.panelNoSessions")}</DropdownMenuItem>
                        )}
                        {sessions.map((row, index) => (
                          <DropdownMenuItem
                            key={row.sessionId}
                            onClick={() => resume(row, group)}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {t("groups.panelSessionNth", { nth: sessions.length - index })}
                              {index === 0 ? ` · ${t("groups.panelSessionLatest")}` : ""}
                              {row.updatedAt !== null ? `（${shortDate(row.updatedAt)}）` : ""}
                            </span>
                            <span className="ms-1 max-w-[8rem] shrink-0 truncate text-[10px] text-muted-foreground">
                              {row.title ?? ""}
                            </span>
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => startNew(group)}>
                          <MessageSquarePlusIcon className="size-3.5" />
                          {t("groups.panelNew")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setEditing(group)}>
                          <FileTextIcon className="size-3.5" />
                          {t("groups.panelEditMeeting")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setDocumentGroup(group)}>
                          <FileTextIcon className="size-3.5" />
                          {t("groups.panelDocument")}
                        </DropdownMenuItem>
                        {group.directory !== "" && (
                          <DropdownMenuItem onClick={() => viewFiles(group, latest)}>
                            <FolderOpenIcon className="size-3.5" />
                            {t("groups.openMeetingFiles")}
                          </DropdownMenuItem>
                        )}
                        {group.directory !== "" && (
                          <DropdownMenuItem
                            onClick={() => {
                              void openPath(group.directory).catch((error: unknown) =>
                                toast.error(error instanceof Error ? error.message : String(error))
                              )
                            }}
                          >
                            <FolderOpenIcon className="size-3.5" />
                            {t("groups.openFolder")}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setRemoving(group)}
                        >
                          {t("groups.removeGroup")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                <div className="truncate text-[11px] text-muted-foreground" title={group.directory}>
                  {members.length === 0
                    ? t("groups.panelNoMembers")
                    : `${members
                        .map((role, index) =>
                          index === members.length - 1 ? `${role.name}（${t("groups.panelSummarizerTag")}）` : role.name
                        )
                        .join(" · ")}` +
                      (group.materialFolders.length > 0
                        ? ` · ${t("groups.panelMaterialsTag", { count: group.materialFolders.length })}`
                        : "")}
                </div>
                <div className="mt-1 flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px]"
                    disabled={latest === undefined}
                    title={latest === undefined ? t("groups.panelContinueDisabled") : undefined}
                    onClick={() => {
                      if (latest !== undefined) resume(latest, group)
                    }}
                  >
                    <MessagesSquareIcon className="size-3" />
                    {t("groups.panelContinue")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px]"
                    // A meeting without a folder cannot be entered; the design says the primary
                    // action is 新开一场, so the folder is materialised on click instead of the
                    // button being greyed out with a hint to detour into settings.
                    disabled={group.directory === "" && group.name.trim() === ""}
                    onClick={() => startNew(group)}
                  >
                    <MessageSquarePlusIcon className="size-3" />
                    {t("groups.panelNew")}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <CreateMeetingDialog
        open={creating}
        group={null}
        onClose={() => setCreating(false)}
        onCreated={(created, directory) => enter(directory, created.id)}
      />
      <CreateMeetingDialog
        open={editing !== null}
        group={editing}
        onClose={() => setEditing(null)}
        onCreated={() => undefined}
      />
      <GroupDocumentDialog group={documentGroup} open={documentGroup !== null} onClose={() => setDocumentGroup(null)} />
      <Dialog open={removing !== null} onOpenChange={(value) => !value && setRemoving(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("groups.removeConfirmTitle", { name: removing?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("groups.removeConfirmDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) removeGroup(removing.id)
                setRemoving(null)
              }}
            >
              {t("groups.removeGroup")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** `2026-11-13T…` → `11-13`, for the session menu. */
function shortDate(updatedAt: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(updatedAt)
  return match === null ? updatedAt.slice(0, 10) : `${match[1]}-${match[2]}`
}
