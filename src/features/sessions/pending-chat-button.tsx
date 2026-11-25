import { NavigationItemButton, ROW_HIGHLIGHT } from "@alwith/module-chat/session-list"
import { CircleAlertIcon, LoaderCircleIcon, MessageSquareIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"

import type { PendingChatRow } from "./pending-chat"

export function PendingChatButton({ row, onSelect }: { row: PendingChatRow; onSelect?: () => void }) {
  const { t } = useTranslation()
  const label = t(
    { draft: "sidebar.pendingPreparing", connecting: "sidebar.pendingConnecting", retryable: "sidebar.pendingRetry" }[
      row.status
    ]
  )
  return (
    <NavigationItemButton
      className={cn(ROW_HIGHLIGHT, "h-8 w-full gap-2 ps-8 pe-2")}
      data-pending-chat={row.status}
      aria-label={t("sidebar.untitled")}
      title={label}
      onClick={onSelect}
    >
      <MessageSquareIcon aria-hidden="true" />
      <span className="flex-1 truncate text-start">{t("sidebar.untitled")}</span>
      {row.status === "retryable" ? (
        <CircleAlertIcon className="size-3.5 text-destructive" />
      ) : (
        <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
      )}
      <span className="sr-only" role="status">
        {label}
      </span>
    </NavigationItemButton>
  )
}
