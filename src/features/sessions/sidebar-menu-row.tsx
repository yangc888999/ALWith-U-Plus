/**
 * A sidebar navigation row.
 *
 * A row may own a small flyout of related destinations: hovering reveals them without spending a
 * permanent row on each, and a plain click still runs the row's own action. WorkBuddy's
 * "专家·技能·连接器" behaves this way, and it is what keeps ALWith U⁺'s header from growing a row per
 * surface. Rows with a single destination (新建任务) pass no `destinations` and behave like a
 * normal button — no hover menu, no extra click before the page they name.
 *
 * The flyout is portalled and positioned from the row's rect rather than rendered inline: the
 * sidebar clips its own overflow, so an in-flow menu would be cut off at the panel edge.
 */

import { MENU_HIGHLIGHT, NavigationItemButton } from "@alwith/module-chat/session-list"
import type { LucideIcon } from "lucide-react"
import type { ReactElement } from "react"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { cn } from "@/lib/utils"

export type SidebarMenuDestination = {
  id: string
  label: string
  icon: LucideIcon
  onSelect: () => void
  /** Draws the highlight for the surface the window is currently showing. */
  active?: boolean
}

const OPEN_DELAY = 120
const CLOSE_DELAY = 200
const GAP = 6
const WIDTH = 200
const ROW_HEIGHT = 32

export function SidebarMenuRow({
  label,
  icon: Icon,
  active,
  onPrimary,
  destinations = [],
  muted = false,
  hint
}: {
  label: string
  icon: LucideIcon
  active?: boolean
  /** What a plain click does. When there are destinations, hovering lists them. */
  onPrimary: () => void
  /** Related pages offered on hover. Empty means this row is a plain button. */
  destinations?: SidebarMenuDestination[]
  /** Present but unusable right now: dim it and explain why, instead of hiding it. A destination
   *  the reader knows about must not vanish — they need to see where it went and what it needs. */
  muted?: boolean
  hint?: string
}): ReactElement {
  const rowRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const menuId = useId()
  const hasDestinations = destinations.length > 0

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current)
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    openTimer.current = null
    closeTimer.current = null
  }, [])

  const scheduleOpen = useCallback(() => {
    clearTimers()
    openTimer.current = window.setTimeout(() => {
      const row = rowRef.current
      if (row) setRect(row.getBoundingClientRect())
    }, OPEN_DELAY)
  }, [clearTimers])

  const close = useCallback(
    (immediate = false) => {
      clearTimers()
      if (immediate) {
        setRect(null)
        return
      }
      closeTimer.current = window.setTimeout(() => setRect(null), CLOSE_DELAY)
    },
    [clearTimers]
  )

  // The panel only outlives the pointer while it is being used: leaving it, scrolling the list
  // behind it, resizing, clicking elsewhere, or pressing Escape puts it away.
  useEffect(() => {
    if (rect === null) return
    const dismiss = () => close(true)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true)
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || rowRef.current?.contains(target)) return
      close(true)
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("resize", dismiss)
    window.addEventListener("scroll", dismiss, true)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("resize", dismiss)
      window.removeEventListener("scroll", dismiss, true)
    }
  }, [rect, close])

  useEffect(() => clearTimers, [clearTimers])

  const height = destinations.length * ROW_HEIGHT + 8
  const top = rect === null ? 0 : Math.max(GAP, Math.min(rect.top - 4, window.innerHeight - height - GAP))
  const left =
    rect === null
      ? 0
      : rect.right + GAP + WIDTH > window.innerWidth
        ? Math.max(GAP, rect.left - WIDTH - GAP)
        : rect.right + GAP

  return (
    <>
      <NavigationItemButton
        ref={rowRef}
        active={active}
        aria-haspopup={hasDestinations ? "menu" : undefined}
        aria-expanded={hasDestinations ? rect !== null : undefined}
        aria-controls={hasDestinations && rect !== null ? menuId : undefined}
        aria-disabled={muted || undefined}
        title={hint}
        className={cn(MENU_HIGHLIGHT, "h-8 gap-2 px-2", muted && "opacity-55")}
        onClick={() => {
          close(true)
          onPrimary()
        }}
        onPointerEnter={hasDestinations ? scheduleOpen : undefined}
        onPointerLeave={hasDestinations ? () => close() : undefined}
      >
        <Icon />
        <span>{label}</span>
      </NavigationItemButton>
      {rect !== null &&
        createPortal(
          <div
            ref={panelRef}
            id={menuId}
            role="menu"
            aria-label={label}
            onPointerEnter={clearTimers}
            onPointerLeave={() => close()}
            style={{ top, left, width: WIDTH }}
            className="fixed z-50 flex flex-col gap-0.5 rounded-xl bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
          >
            {destinations.map(({ id, label: itemLabel, icon: ItemIcon, onSelect, active: itemActive }) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                aria-current={itemActive ? "page" : undefined}
                onClick={() => {
                  close(true)
                  onSelect()
                }}
                className="flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-start text-sm text-foreground/85 outline-hidden hover:bg-foreground/5 hover:text-foreground focus-visible:bg-foreground/5 aria-[current=page]:bg-foreground/5 aria-[current=page]:text-foreground"
              >
                <ItemIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{itemLabel}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
