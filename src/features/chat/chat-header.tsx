import { OverflowMarquee } from "@alwith/module-chat/session-list"


import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"

/** The floating surface supplies its top bar; the main surface keeps its own header. */
export function ChatHeader({
  target,
  title,
  project,
  turnCount,
  children
}: {
  target?: HTMLElement | null
  title: string
  project?: ReactNode
  /** Number of chat rounds (user prompts) in the session; shown as a compact badge. */
  turnCount?: number
  children: ReactNode
}) {
  const { t } = useTranslation()
  const floating = target !== undefined
  const content = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1.5" data-tauri-drag-region="deep">
        {project}
        <OverflowMarquee
          className={cn(
            "block min-w-0 text-[13px] font-medium select-none [&>span]:pointer-events-none",
            floating ? "max-w-[50vw]" : "flex-1"
          )}
          data-tauri-drag-region
        >
          {title}
        </OverflowMarquee>
        {turnCount !== undefined && turnCount > 0 && (
          // No frame: the header already carries a title and two icon actions, and a boxed badge
          // read as a third button.
          <span
            className="text-muted-foreground shrink-0 px-0.5 text-[11px] font-normal tabular-nums select-none"
            title={t("chat.turnCountTitle", { count: turnCount })}
          >
            {t("chat.turnCountBadge", { count: turnCount })}
          </span>
        )}
      </div>
      {children}
    </>
  )
  if (floating) return target === null ? null : createPortal(content, target)
  return (
    <header
      className="@container relative flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-border/70 px-3"
      data-main-chat-header
      data-tauri-drag-region="deep"
    >
      {content}
    </header>
  )
}
