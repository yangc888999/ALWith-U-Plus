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

/**
 * Stand-in geometry for the one frame before the ResizeObserver reports real sizes. It only has to
 * produce *distinct* stops so Atlas is never constructed on three coincident anchors; the measured
 * values replace it immediately. 1280x248 matches the default window and sidebar width.
 */
const PLACEHOLDER_VIEWPORT = 1280
const PLACEHOLDER_NAVIGATION = 248

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
  /** False until the viewport and navigation have been measured; anchors are degenerate before that. */
  measured: boolean
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
  /** Set when a geometry rebuild must re-align the track even if the snap index is unchanged. */
  const realign = useRef(false)
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
  // The first render has not measured anything: `size` is {0,0}, so `resolveSplitGeometry` returns
  // leading=0 / main=0 and **every snap collapses onto offset 0**. Atlas is constructed with those
  // degenerate anchors and immediately does `goTo(initialRegion)`, settling the track on an offset
  // derived from three identical stops. When the ResizeObserver later delivers real numbers,
  // `refresh()` rebuilds the snap list but Atlas still reports the same `selected` index, so the
  // track keeps the stale offset — on screen the sidebar sits in the middle with a blank leading
  // strip to its left and chat/preview squeezed right (2026-11-16, first launch and maximising).
  //
  // Atlas requires at least one nonempty, unique region anchor at construction, so the anchors
  // cannot simply be withheld. Instead give the unmeasured frame a non-degenerate placeholder:
  // distinct stops from the very first paint, replaced by the real measurement one frame later.
  const measured = size.viewport > 0 && size.navigation > 0
  const measurement = measured ? size : { viewport: PLACEHOLDER_VIEWPORT, navigation: PLACEHOLDER_NAVIGATION }
  const geometry = useMemo(
    () => resolveMainCanvasGeometry({ ...measurement, pinned, chat: workspace.chat, preview: workspace.preview }, trailing),
    [measurement, pinned, workspace.chat, workspace.preview, trailing]
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
      // A rebuild changes where every snap physically sits. Atlas keeps its own `selected`
      // index across the rebuild, so `goToSnap(desired)` below would be a no-op whenever the
      // index happens to match — leaving the track on the pre-rebuild offset. Force the
      // alignment after a geometry change instead of trusting the index.
      realign.current = true
    }
    if (requested) region.current = request.region
    if (region.current === "preview" && !workspace.visible) region.current = "chat"
    const desired = region.current === "preview" && !geometry.split ? 1 : geometry.regions.indexOf(region.current)
    appliedRequest.current = request?.revision ?? null
    const animating = requested && !reduced() && api.getGeometry().selected !== desired
    // Never animate the correction of a stale offset: the reader did not ask to move, so the
    // track must land on the right region immediately rather than slide across the window.
    api.goToSnap(desired, { instant: !animating || realign.current })
    realign.current = false
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
  }, [api, screen, size.viewport])

  useEffect(() => {
    if (!api) return
    const select = (): void => {
      const index = api.getGeometry().selected
      setSelected(index)
      if (!rebuilding.current) {
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
      select()
      commitScreen(api.getGeometry().selected)
    }
    api.on("select", select).on("settle", settle)
    return () => {
      stop()
      api.off("select", select).off("settle", settle)
    }
  }, [api, commitScreen, geometry.regions, geometry.split])

  useEffect(() => {
    if (!api) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    if (enabled && isTauri()) {
      void events["trackpad-gesture"]
        .listen(({ payload }) => {
          if (!disposed) api.gesture(payload)
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
  }, [api, enabled])

  const select = (index: number): void => {
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
    measured,
    direction
  }
}
