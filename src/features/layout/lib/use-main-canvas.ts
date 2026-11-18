import { useAtlas } from "@nyssance/atlas/react"
import { isTauri } from "@tauri-apps/api/core"
import {
  type ContextType,
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
import { resolveMainCanvasGeometry } from "./canvas-geometry"

export function useMainCanvas(
  screen: "main" | "leading",
  pinned: boolean,
  onScreenChange?: (screen: "main" | "leading") => void,
  trailing = false
): {
  ref: RefCallback<HTMLDivElement>
  navigationRef: RefCallback<HTMLDivElement>
  geometry: ReturnType<typeof resolveMainCanvasGeometry>
  context: NonNullable<ContextType<typeof CanvasContext>>
  selected: number
  moving: boolean
  navigationPeeking: boolean
  select: (index: number) => void
  width: number
  direction: "ltr" | "rtl"
} {
  const { i18n } = useTranslation()
  const direction = i18n.dir()
  // Direction changes are rebuilt with geometry, before restoring the semantic region.
  const [initialDirection] = useState(direction)
  const enabled = useThreeFingerSwipeEnabled()
  const viewport = useRef<HTMLDivElement>(null)
  const navigation = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ viewport: 0, navigation: 0 })
  const [workspace, setWorkspace] = useState<CanvasWorkspace>({
    chat: 0,
    preview: 0,
    visible: false,
    maximized: false
  })
  const [selected, setSelected] = useState(screen === "leading" ? 0 : 1)
  const [moving, setMoving] = useState(false)
  const settledSelection = useRef(selected)
  useLayoutEffect(() => {
    if (!moving) settledSelection.current = selected
  }, [moving, selected])
  const [navigationPeeking, setNavigationPeeking] = useState(false)
  const divider = useRef(false)
  const [dividerDragging, setDividerState] = useState(false)
  const appliedGeometry = useRef<string | null>(null)
  /**
   * Launch has exactly one landing: the conversation. Until the canvas has a measured geometry
   * and is demonstrably parked on the chat snap, every Atlas reading is geometry noise. Writing
   * such a reading back to the app's `view` is what parked the window on the management screen
   * with the sidebar on the far side (2026-11-18). The lock is released only by an explicit user
   * navigation (click, drag, swipe, keyboard), never by a programmatic settle, so neither a cold
   * `selected=0` nor a post-rebuild settle can ever latch the wrong screen.
   */
  const bootLocked = useRef(true)
  const [request, setRequest] = useState<{
    region: "chat" | "preview" | "trailing"
    revision: number
  } | null>(null)
  const appliedRequest = useRef<number | null>(null)
  const region = useRef<"leading" | "chat" | "preview" | "trailing">(screen === "leading" ? "leading" : "chat")
  const rebuilding = useRef(false)
  const previousScreen = useRef(screen)
  const [initialIndex] = useState(screen === "leading" ? 0 : 1)
  const callbacks = useRef({ onScreenChange, screen })
  useLayoutEffect(() => {
    callbacks.current = { onScreenChange, screen }
  }, [onScreenChange, screen])
  const geometry = useMemo(
    () => resolveMainCanvasGeometry({ ...size, pinned, chat: workspace.chat, preview: workspace.preview }, trailing),
    [size, pinned, workspace.chat, workspace.preview, trailing]
  )
  const geometryKey = `${geometry.stops.join(":")}:${geometry.content}:${direction}`
  const { ref: atlasRef, atlas: api } = useAtlas({
    regions: ".canvas-snap",
    direction: initialDirection,
    contain: false,
    groupRegions: false,
    initialRegion: initialIndex === 0 ? "leading" : "chat",
    watchResize: false,
    watchRegions: false,
    manageInert: false,
    // Changing this option rebuilds Atlas. Defer docking until motion settles.
    navigationPinned: pinned && (moving ? settledSelection.current : selected) === 1,
    // No hover peek: the collapsed sidebar carries its own icon rail, so sliding the panel out
    // under the pointer duplicated the same destinations and fought the rail for the edge.
    // Expanding is an explicit click (a rail entry or the title-bar pin toggle).
    hoverNavigation: false,
    navigationWidth: size.navigation || 248,
    onNavigationChange: setNavigationPeeking,
    trackpadEnabled: enabled,
    trackpadAvailable: enabled && isTauri(),
    blocked: () => divider.current
  })
  const navigationRef = useCallback((node: HTMLDivElement | null): void => {
    navigation.current = node
  }, [])
  const reduced = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const ref = useCallback(
    (node: HTMLDivElement | null): void => {
      viewport.current = node
      atlasRef(node)
    },
    [atlasRef]
  )

  useLayoutEffect(() => {
    const root = viewport.current
    const nav = navigation.current
    if (!root || !nav) return
    const measure = (): void => {
      const next = { viewport: root.clientWidth, navigation: nav.offsetWidth }
      setSize((current) =>
        current.viewport === next.viewport && current.navigation === next.navigation ? current : next
      )
    }
    measure()
    // Avoid flushSync: React batches the size update to the next frame on its own, so resizing
    // or dragging the divider no longer forces a synchronous render that blocks the main thread.
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(nav)
    return () => observer.disconnect()
  }, [])

  const commitScreen = useCallback((index: number): void => {
    const next = index === 0 ? "leading" : "main"
    previousScreen.current = next
    if (next !== callbacks.current.screen) callbacks.current.onScreenChange?.(next)
  }, [])
  /**
   * A launch always lands on the conversation, never on whatever screen the canvas happened to
   * measure first.
   *
   * The canvas is a horizontal track whose stops depend on CSS variables written by the same render
   * that settles it, so the first measurement of a fresh window is not trustworthy: it can report
   * the leading screen (or a half-built track) and the window then rests on blank paper with the
   * sidebar over on the far side until something forces a re-measure. Chasing each such race is
   * losing game — the product rule is simpler than the machinery: **every launch opens the new
   * conversation**, with the sidebar and the chat column, and only an explicit click may move it
   * elsewhere (2026-11-18).
   *
   * So once there is a real width to work with, park on the conversation exactly once. A later
   * settle (a click, a drag, a divider release) is the reader's own, and this never runs again.
   */
  const openedOnConversation = useRef(false)
  useLayoutEffect(() => {
    if (openedOnConversation.current || !api || size.viewport === 0) return
    const index = geometry.regions.indexOf("chat")
    if (index < 0) return
    openedOnConversation.current = true
    region.current = "chat"
    api.refresh({ direction })
    api.goToSnap(index, { instant: true })
    setSelected(index)
    commitScreen(index)
  }, [api, size.viewport, geometry.regions, direction, commitScreen])

  // The moment an explicit navigation happens the reader has taken over; from then on Atlas is
  // the authority for the current screen and the boot lock no longer applies.
  const releaseBootLock = useCallback((): void => {
    if (!bootLocked.current) return
    bootLocked.current = false
  }, [])

  // Deliberately does NOT release the boot lock. The workspace panel fires `navigate("preview")`
  // by itself while a project loads on launch; treating that as "the reader took over" would open
  // the gate for the cold snap-0 settle to relay the window to the leading screen. A real user
  // navigation reaches `view` through the screen effect or `select`, both of which do release it.
  const navigate = useCallback((region: "chat" | "preview" | "trailing"): void => {
    setRequest((current) => ({ region, revision: (current?.revision ?? 0) + 1 }))
  }, [])
  const setDividerDragging = useCallback(
    (dragging: boolean): void => {
      divider.current = dragging
      setDividerState(dragging)
      if (dragging) api?.cancelInput()
    },
    [api]
  )

  useLayoutEffect(() => {
    if (!api || size.viewport === 0 || dividerDragging) return
    const requested = request !== null && appliedRequest.current !== request.revision
    const geometryChanged = appliedGeometry.current !== geometryKey
    if (!geometryChanged && !requested) return
    api?.cancelInput()
    rebuilding.current = true
    if (geometryChanged) {
      api.refresh({ direction })
      appliedGeometry.current = geometryKey
    }
    if (requested) region.current = request.region
    if (region.current === "preview" && !workspace.visible) region.current = "chat"
    const desired = region.current === "preview" && !geometry.split ? 1 : geometry.regions.indexOf(region.current)
    appliedRequest.current = request?.revision ?? null
    const animating = requested && !reduced() && api.getGeometry().selected !== desired
    api.goToSnap(desired, { instant: !animating })
    rebuilding.current = false
    if (requested) commitScreen(desired)
    setSelected(desired)
    setMoving(animating)
  }, [
    api,
    direction,
    geometryKey,
    geometry.stops.length,
    geometry.regions,
    geometry.split,
    workspace.visible,
    size.viewport,
    request,
    commitScreen,
    dividerDragging
  ])

  useEffect(() => {
    if (!api) return
    if (previousScreen.current !== screen) {
      // The app itself changed the view (a sidebar destination such as plugins/settings). That is
      // an explicit navigation, so the launch lock no longer applies from this point on.
      releaseBootLock()
      region.current = screen === "leading" ? "leading" : "chat"
      api?.cancelInput()
      const target = screen === "leading" ? 0 : 1
      const animating =
        size.viewport > 0 &&
        !reduced() &&
        target < api.getGeometry().snaps.length &&
        api.getGeometry().selected !== target
      setMoving(animating)
      api.goToSnap(target, { instant: !animating })
    }
    previousScreen.current = screen
  }, [api, screen, size.viewport, releaseBootLock])

  useEffect(() => {
    if (!api) return
    const select = (): void => {
      const index = api.getGeometry().selected
      // A cold Atlas reading is a measurement artefact, not the reader's intent. Until the reader
      // navigates explicitly, a snap-0 report must never latch the region to `leading`: every later
      // rebuild would then aim there and the window would sit on blank paper with the sidebar
      // stranded on the far side (2026-11-18, first launch on a MacBook Air).
      if (bootLocked.current) return
      setSelected(index)
      if (!rebuilding.current && appliedGeometry.current !== null) {
        const selectedRegion = geometry.regions[index]
        if (
          selectedRegion !== undefined &&
          !(selectedRegion === "chat" && region.current === "preview" && !geometry.split)
        )
          region.current = selectedRegion
      }
    }
    const stop = api.subscribe((state) => setMoving(state.moving))
    const settle = (): void => {
      setMoving(false)
      // During the launch lock every Atlas settle is either the cold snap-0 measurement or a
      // programmatic consequence of the landing/geometry rebuild — never a reader decision. Both
      // handlers stay silent so `view` and `region.current` remain on chat. Only the explicit-intent
      // paths release the lock; after that Atlas is authoritative again.
      if (bootLocked.current) return
      select()
      commitScreen(api.getGeometry().selected)
    }
    // Pointer-down on the canvas is an unambiguous user intent, so it ends the launch lock even
    // before a settle arrives — otherwise a reader who drags before the landing settle would be
    // ignored and the view would not follow their drag.
    const pointerDown = (): void => releaseBootLock()
    api.on("select", select).on("settle", settle).on("pointerDown", pointerDown)
    return () => {
      stop()
      api.off("select", select).off("settle", settle).off("pointerDown", pointerDown)
    }
  }, [api, commitScreen, geometry.regions, geometry.split, releaseBootLock])

  useEffect(() => {
    if (!api) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    if (enabled && isTauri()) {
      void events["trackpad-gesture"]
        .listen(({ payload }) => {
          if (!disposed) {
            // A swipe is an explicit navigation. From here Atlas reflects the reader, not a cold
            // measurement, so the launch lock must not suppress its settle any more.
            releaseBootLock()
            api.gesture(payload)
          }
        })
        .then((stop) => {
          if (disposed) stop()
          else unsubscribe = stop
        })
        .catch((error: unknown) => {
          if (!disposed) toast.error(error instanceof Error ? error.message : String(error))
        })
    }
    return () => {
      disposed = true
      unsubscribe?.()
      api.cancelInput()
    }
  }, [api, enabled, releaseBootLock])

  useEffect(() => {
    const node = viewport.current
    if (!node) return
    // Atlas handles Arrow/Home/End on the focused canvas and reports the move only through
    // `settle` (no pointerDown). Without this, keyboard navigation right after launch would be
    // swallowed by the boot lock until the first click. A navigation key is explicit intent.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target !== node) return
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
      releaseBootLock()
    }
    node.addEventListener("keydown", onKeyDown)
    return () => node.removeEventListener("keydown", onKeyDown)
  }, [api, releaseBootLock])

  const select = (index: number): void => {
    releaseBootLock()
    if (api?.getGeometry().selected === index) return
    api?.cancelInput()
    const target = geometry.regions[index]
    if (target === undefined) throw new Error("Unknown canvas region")
    region.current = target
    const animating =
      size.viewport > 0 &&
      !!api &&
      !reduced() &&
      index < api.getGeometry().snaps.length &&
      api.getGeometry().selected !== index
    setMoving(animating)
    api?.goToSnap(index, { instant: !animating })
    commitScreen(index)
  }
  const context = useMemo(
    () => ({
      viewportWidth: size.viewport,
      budget: Math.max(0, size.viewport - (pinned ? size.navigation : 0)),
      selected,
      trailingActive: geometry.regions[selected] === "trailing",
      split: geometry.split,
      moving,
      setWorkspace,
      navigate,
      setDividerDragging
    }),
    [size, pinned, selected, geometry.split, geometry.regions, moving, navigate, setDividerDragging]
  )
  return {
    ref,
    navigationRef,
    geometry,
    context,
    selected,
    moving,
    navigationPeeking,
    select,
    width: size.viewport,
    direction
  }
}
