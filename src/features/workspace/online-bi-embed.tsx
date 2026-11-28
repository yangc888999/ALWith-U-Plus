import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"

import { useDisplayProfile } from "@/features/profile/use-display-profile"

// Tauri commands are asynchronous. Without one shared queue, a mount that was already sent can
// finish after React unmounts this component and after cleanup sent `close`, resurrecting the old
// child WebView on whichever monitor happened to win the geometry race. Serialising mount/navigate/
// close makes "leave preview" a hard ordering guarantee: every close is after the last mount.
let nativeViewOps: Promise<unknown> = Promise.resolve()
function enqueueNativeViewOp<T>(operation: () => Promise<T>): Promise<T> {
  const next = nativeViewOps.then(operation, operation)
  nativeViewOps = next.catch(() => {})
  return next
}

// The native BI window is a singleton. The workbench page and a project's preview column can both
// mount this component while the canvas slides between screens; without an owner registry the
// unmounting copy would close the window the visible copy is using. Each mounted copy is a lease;
// the most recently visible lease owns the native window, and the window is only closed once every
// lease is gone.
type NativeLease = {
  id: symbol
  visible: boolean
  visibleAt: number
  sync: () => void
}

type OnlineBiPageLoadEvent = {
  phase: "started" | "finished"
  signedIn: boolean
  url: string
}

export type OnlineBiPageState = {
  ready: boolean
  signedIn: boolean
  url: string
}

const leases = new Map<symbol, NativeLease>()
let activeLease: symbol | null = null
let visibilityClock = 0

function pickVisibleLease(): NativeLease | null {
  let chosen: NativeLease | null = null
  for (const lease of leases.values()) {
    if (!lease.visible) continue
    if (chosen === null || lease.visibleAt > chosen.visibleAt) chosen = lease
  }
  return chosen
}

function publishLeaseVisibility(): void {
  const next = pickVisibleLease()
  activeLease = next?.id ?? null
  if (next !== null) {
    next.sync()
    return
  }
  if (leases.size === 0) return
  void enqueueNativeViewOp(() => invoke("online_bi_embed_set_visible", { visible: false })).catch(() => {})
}

function markLeaseVisibility(id: symbol, visible: boolean): void {
  const lease = leases.get(id)
  if (lease === undefined) return
  if (visible) {
    lease.visible = true
    lease.visibleAt = ++visibilityClock
  } else {
    lease.visible = false
  }
  publishLeaseVisibility()
}

function releaseLease(id: symbol): void {
  leases.delete(id)
  if (leases.size === 0) {
    activeLease = null
    void enqueueNativeViewOp(() => invoke("online_bi_embed_close")).catch(() => {})
    return
  }
  if (activeLease === id) {
    activeLease = null
    publishLeaseVisibility()
  }
}

/**
 * The dashboard, rendered by a native child webview instead of an iframe.
 *
 * Why: the BI session lives in cookies, and WKWebView refuses cookies inside a cross-site frame —
 * reads come back empty, writes fail silently, and the server's `Set-Cookie` never lands. A child
 * webview is a top-level document on `bi.finture.id`, so its cookie jar is first-party and the
 * login survives. This component only measures the slot: the native view is positioned above it
 * with logical (CSS) pixels, because the main webview's origin is the window's content origin.
 *
 * The native window is not part of the DOM, so CSS cannot hide it when the canvas slides the page
 * off-screen. An IntersectionObserver hides it as soon as its slot is less than three quarters
 * visible, and the host passes the app's resolved theme so the third-party page follows light/dark.
 */
