// Shell of auxiliary windows, reduced from ALwith Desktop's aux-window-shell: the sidebar
// form (the sidebar fills the window height, the traffic lights float over it, a hairline
// separates it from the content; header and footer belong to the right column).
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

const IS_WINDOWS = navigator.platform.includes("Win")

export function AuxWindowShell({
  title,
  showTitleBar = true,
  embedded = false,
  sidebar,
  sidebarClassName,
  className,
  children
}: {
  title?: ReactNode
  showTitleBar?: boolean
  embedded?: boolean
  sidebar: ReactNode
  sidebarClassName?: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("flex bg-background", embedded ? "h-full" : "h-screen", className)}>
      <aside className={cn("flex shrink-0 flex-col border-e border-border bg-sidebar", sidebarClassName)}>
        {/* Windows uses a native title bar outside the webview. Embedded in the main window the
            shell already sits under that window's chrome: the extra 32px strip there was an
            empty band above 账号与设备 with nothing to drag. */}
        {!IS_WINDOWS && !embedded && <div className="h-8 shrink-0" data-tauri-drag-region />}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{sidebar}</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {showTitleBar && (
          <div className="relative flex h-8 shrink-0 items-center gap-1 ps-2 pe-2" data-tauri-drag-region>
            {title && (
              <span className="absolute start-1/2 -translate-x-1/2 text-[13px] font-semibold text-muted-foreground rtl:translate-x-1/2">
                {title}
              </span>
            )}
            <div className="h-full flex-1" data-tauri-drag-region />
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  )
}
