import { SidebarOverlayContext } from "@alwith/module-chat/session-list"
import "@nyssance/atlas/styles.css"
import { PanelLeftDashedIcon, PanelLeftIcon } from "lucide-react"
import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState
} from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useStore } from "zustand"

import {
  WindowsTitleBarContext,
  WindowsWorkspaceControlsContext
} from "@/components/alwith-ui/windows-main-window-shell"
import { Button } from "@/components/ui/button"
import { SidebarProvider } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { saveChatLayout, useChatLayout } from "@/features/workspace/chat-layout"
import { NAVIGATION_PX_MIN, resolveRatioToPixels, saveLayoutShare } from "@/features/workspace/layout-preferences"
import { PanelDivider } from "@/features/workspace/panel-divider"
import { useWorkspaceLayout } from "@/features/workspace/use-workspace-layout"
import { isMac } from "@/lib/platform"
import { savePreference } from "@/lib/preferences"
import { settingsStore } from "@/lib/settings-store"
import { useWindowFullscreen } from "@/lib/use-window-fullscreen"
import { zoomStore } from "@/lib/zoom"

import { CanvasContext } from "../lib/canvas-context"
import { useMainCanvas } from "../lib/use-main-canvas"
import { CanvasDots } from "./canvas-dots"

export type MainScreen = "main" | "leading"

/** Lets a toolbar hide/show the docked sidebar without knowing the layout internals. */
export const SidebarToggleContext = createContext<{
  toggle: () => void
  /** Explicitly restore the full sidebar; rail destinations must not depend on toggle state. */
  expand?: () => void
  docked: boolean
} | null>(null)

/**
 * Hosts the collapsed-sidebar icon rail. The rail element stays inside the window while the
 * sidebar panel itself slides off-screen, so the sidebar portals its own icon column into it.
 */
export const SidebarRailContext = createContext<HTMLDivElement | null>(null)