export function OnlineBiNativeView({
  src,
  reload = 0,
  hidden = false,
  theme = "light",
  onPageState
}: {
  src: string
  reload?: number
  /** Hide the native child while a host dialog needs to sit above it. The cookie jar stays alive. */
  hidden?: boolean
  /** The host app's resolved appearance. */
  theme?: "light" | "dark"
  /** Reports loading and sign-in changes from the native BI document. */
  onPageState?: (state: OnlineBiPageState) => void
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const leaseId = useRef(Symbol("online-bi-native-view"))
  // The board asks for the same address we are already signed in with; hand it over so the login
  // form arrives filled instead of making the reader retype it.
  const email = useDisplayProfile()?.email ?? null
  const emailRef = useRef(email)
  const srcRef = useRef(src)
  const themeRef = useRef(theme)
  const onPageStateRef = useRef(onPageState)
  const pageReady = useRef(false)
  const syncRef = useRef<(() => void) | null>(null)
  const fallbackTimer = useRef<number | null>(null)
  const alive = useRef(true)
  const firstLoad = useRef(true)
  emailRef.current = email
  srcRef.current = src
  themeRef.current = theme
  onPageStateRef.current = onPageState
  // A real IntersectionObserver starts false and reports the current intersection immediately. In
  // environments without one (tests) keep the old always-visible behaviour.
  const [slotVisible, setSlotVisible] = useState(() => typeof IntersectionObserver === "undefined")

  const clearFallback = useCallback((): void => {
    if (fallbackTimer.current !== null) {
      window.clearTimeout(fallbackTimer.current)
      fallbackTimer.current = null
    }
  }, [])

  const settleFromNativeState = useCallback((): void => {
    void invoke<{ signedIn: boolean; url: string }>("online_bi_embed_page_state")
      .then((state) => {
        if (!alive.current) return
        clearFallback()
        pageReady.current = true
        onPageStateRef.current?.({ ready: true, signedIn: state.signedIn, url: state.url })
        syncRef.current?.()
      })
      .catch(() => {
        if (!alive.current) return
        clearFallback()
        pageReady.current = true
        onPageStateRef.current?.({ ready: true, signedIn: false, url: "" })
        syncRef.current?.()
      })
  }, [clearFallback])

  const beginLoading = useCallback((): void => {
    pageReady.current = false
    onPageStateRef.current?.({ ready: false, signedIn: false, url: "" })
    clearFallback()
    fallbackTimer.current = window.setTimeout(settleFromNativeState, 6_000)
    void enqueueNativeViewOp(() => invoke("online_bi_embed_set_visible", { visible: false })).catch(() => {})
  }, [clearFallback, settleFromNativeState])

  // The native window emits this from its page-load hook. Register before mounting so the first
  // `finished` event cannot be lost; a six-second state probe covers a missed event.
  useEffect(() => {
    let stopped = false
    let unlisten: (() => void) | null = null
    void listen<OnlineBiPageLoadEvent>("online-bi-embed:page-load", (event) => {
      if (stopped) return
      if (event.payload.phase === "started") {
        beginLoading()
        return
      }
      clearFallback()
      pageReady.current = true
      onPageStateRef.current?.({
        ready: true,
        signedIn: event.payload.signedIn,
        url: event.payload.url
      })
      syncRef.current?.()
    })
      .then((stop) => {
        if (stopped) stop()
        else unlisten = stop
      })
      .catch((error: unknown) => console.error("[online-bi] page-load", error))
    return () => {
      stopped = true
      unlisten?.()
    }
  }, [beginLoading, clearFallback])

  useEffect(() => {
    const element = host.current
    if (element === null) return
    alive.current = true
    let frame = 0
    let disposed = false
    const id = leaseId.current
    const sync = (): void => {
      cancelAnimationFrame(frame)
      // A split-drag changes the rect every frame; coalesce to one IPC per painted frame.
      frame = requestAnimationFrame(() => {
        if (disposed || activeLease !== id) return
        const lease = leases.get(id)
        if (lease === undefined || !lease.visible) return
        const box = element.getBoundingClientRect()
        if (box.width < 2 || box.height < 2) {
          void enqueueNativeViewOp(() => invoke("online_bi_embed_set_visible", { visible: false })).catch(() => {})
          return
        }
        void enqueueNativeViewOp(() =>
          invoke("online_bi_embed_mount", {
            url: srcRef.current,
            x: box.left,
            y: box.top,
            width: box.width,
            height: box.height,
            email: emailRef.current,
            theme: themeRef.current,
            visible: pageReady.current
          })
        )
          .then(() => {
            if (disposed) return
            if (activeLease !== id) {
              // A newer lease became visible while this mount was in flight; let it reassert its
              // geometry instead of leaving the old slot's mount on top.
              const current = activeLease === null ? null : leases.get(activeLease)
              if (current !== undefined && current !== null) current.sync()
              return
            }
            if (!leases.get(id)?.visible) {
              void enqueueNativeViewOp(() => invoke("online_bi_embed_set_visible", { visible: false })).catch(() => {})
            }
          })
          .catch((error: unknown) => console.error("[online-bi] mount", error))
      })
    }
    syncRef.current = sync
    leases.set(id, { id, visible: false, visibleAt: 0, sync })
    sync()
    if (!pageReady.current) beginLoading()
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync)
    resizeObserver?.observe(element)
    window.addEventListener("resize", sync)
    const visibilityObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              const entry = entries[entries.length - 1]
              setSlotVisible(
                entry !== undefined &&
                  entry.isIntersecting &&
                  entry.intersectionRatio >= 0.75 &&
                  entry.intersectionRect.width >= 2 &&
                  entry.intersectionRect.height >= 2
              )
            },
            { threshold: 0.75 }
          )
    visibilityObserver?.observe(element)
    return () => {
      disposed = true
      alive.current = false
      cancelAnimationFrame(frame)
      clearFallback()
      resizeObserver?.disconnect()
      visibilityObserver?.disconnect()
      window.removeEventListener("resize", sync)
      syncRef.current = null
      releaseLease(id)
    }
    // `src` is read on mount only; later changes navigate (see below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beginLoading, clearFallback])

  // A new URL — or the refresh button — navigates the existing view. Same URL navigates to
  // itself, which reloads the page without touching the cookie jar.
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false
      return
    }
    beginLoading()
    void enqueueNativeViewOp(() => invoke("online_bi_embed_navigate", { url: src })).catch((error: unknown) =>
      console.error("[online-bi] navigate", error)
    )
  }, [beginLoading, src, reload])

  // Dialog opening/closing and the canvas moving the slot off-screen both take this path.
  useEffect(() => {
    markLeaseVisibility(leaseId.current, !hidden && slotVisible)
  }, [hidden, slotVisible])

  useEffect(() => {
    void enqueueNativeViewOp(() => invoke("online_bi_embed_set_theme", { theme })).catch(() => {})
  }, [theme])

  return <div ref={host} className="h-full w-full bg-background" />
}
