import { OverflowMarquee } from "@alwith/module-chat/session-list"


import type { ReactNode } from "react"
import { createPortal } from "react-dom"

import { cn } from "@/lib/utils"

/** The floating surface supplies its top bar; the main surface keeps its own header. */
export function ChatHeader({
  target,
  title,
  children
}: {
  target?: HTMLElement | null
  title: string
  children: ReactNode
}) {
  const floating = target !== undefined
  const content = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1.5" data-tauri-drag-region="deep">
        <OverflowMarquee
          className={cn(
            "block min-w-0 text-sm font-semibold select-none [&>span]:pointer-events-none",
            floating ? "max-w-[50vw]" : "flex-1"
          )}
          data-tauri-drag-region
        >
          {title}
        </OverflowMarquee>
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
