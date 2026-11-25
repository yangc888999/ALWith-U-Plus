import { isTauri } from "@tauri-apps/api/core"
import {
  type ContextType,
  type CSSProperties,
  type RefCallback,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { events } from "@/bindings"
import { useThreeFingerSwipeEnabled } from "@/lib/trackpad-preference"

import type { CanvasContext, CanvasWorkspace } from "./canvas-context"
import { CANVAS_RAIL_SPACE, type CanvasRegion, resolveMainCanvasGeometry } from "./canvas-geometry"

/**
 * A window resize delivers a new viewport width on every frame. The conversation column grows
 * with CSS while the window moves, so geometry only needs the settled width; measuring each frame
 * re-rendered the whole shell and made the track chase the pointer with its 240ms easing.
 */
const VIEWPORT_MEASURE_SETTLE_MS = 120

/**
 * The main canvas is a single flex track translated by one CSS variable. There is no carousel
 * library and no snap engine: the app's `screen` prop is the one owner of "which screen", and a
 * translate offset is derived from it. Nothing reads the DOM position back into state, so the
 * four-way write-back loop that produced white screens and a sidebar on the wrong side is gone
 * by construction (2026-11-18).
 *
 * Pointer panning (middle/side button) and three-finger swipes only *request* a neighbouring
 * screen; the same `goTo` path a click uses applies it. During a drag the track follows the
 * pointer via an ephemeral `dragOffset` ref written straight to the node — never React state.
 */
export function useMainCanvas(
  screen: "main" | "leading",
  pinned: boolean,
  onScreenChange?: (screen: "main" | "leading") => void,
  trailing = false
): {
  ref: RefCallback<HTMLDivElement>
  navigationRef: RefCallback<HTMLDivElement>
  geometry: ReturnType<typeof resolveMainCanvasGeometry>
  trackStyle: CSSProperties
  context: NonNullable<ContextType<typeof CanvasContext>>
  selected: number
  moving: boolean
  navigationPeeking: boolean
  select: (index: number) => void
  width: number
  direction: "ltr" | "rtl"
  panning: boolean
} {
  const { i18n } = useTranslation()
  const direction = i18n.dir()
  const rtl = direction === "rtl"
  const enabled = useThreeFingerSwipeEnabled()
  const viewport = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const navigation = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ viewport: 0, navigation: 0 })
  const [workspace, setWorkspace] = useState<CanvasWorkspace>({
    chat: 0,
    preview: 0,
    visible: false,
    maximized: false
  })
  const [panning, setPanning] = useState(false)
  const [navigationPeeking] = useState(false)
  const divider = useRef(false)
  const [dividerDragging, setDividerState] = useState(false)

  // The only source of truth for the visible screen. Derived from `screen`; user gestures update
  // it through `goTo`, which also notifies the app. The app echoing `screen` back is idempotent.
  const [requestedRegion, setRequestedRegion] = useState<CanvasRegion>(screen === "leading" ? "leading" : "chat")

  const geometry = useMemo(
    () =>
      resolveMainCanvasGeometry(
        { ...size, pinned, railSpace: CANVAS_RAIL_SPACE, chat: workspace.chat, preview: workspace.preview },
        trailing
      ),
    [size, pinned, workspace.chat, workspace.preview, trailing]
  )
  const regions = geometry.regions
  const requestedIndex = regions.indexOf(requestedRegion)
  const selected = requestedIndex < 0 ? 1 : requestedIndex
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const regionsRef = useRef(regions)
  regionsRef.current = regions
  const stopsRef = useRef(geometry.stops)
  stopsRef.current = geometry.stops
  const rtlRef = useRef(rtl)
  rtlRef.current = rtl
  // Snap positions are read from the real DOM, the way a carousel measures its slides. Geometry
  // arithmetic alone drifts once the sidebar collapses or a column overflows: the translate then
  // lands a sidebar-width short and a blank strip appears (2026-11-18, resolution report).
  const snapRef = useRef<number[]>([])

  const offsetFor = useCallback((index: number): number => {
    const snaps = snapRef.current
    const regionsNow = regionsRef.current
    const clamped = Math.max(0, Math.min(index, Math.max(regionsNow.length - 1, 0)))
    // Prefer a measured slide position; fall back to geometry until the first measurement lands.
    const value = snaps[clamped] !== undefined ? snaps[clamped] : (stopsRef.current[clamped] ?? 0)
    return rtlRef.current ? value : -value
  }, [])

  const readSnaps = useCallback((): void => {
    const node = track.current
    if (!node) return
    const anchors: number[] = []
    for (const region of regionsRef.current) {
      // The leading screen is anchored at the track origin by definition; it is absolutely
      // positioned inside the padding, so its offsetLeft is not a reliable snap target.
      if (region === "leading") {
        anchors.push(0)
        continue
      }
      const marked: HTMLElement | null = node.querySelector<HTMLElement>(`[data-snap-region="${region}"]`)
      const slide: HTMLElement | null =
        marked ??
        (region === "preview" ? node.querySelector<HTMLElement>(".file-workspace-preview-slide") : null) ??
        (region === "chat" ? node.querySelector<HTMLElement>(".main-sidebar-shell") : null)
      // offsetLeft is relative to the track; the same frame the carousel uses. A nested slide
      // (preview) is offset within its own parent, so accumulate up to the track.
      let position = slide?.offsetLeft ?? 0
      let parent: Element | null = slide?.offsetParent ?? null
      while (parent && parent !== node && parent instanceof HTMLElement) {
        position += parent.offsetLeft
        parent = parent.offsetParent
      }
      const logicalStart = rtlRef.current ? node.clientWidth - position - (slide?.offsetWidth ?? 0) : position
      const inset = region === "preview" && node.closest("[data-rail-show]") ? CANVAS_RAIL_SPACE : 0
      anchors.push(slide ? logicalStart - inset : (stopsRef.current[anchors.length] ?? 0))
    }
    snapRef.current = anchors
  }, [])

  // The app changed the view (a sidebar destination, a palette action). Follow it, never argue.
  useEffect(() => {
    setRequestedRegion((current) => (screen === "leading" ? "leading" : current === "leading" ? "chat" : current))
  }, [screen])

  // Measurement only feeds geometry arithmetic. A floating/collapsed sidebar reports 0px; that is
  // a presentation state, not the reader's column width, so it must not replace the stored share.
  useLayoutEffect(() => {
    const root = viewport.current
    const nav = navigation.current
    if (!root || !nav) return
    let timer: number | undefined
    const measure = (): void => {
      const nextViewport = root.clientWidth
      const nextNav = nav.offsetWidth
      setSize((current) => {
        const navigationWidth = nextNav > 0 ? nextNav : current.navigation
        return current.viewport === nextViewport && current.navigation === navigationWidth
          ? current
          : { viewport: nextViewport, navigation: navigationWidth }
      })
    }
    // Navigation width changes (collapse/expand, zoom) own the layout immediately. A viewport
    // resize is coalesced: the chat column stretches by CSS in the meantime, and only the final
    // width has to reach the navigation stops and split geometry.
    const measureNavigation = (): void => {
      window.clearTimeout(timer)
      timer = undefined
      measure()
    }
    const measureViewportWhenSettled = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = undefined
        measure()
      }, VIEWPORT_MEASURE_SETTLE_MS)
    }
    measure()
    const navigationObserver = new ResizeObserver(measureNavigation)
    navigationObserver.observe(nav)
    const viewportObserver = new ResizeObserver(measureViewportWhenSettled)
    viewportObserver.observe(root)
    return () => {
      window.clearTimeout(timer)
      navigationObserver.disconnect()
      viewportObserver.disconnect()
    }
  }, [])

  const goTo = useCallback(
    (index: number): void => {
      const clamped = Math.max(0, Math.min(index, regionsRef.current.length - 1))
      const region = regionsRef.current[clamped]
      setRequestedRegion(region)
      if (clamped !== selectedRef.current && (region === "leading" || region === "chat" || selectedRef.current === 0))
        onScreenChange?.(region === "leading" ? "leading" : "main")
    },
    [onScreenChange]
  )

  // Programmatic navigation from the workspace (opening the file tree, restoring a split).
  // It never changes which *screen* the app is on unless the target really is leading/chat.
  const navigate = useCallback(
    (region: "chat" | "preview" | "trailing"): void => {
      const index = regionsRef.current.indexOf(region)
      if (index >= 0) goTo(index)
      else if (region === "preview") setRequestedRegion(region)
    },
    [goTo]
  )

  const setDividerDragging = useCallback((dragging: boolean): void => {
    divider.current = dragging
    setDividerState(dragging)
  }, [])

  const ref = useCallback((node: HTMLDivElement | null): void => {
    viewport.current = node
    // The track is the viewport's first child. Binding it here keeps the DOM writer inside the
    // hook and avoids threading another ref through every layout host.
    track.current = node?.querySelector<HTMLDivElement>(".main-screen-track") ?? null
  }, [])
  const navigationRef = useCallback((node: HTMLDivElement | null): void => {
    navigation.current = node
  }, [])

  // ── Direct panning ────────────────────────────────────────────────────────────────────────────
  // Middle/side-button drag and three-finger swipe share one model: accumulate displacement,
  // write it straight to `track.style.transform`, and on release pick the nearest screen (with a
  // 15% flick to the neighbour). The offset never lives in React state during the gesture.
  const pan = useRef<{
    owner: "mouse" | "trackpad"
    pointerId: number | null
    button: number
    startX: number
    startOffset: number
    delta: number
    width: number
    ts: number
  } | null>(null)
  const lastGestureTs = useRef(-Infinity)
  const dragApply = useCallback((delta: number): void => {
    const node = track.current
    const active = pan.current
    if (!node || !active) return
    active.delta = delta
    node.style.transform = `translate3d(${active.startOffset + delta}px,0,0)`
    node.style.transition = "none"
  }, [])
  const endPan = useCallback(
    (cancelled = false): void => {
      const active = pan.current
      if (!active) return
      pan.current = null
      const node = track.current
      if (active.owner === "mouse" && active.pointerId !== null && node?.hasPointerCapture(active.pointerId))
        node.releasePointerCapture(active.pointerId)
      setPanning(false)
      const stops = stopsRef.current
      const base = active.startOffset
      const delta = cancelled ? 0 : active.delta
      const location = base + delta
      let nearest = 0
      for (let index = 1; index < stops.length; index += 1) {
        const candidate = offsetFor(index)
        if (Math.abs(candidate - location) < Math.abs(offsetFor(nearest) - location)) nearest = index
      }
      let target = nearest
      if (nearest === selectedRef.current && !cancelled && Math.abs(delta) > active.width * 0.15) {
        target = selectedRef.current + (delta * (rtlRef.current ? -1 : 1) < 0 ? 1 : -1)
      }
      goTo(target)
      // Hand the transform back to React. `setPanning(false)` guarantees a re-render whose
      // trackStyle writes the settled offset with the CSS transition restored. Clearing the
      // DOM style here would race that render and can leave the track stuck at the drag position.
    },
    [goTo, offsetFor]
  )
  const beginPan = useCallback(
    (owner: "mouse" | "trackpad", startX: number, width: number): boolean => {
      if (pan.current || divider.current || width <= 0) return false
      const node = track.current
      if (!node) return false
      pan.current = {
        owner,
        pointerId: null,
        button: -1,
        startX,
        startOffset: offsetFor(selectedRef.current),
        delta: 0,
        width,
        ts: 0
      }
      setPanning(true)
      return true
    },
    [offsetFor]
  )

  useEffect(() => {
    const root = viewport.current
    if (!root) return
    const isPanButton = (button: number): boolean => button === 1 || button === 3 || button === 4
    const inDragZone = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      target.closest("[data-no-drag], [role=separator], button, input, textarea, a") !== null
    const down = (event: PointerEvent): void => {
      if (!isPanButton(event.button) || inDragZone(event.target)) return
      if (!beginPan("mouse", event.clientX, root.clientWidth)) return
      const active = pan.current
      if (active) {
        active.button = event.button
        active.pointerId = event.pointerId
      }
      root.setPointerCapture(event.pointerId)
      event.preventDefault()
    }
    const move = (event: PointerEvent): void => {
      const active = pan.current
      if (!active || active.owner !== "mouse" || event.pointerId !== active.pointerId) return
      const mask = active.button === 1 ? 4 : active.button === 3 ? 8 : 16
      if (!(event.buttons & mask)) {
        endPan(false)
        return
      }
      dragApply(event.clientX - active.startX)
    }
    const up = (event: PointerEvent): void => {
      const active = pan.current
      if (active?.owner === "mouse" && event.pointerId === active.pointerId) endPan(false)
    }
    const cancel = (): void => endPan(true)
    window.addEventListener("pointerdown", down, true)
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", cancel)
    window.addEventListener("blur", cancel)
    return () => {
      window.removeEventListener("pointerdown", down, true)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", cancel)
      window.removeEventListener("blur", cancel)
    }
  }, [beginPan, dragApply, endPan])

  useEffect(() => {
    if (!apiReady(enabled)) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void events["trackpad-gesture"]
      .listen(({ payload }) => {
        if (disposed || payload.fingers !== 3) return
        if (payload.ts < lastGestureTs.current) return
        lastGestureTs.current = payload.ts
        const width = viewport.current?.clientWidth ?? 0
        if (payload.phase === "began") {
          if (pan.current?.owner === "trackpad") endPan(true)
          beginPan("trackpad", 0, width)
          return
        }
        const active = pan.current
        if (!active || active.owner !== "trackpad") return
        if (payload.phase === "changed") dragApply(payload.totalDx * width)
        else if (payload.phase === "ended") {
          dragApply(payload.totalDx * width)
          endPan(false)
        } else if (payload.phase === "cancelled") endPan(true)
      })
      .then((stop) => {
        if (disposed) stop()
        else unsubscribe = stop
      })
      .catch((error: unknown) => {
        if (!disposed) toast.error(error instanceof Error ? error.message : String(error))
      })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [enabled, beginPan, dragApply, endPan])

  // Keyboard on the focused canvas: Arrow/Home/End move one screen, like the dots do.
  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target !== node) return
      const forward = rtl ? "ArrowLeft" : "ArrowRight"
      const backward = rtl ? "ArrowRight" : "ArrowLeft"
      const current = selectedRef.current
      const target =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? regionsRef.current.length - 1
            : event.key === forward
              ? current + 1
              : event.key === backward
                ? current - 1
                : null
      if (target === null) return
      event.preventDefault()
      goTo(target)
    }
    node.addEventListener("keydown", onKeyDown)
    return () => node.removeEventListener("keydown", onKeyDown)
  }, [goTo, rtl])

  // One writer for the track transform: this effect. Pointer pans write the same property during
  // a gesture, and the next state change repositions from the settled offset. React never diffs a
  // transform value here, so a drag can't be fought by a stale style prop.
  useLayoutEffect(() => {
    const node = track.current
    if (!node || pan.current) return
    // Re-measure the real slide positions on every geometry change (window resize, sidebar
    // collapse, preview open) *before* translating. offsetLeft is layout-relative, so the current
    // transform does not contaminate it.
    readSnaps()
    node.style.transform = `translate3d(${offsetFor(selected)}px,0,0)`
  }, [
    offsetFor,
    selected,
    geometry.stops,
    geometry.content,
    panning,
    regions,
    readSnaps,
    pinned,
    rtl,
    workspace.visible
  ])

  const trackStyle = useMemo<CSSProperties>(
    () => ({ transition: panning || dividerDragging ? "none" : undefined }),
    [panning, dividerDragging]
  )

  const context = useMemo(
    () => ({
      viewportWidth: Math.max(0, size.viewport - CANVAS_RAIL_SPACE),
      budget: Math.max(0, size.viewport - (pinned ? size.navigation : CANVAS_RAIL_SPACE)),
      selected,
      trailingActive: regions[selected] === "trailing",
      split: geometry.split,
      moving: panning,
      setWorkspace,
      navigate,
      setDividerDragging
    }),
    [size, pinned, selected, regions, geometry.split, panning, navigate, setDividerDragging]
  )

  return {
    ref,
    navigationRef,
    geometry,
    trackStyle,
    context,
    selected,
    moving: panning,
    navigationPeeking,
    select: goTo,
    width: size.viewport,
    direction,
    panning
  }
}

// Gesture subscription is native-only; kept as a helper so the effect dependency stays scalar.
function apiReady(enabled: boolean): boolean {
  return enabled && isTauri()
}