export function MainSidebarLayout({
  initialPinned,
  screen,
  onScreenChange,
  sidebar,
  leading,
  main,
  trailing,
  toolbar,
  leadingActions,
  headerTrailing,
  statusBar,
  children,
  chatMode
}: {
  initialPinned: boolean
  screen: MainScreen
  onScreenChange?: (screen: MainScreen) => void
  sidebar: ReactNode
  leading: ReactNode
  main: ReactNode
  trailing?: ReactNode
  /** Window chrome docked to the end of the 32px title row (the workspace toggle mounts here). */
  toolbar?: ReactNode
  /** A floating-window launcher docked to the top-right corner of the title row. */
  headerTrailing?: ReactNode
  /** Buttons docked to the start of the title row, right after the sidebar toggle. */
  leadingActions?: ReactNode
  statusBar?: ReactNode
  children?: ReactNode
  /** A chat surface has two columns and its own sidebar width; a project reads the four-column store. */
  chatMode?: boolean
}) {
  const { t } = useTranslation()
  const layout = useWorkspaceLayout()
  const chatLayout = useChatLayout()
  const zoom = useStore(zoomStore, (state) => state.level)
  // The sidebar is stored as a window fraction so it adapts to any window size; resolve it to a
  // pixel width clamped to a usable range before handing it to the canvas.
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 0))
  useEffect(() => {
    if (typeof window === "undefined") return
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  // No pixel ceiling: the Settings percentage has to describe the real column even on a wide
  // window. The old 460px cap turned 18% into 16% there and made the numbers look wrong.
  const navigationRatio = chatMode === true ? chatLayout.navigationRatio : layout.navigationRatio
  const sidebarPx = resolveRatioToPixels(navigationRatio, viewportWidth, 0, viewportWidth)
  // A drag owns the pixel width until release; the persisted share takes over afterwards, so the
  // next launch (or the Settings number) decides the column again.
  const [dragPx, setDragPx] = useState<number | null>(null)
  const dragPxRef = useRef(0)
  // The width the pointer went down on. `PanelDivider` reports the distance from that point, not
  // the distance since the last move, so this — not the live width — is what the delta applies to.
  const dragStartPxRef = useRef(0)
  const effectiveSidebarPx = dragPx ?? sidebarPx
  const titlebar = useContext(WindowsTitleBarContext)
  const workspaceControls = useContext(WindowsWorkspaceControlsContext)
  const fullscreen = useWindowFullscreen()
  const [pinned, setPinned] = useState(initialPinned)
  const [presentation, setPresentation] = useState<"docked" | "floating">(initialPinned ? "docked" : "floating")
  // 设置页的「显示侧边栏」写的是同一个 `appearance.sidebarPinned`：订阅它，开关才能即时生效，
  // 不必重启。只处理这一个键，别的偏好变化不动本地状态。
  useEffect(() => {
    const syncPinned = (keys: string[]) => {
      if (!keys.includes("appearance.sidebarPinned")) return
      const next = settingsStore.get<boolean>("appearance.sidebarPinned")
      if (typeof next !== "boolean" || next === pinned) return
      setPinned(next)
      setPresentation("docked")
    }
    return settingsStore.subscribe(syncPinned)
  }, [pinned])

  const canvas = useMainCanvas(screen, pinned, onScreenChange, trailing !== undefined)
  const navigate = canvas.context.navigate
  const mainActive = screen === "main"
  // The canvas parks on one region at a time, but the title-bar controls must stay offered on
  // every main-screen region: gating them on `selected === 1` removed the only way back once the
  // panel had collapsed (2026-11-16, 「侧边栏不能正常展开」).
  const showMainControls = mainActive
  /** The workspace cluster describes the conversation, so it only belongs to that screen. */
  const onChatScreen = mainActive && canvas.selected === 1
  const pinnedOnScreen = pinned && canvas.selected === 1
  const docked = !mainActive || pinnedOnScreen
  const visible = docked || canvas.navigationPeeking
  const panelId = useId()
  const panel = useRef<HTMLDivElement>(null)
  // The rail node is state, not a ref: portals need the element in the tree before they mount.
  const [railNode, setRailNode] = useState<HTMLDivElement | null>(null)
  const railVisible = !docked && !canvas.navigationPeeking
  const toggle = useRef<HTMLButtonElement>(null)
  const overlays = useRef(0)
  const saving = useRef(Promise.resolve())

  // Portaled menus retain the same Atlas-owned navigation surface.
  const retainOverlay = useCallback(() => {
    overlays.current += 1
    panel.current?.parentElement?.setAttribute("data-popup-open", "")
    return () => {
      overlays.current -= 1
      if (overlays.current === 0) panel.current?.parentElement?.removeAttribute("data-popup-open")
    }
  }, [])

  const changePinned = useCallback(
    (next: boolean) => {
      // The leading screen carries its own navigation column, so a collapse request there is a
      // no-op — but an expand request must go back to the conversation instead of being dropped.
      if (!mainActive) {
        if (!next) return
        onScreenChange?.("main")
        navigate("chat")
        setPinned(true)
        setPresentation("docked")
        saving.current = saving.current
          .then(() => savePreference("sidebarPinned", true))
          .catch((error: unknown) => {
            toast.error(error instanceof Error ? error.message : String(error))
          })
        return
      }
      // Any region other than the conversation has to go back to it first: `pinnedOnScreen`
      // requires `selected === 1`, so expanding while parked on the leading screen set `pinned`
      // but left `docked` false — the panel stayed 0px wide and the toggle looked dead. Only
      // `> 1` was handled, which is why "collapse once, then it never opens again" happened
      // whenever the canvas had settled on the leading screen (2026-11-18).
      if (next && canvas.selected !== 1) navigate("chat")
      setPresentation("docked")
      setPinned(next)
      // Serialize writes so rapid toggles cannot restore an older choice on restart.
      saving.current = saving.current
        .then(() => savePreference("sidebarPinned", next))
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error))
        })
    },
    [mainActive, canvas.selected, navigate, onScreenChange]
  )

  useEffect(() => {
    if (canvas.navigationPeeking) setPresentation("floating")
  }, [canvas.navigationPeeking])

  useEffect(() => {
    if (!visible && panel.current?.contains(document.activeElement)) toggle.current?.focus({ preventScroll: true })
  }, [visible, showMainControls])

  const ToggleIcon = pinned ? PanelLeftIcon : PanelLeftDashedIcon

  const sidebarToggle = (
    <div
      className={titlebar ? "windows-sidebar-toggle" : "main-sidebar-toggle"}
      style={titlebar ? { width: leadingActions === undefined ? 32 / zoom : undefined, height: 32 / zoom } : undefined}
    >
      {/* Tooltip, not `title`: the native one waits about a second, and this button sits next to
          ones that open instantly. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={toggle}
              variant="ghost"
              size="icon-xs"
              role="switch"
              aria-label={t("sidebar.pin")}
              aria-checked={docked}
              aria-expanded={visible}
              aria-controls={panelId}
              data-atlas-navigation-trigger
              className="text-sidebar-foreground"
              onClick={() => changePinned(!docked)}
            >
              <ToggleIcon className="size-4 rtl:-scale-x-100" />
            </Button>
          }
        />
        <TooltipContent side="bottom">{t(pinned ? "sidebar.unpin" : "sidebar.pin")}</TooltipContent>
      </Tooltip>
      {leadingActions}
      {/* macOS docks the workspace toggle in the leading cluster; Windows portals it into the
          window controls, so it must not also render here (that produced two buttons). */}
      {!titlebar && !workspaceControls && toolbar}
    </div>
  )

  return (
    <SidebarToggleContext.Provider
      value={{ toggle: () => changePinned(!docked), expand: () => changePinned(true), docked }}
    >
    {/* Hosts the rail element for the whole layout subtree: the sidebar (which portals its
        icons in) and the rail itself must both sit inside this provider. */}
    <SidebarRailContext.Provider value={railNode}>
      <SidebarProvider
        open={visible}
        onOpenChange={changePinned}
        className="relative h-full min-h-0 flex-col overflow-clip"
        data-main-screen={screen}
        data-canvas-moving={canvas.moving}
        data-canvas-pinned={pinned}
        data-sidebar-mode={docked ? "pinned" : visible ? "floating" : "hidden"}
        data-rail-show={railVisible ? "" : undefined}
        data-sidebar-presentation={docked || canvas.moving ? "docked" : presentation}
        style={
          {
            "--sidebar-width": `${effectiveSidebarPx}px`,
            "--leading-sidebar-width": "var(--sidebar-width)",
            "--canvas-sidebar-offset": `${Math.max(0, (canvas.geometry.stops[canvas.selected] ?? 0) - canvas.geometry.leading)}px`,
            "--active-sidebar-width": docked ? "var(--sidebar-width)" : "0px",
            // Native window controls keep their size when page content zooms.
            "--sidebar-toggle-left": isMac() && !fullscreen ? "calc(80px * var(--window-zoom-correction))" : "8px"
          } as CSSProperties
        }
      >
        {/* `deep` lets the whole 32px strip drag, including the gaps between the traffic
            lights and the trailing actions. A bare attribute only drags when the pointer hits
            the header element itself, which is exactly the "sometimes it won't move" case. */}
        <header className="main-window-titlebar" data-tauri-drag-region="deep">
          {showMainControls && !titlebar && sidebarToggle}
          {/* The floating-window launcher (a copy of the leading action) docks to the top-right corner. */}
          {onChatScreen && !titlebar && headerTrailing && (
            <div className="main-window-header-actions">{headerTrailing}</div>
          )}
        </header>
        {onChatScreen && workspaceControls && toolbar && createPortal(toolbar, workspaceControls)}
        {showMainControls && titlebar && createPortal(sidebarToggle, titlebar)}
        <CanvasContext.Provider value={canvas.context}>
          <div className="main-window-body" dir={canvas.direction}>
            <div ref={canvas.ref} className="main-canvas-viewport">
              <div
                className="main-screen-track"
                data-atlas-track
                style={
                  {
                    "--canvas-leading-width": `${canvas.geometry.leading}px`,
                    // CSS resolves the single-screen width before ResizeObserver delivers new geometry.
                    "--canvas-content-width": canvas.context.split
                      ? `${canvas.geometry.content}px`
                      : `calc(100% + var(--canvas-leading-width) - ${pinned ? "var(--sidebar-width)" : "0px"})`
                  } as CSSProperties
                }
              >
                {canvas.geometry.stops.map((offset, index) => (
                  <div
                    key={index}
                    className="canvas-snap"
                    data-atlas-region={canvas.geometry.regions[index]}
                    data-atlas-leading={index === 0 ? "" : undefined}
                    aria-hidden="true"
                    // `stops` are canvas-absolute and the track reserves the leading width as its
                    // inline-start padding, so these markers line up with the screens as laid out.
                    style={{ insetInlineStart: offset, width: canvas.width }}
                  />
                ))}
                <div
                  className="main-screen-leading"
                  data-screen-panel="leading"
                  inert={mainActive}
                  aria-hidden={mainActive}
                >
                  {leading}
                </div>
                <SidebarOverlayContext.Provider value={retainOverlay}>
                  <div
                    className="main-sidebar-shell"
                    data-atlas-navigation
                    data-resizing={dragPx !== null ? "" : undefined}
                    ref={canvas.navigationRef}
                  >
                    <div className="main-sidebar-viewport" data-atlas-navigation-surface id={panelId}>
                      <div
                        ref={panel}
                        className="main-sidebar-panel"
                        inert={!visible && !canvas.moving}
                        aria-hidden={!visible && !canvas.moving}
                      >
                        {sidebar}
                      </div>
                    </div>
                    {pinnedOnScreen && (
                      <div className="main-sidebar-resize">
                        <PanelDivider
                          label={t("workspace.resize")}
                          width={effectiveSidebarPx}
                          direction={canvas.direction}
                          onStart={() => {
                            dragStartPxRef.current = effectiveSidebarPx
                            dragPxRef.current = effectiveSidebarPx
                          }}
                          onDrag={(dx) => {
                            // Dragging right widens the sidebar. `dx` is cumulative from pointer-down,
                            // so it has to be applied to the width the drag started on: applying it to
                            // the live width compounded every pointermove and a fast drag ran away.
                            //
                            // The bounds are taken relative to that start too. The stored share can
                            // resolve below the 180px floor on a narrow window, and a fixed floor would
                            // then swallow the first pixels of the drag and snap the divider in one go.
                            const start = dragStartPxRef.current
                            const floor = Math.min(NAVIGATION_PX_MIN, start)
                            const ceiling = Math.max(Math.round(viewportWidth * 0.6), start)
                            const next = Math.min(ceiling, Math.max(floor, start - dx))
                            dragPxRef.current = next
                            setDragPx(next)
                          }}
                          onEnd={() => {
                            // Persist the settled share: the four-column model keeps chat/tree put and
                            // lets the preview absorb the difference, so the total stays 100%.
                            if (viewportWidth > 0) {
                              const percent = (dragPxRef.current / viewportWidth) * 100
                              // A chat stores its own sidebar width; a project writes the four-column
                              // budget. Keeping them apart is what lets the two surfaces differ.
                              if (chatMode === true) saveChatLayout({ navigationRatio: percent / 100 })
                              else saveLayoutShare("navigation", percent)
                            }
                            setDragPx(null)
                          }}
                        />
                      </div>
                    )}
                  </div>
                </SidebarOverlayContext.Provider>
                <div
                  className="main-screen-content"
                  data-screen-panel="main"
                  inert={!mainActive}
                  aria-hidden={!mainActive}
                >
                  {main}
                </div>
                {trailing !== undefined && (
                  <aside
                    className="main-screen-trailing"
                    data-screen-panel="trailing"
                    inert={canvas.geometry.regions[canvas.selected] !== "trailing" && !canvas.moving}
                  >
                    {trailing}
                  </aside>
                )}
              </div>
            </div>
              <div ref={setRailNode} className="main-sidebar-rail" />
          </div>
        </CanvasContext.Provider>
        <footer className="main-window-statusbar">
          <CanvasDots
            count={canvas.geometry.stops.length - 1}
            selected={canvas.selected - 1}
            onSelect={(index) => canvas.select(index + 1)}
          />
          {statusBar}
        </footer>
        {children}
      </SidebarProvider>
    </SidebarRailContext.Provider>
    </SidebarToggleContext.Provider>
  )
}
