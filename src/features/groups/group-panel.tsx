// The groups panel: the dedicated entry to the discussions. A group is a project of its own, so
// the panel offers the two things a group needs — reopen the last discussion in it, or start a
// new one — and leaves the roles and the roster to 设置 → 群.

import type { SessionSummary } from "@/agent/client"
import { FileTextIcon, MessageSquarePlusIcon, MessagesSquareIcon } from "lucide-react"
import { useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { groupRoleFor } from "@/lib/group-roles"
import { groupSessionRows, subscribeGroupSessionRows } from "@/lib/group-sessions"
import { basename } from "@/lib/path"
import { groups, subscribeGroups, type GroupConfig } from "@/lib/groups"

import { GroupDocumentDialog } from "./group-document-dialog"

export function GroupPanel({
  onSelect,
  onNewChat
}: {
  onSelect: (row: SessionSummary) => void
  onNewChat: (cwd: string) => void
}) {
  const { t } = useTranslation()
  const list = useSyncExternalStore(subscribeGroups, groups, groups)
  // A group's conversations are kept out of `sessionList` (they are not projects); the panel is
  // the only place they are listed, so it reads them from the client's own store.
  const rows = useSyncExternalStore(subscribeGroupSessionRows, groupSessionRows, groupSessionRows)
  const [editing, setEditing] = useState<GroupConfig | null>(null)
  if (list.length === 0)
    return (
      <>
        <p className="px-3 py-4 text-xs leading-relaxed text-muted-foreground">{t("groups.panelEmpty")}</p>
        <GroupDocumentDialog group={editing} open={editing !== null} onClose={() => setEditing(null)} />
      </>
    )
  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      {list.map((group) => {
        const latest = rows.find((row) => row.cwd === group.directory)
        const members = group.roles.map((id) => groupRoleFor(id)).filter((role) => role !== null)
        return (
          <div key={group.id} className="rounded-lg border border-border/60 bg-muted/20 px-2 py-1.5">
            <div className="truncate text-xs font-medium" title={group.name || group.directory}>
              {group.name.trim() === "" ? basename(group.directory) : group.name}
            </div>
            <div className="truncate text-[11px] text-muted-foreground" title={group.directory}>
              {members.length === 0 ? t("groups.panelNoMembers") : members.map((role) => role.name).join(" · ")}
            </div>
            <div className="mt-1 flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                disabled={latest === undefined}
                onClick={() => {
                  if (latest !== undefined) onSelect(latest)
                }}
              >
                <MessagesSquareIcon className="size-3" />
                {t("groups.panelContinue")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => onNewChat(group.directory)}
              >
                <MessageSquarePlusIcon className="size-3" />
                {t("groups.panelNew")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                aria-label={t("groups.panelDocument")}
                title={t("groups.panelDocument")}
                onClick={() => setEditing(group)}
              >
                <FileTextIcon className="size-3" />
              </Button>
            </div>
          </div>
        )
      })}
      <GroupDocumentDialog group={editing} open={editing !== null} onClose={() => setEditing(null)} />
    </div>
  )
}
