/**
 * The window's top-left cluster: 悬浮窗口, 收藏 and 活动.
 *
 * Everything on the left is about *conversations* — open one somewhere else, pin the ones you come
 * back to, or look at what the agents have been doing. Window chrome (the workspace toggle) lives
 * on the right instead, so the two corners never mix responsibilities.
 */

import { Activity, PictureInPicture2Icon, StarIcon } from "lucide-react"
import type { ReactElement } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { useSessionsUiStore } from "./store"
import { useActivityNotification } from "./use-activity-notification"

const ACTION_CLASS = "size-7 text-sidebar-foreground/70 hover:text-sidebar-foreground aria-[current=page]:bg-foreground/5 aria-[current=page]:text-sidebar-foreground"

export function FloatingWindowButton({
  onOpenWindow,
  shortcut
}: {
  onOpenWindow: () => void
  /** Platform label for the floating window's shortcut, when it has one. */
  shortcut?: string
}) {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("sidebar.newTaskWindow")}
            className={ACTION_CLASS}
            onClick={onOpenWindow}
          >
            <PictureInPicture2Icon className="size-4" aria-hidden="true" />
          </Button>
        }
      />
      <TooltipContent>
        {shortcut === undefined ? t("sidebar.newTaskWindow") : `${t("sidebar.newTaskWindow")} · ${shortcut}`}
      </TooltipContent>
    </Tooltip>
  )
}

export function TitleBarLeadingActions({
  onOpenWindow,
  shortcut
}: {
  onOpenWindow: () => void
  /** Platform label for the floating window's shortcut, when it has one. */
  shortcut?: string
}): ReactElement {
  const { t } = useTranslation()
  const view = useSessionsUiStore((state) => state.view)
  const setView = useSessionsUiStore((state) => state.setView)
  const { hasNotification } = useActivityNotification(view)

  return (
    <div className="flex items-center gap-0.5" data-titlebar-leading-actions>
      <FloatingWindowButton onOpenWindow={onOpenWindow} shortcut={shortcut} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("collection.title")}
              aria-current={view === "collections" ? "page" : undefined}
              className={ACTION_CLASS}
              onClick={() => setView(view === "collections" ? "sessions" : "collections")}
            >
              <StarIcon
                className={`size-4 ${
                  view === "collections" ? "fill-amber-400 text-amber-500" : "text-amber-500/80"
                }`}
                aria-hidden="true"
              />
            </Button>
          }
        />
        <TooltipContent>{t("collection.title")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("sidebar.activity")}
              aria-current={view === "activity" ? "page" : undefined}
              className={`relative ${ACTION_CLASS}`}
              onClick={() => setView(view === "activity" ? "sessions" : "activity")}
            >
              <Activity className="size-4" aria-hidden="true" />
              {hasNotification && (
                <span
                  data-activity-notification
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-destructive"
                />
              )}
            </Button>
          }
        />
        <TooltipContent>{t("sidebar.activity")}</TooltipContent>
      </Tooltip>
    </div>
  )
}
