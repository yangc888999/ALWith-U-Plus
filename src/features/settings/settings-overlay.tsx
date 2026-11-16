// Settings rendered inside the main window as a floating panel above the chat — not a separate
// Tauri window (that reintroduced the two original bugs: the cold window needed a second click,
// and opening it full-screen pulled focus out of the chat). The panel floats over the main
// interface; clicking anywhere on the main window dismisses it (it "sinks"), and clicking the
// avatar / gear again re-invokes it. `openSettingsWindow` / `toggleSettingsWindow` flip the
// overlay store, so every historical call site opens it here unchanged.
//
// It is draggable by the top strip and resizable from the bottom-right corner, and the box is
// remembered across opens — a panel that snaps back to the same spot every time is the reason
// people keep dragging it out of the way. Positions are clamped to the viewport so a box saved on a
// larger display cannot become unreachable.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { XIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { closeSettingsOverlay, useSettingsOverlay } from "@/lib/settings-overlay"

import { SettingsPage } from "./settings-page"

const STORAGE_KEY = "alwith:settings-panel"
const MIN_WIDTH = 640
const MIN_HEIGHT = 460
const EDGE = 8

type Box = { x: number; y: number; w: number; h: number }

function defaultBox(): Box {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth
  const vh = typeof window === "undefined" ? 800 : window.innerHeight
  const w = Math.min(960, vw - EDGE * 2)
  const h = Math.min(Math.round(vh * 0.88), 760)
  return { x: Math.round((vw - w) / 2), y: Math.round(vh * 0.06), w, h }
}

function clamp(box: Box): Box {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth
  const vh = typeof window === "undefined" ? 800 : window.innerHeight
  const w = Math.max(MIN_WIDTH, Math.min(box.w, vw - EDGE * 2))
  const h = Math.max(MIN_HEIGHT, Math.min(box.h, vh - EDGE * 2))
  return {
    w,
    h,
    // Keep a slice of the panel on screen: a box whose title strip is off-screen cannot be grabbed.
    x: Math.max(EDGE - w + 120, Math.min(box.x, vw - 120)),
    y: Math.max(0, Math.min(box.y, vh - 60))
  }
}

function readBox(): Box {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return defaultBox()
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== "object") return defaultBox()
    const value = parsed as Partial<Box>
    if (typeof value.x !== "number" || typeof value.y !== "number") return defaultBox()
    if (typeof value.w !== "number" || typeof value.h !== "number") return defaultBox()
    return clamp({ x: value.x, y: value.y, w: value.w, h: value.h })
  } catch {
    return defaultBox()
  }
}

function saveBox(box: Box): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(box))
  } catch {
    // Losing the remembered box is not worth an error toast.
  }
}

export function SettingsOverlay() {
  const { open } = useSettingsOverlay()
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<Box>(() => defaultBox())

  // The remembered box is read on open (not on every render): re-reading mid-drag would fight the
  // pointer, and a closed panel must not keep touching storage.
  useEffect(() => {
    if (open) setBox(readBox())
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSettingsOverlay()
    }
    // Dismiss when the user clicks through to the main interface (the panel is non-modal: the
    // main window stays fully interactive behind it). Portaled popovers (selects, dropdowns)
    // live outside the panel in the DOM, so they must not count as an outside click.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target === null) return
      if (panelRef.current?.contains(target)) return
      if (target.closest("[data-settings-surface]")) return
      if (target.closest("[data-radix-popper-content-wrapper]")) return
      if (target.closest("[role='menu'],[role='listbox'],[role='dialog']")) return
      closeSettingsOverlay()
    }
    window.addEventListener("keydown", onKeyDown)
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("pointerdown", onPointerDown, true)
    }
  }, [open])

  /** Shared pointer loop: `apply` gets the deltas in client pixels. */
  const follow = useCallback(
    (event: ReactPointerEvent, apply: (dx: number, dy: number, start: Box) => Box) => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startY = event.clientY
      const start = box
      let latest = start
      const move = (moveEvent: PointerEvent) => {
        latest = apply(moveEvent.clientX - startX, moveEvent.clientY - startY, start)
        setBox(latest)
      }
      const up = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
        saveBox(latest)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
    },
    [box]
  )

  if (!open) return null

  return (
    <div
      ref={panelRef}
      data-settings-surface
      role="dialog"
      aria-modal="false"
      aria-label={t("settings.title")}
      className="fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-background/95 shadow-2xl backdrop-blur-2xl animate-in fade-in-0 zoom-in-95"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      {/* 浮层没有标题栏：多出来的 28px 空白带会顶在「账号与设备」上面，看起来像没加载完。
          拖拽改成覆盖在顶部的一条透明热区，关闭按钮按 macOS 习惯放左边 —— 左边是导航列，
          内容列因此从浮层顶边开始，不再被一条空带压低。 */}
      <div
        data-settings-drag
        aria-hidden="true"
        className="absolute inset-x-0 top-0 z-10 h-7 cursor-grab active:cursor-grabbing"
        onPointerDown={(event) => {
          const target = event.target as HTMLElement
          if (target.closest("button,a,input")) return
          follow(event, (dx, dy, start) => clamp({ ...start, x: start.x + dx, y: start.y + dy }))
        }}
      />
      {/* 左上角按 macOS 习惯摆成红绿灯：红点是关闭，hover 才浮出 ×；另外两点是纯装饰
          —— 这个面板没有最小化/最大化语义，做成能点的假按钮会骗人，所以只跟着拖拽走。
          12px 直径 + 8px 间隙是系统 traffic light 的尺寸，圆心落在 (16,16)，和系统窗口对齐。 */}
      <div className="absolute start-2.5 top-2.5 z-20 flex items-center gap-2" data-settings-traffic>
        <button
          type="button"
          aria-label={t("settings.close")}
          onClick={closeSettingsOverlay}
          className="group relative flex size-3 items-center justify-center rounded-full border border-black/15 bg-[#ff5f57] shadow-[inset_0_1px_0_rgb(255_255_255/0.35)] transition-colors hover:bg-[#ff4136] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <XIcon
            className="size-2 text-black/50 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden="true"
            strokeWidth={3}
          />
        </button>
        <span aria-hidden="true" className="size-3 rounded-full border border-black/10 bg-black/10 dark:border-white/10 dark:bg-white/15" />
        <span aria-hidden="true" className="size-3 rounded-full border border-black/10 bg-black/10 dark:border-white/10 dark:bg-white/15" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <SettingsPage embedded />
      </div>
      {/* Resize grip: bottom-right, the corner every window uses. */}
      <div
        aria-hidden="true"
        onPointerDown={(event) =>
          follow(event, (dx, dy, start) => clamp({ ...start, w: start.w + dx, h: start.h + dy }))
        }
        className="absolute end-0 bottom-0 size-4 cursor-nwse-resize bg-[linear-gradient(135deg,transparent_50%,var(--border)_50%)]"
      />
    </div>
  )
}
