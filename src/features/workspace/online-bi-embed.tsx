import { type ReactNode, useEffect, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"

import { useDisplayProfile } from "@/features/profile/use-display-profile"

/**
 * The dashboard, rendered by a native child webview instead of an iframe.
 *
 * Why: the BI session lives in cookies, and WKWebView refuses cookies inside a cross-site frame —
 * reads come back empty, writes fail silently, and the server's `Set-Cookie` never lands. A child
 * webview is a top-level document on `bi.finture.id`, so its cookie jar is first-party and the
 * login survives. This component only measures the slot: the native view is positioned above it
 * with logical (CSS) pixels, because the main webview's origin is the window's content origin.
 */
export function OnlineBiNativeView({ src, reload = 0 }: { src: string; reload?: number }): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  // The board asks for the same address we are already signed in with; hand it over so the login
  // form arrives filled instead of making the reader retype it.
  const email = useDisplayProfile()?.email ?? null
  const mounted = useRef(false)

  // Mount once. Re-creating the view on every URL change would hand out a fresh cookie jar and
  // silently drop the session, which is exactly the failure this replaced.
  useEffect(() => {
    const element = host.current
    if (element === null) return
    let frame = 0
    let disposed = false
    const sync = (): void => {
      cancelAnimationFrame(frame)
      // A split-drag changes the rect every frame; coalesce to one IPC per painted frame.
      frame = requestAnimationFrame(() => {
        if (disposed) return
        const box = element.getBoundingClientRect()
        if (box.width < 2 || box.height < 2) {
          void invoke("online_bi_embed_set_visible", { visible: false }).catch(() => {})
          return
        }
        void invoke("online_bi_embed_mount", {
          url: src,
          x: box.left,
          y: box.top,
          width: box.width,
          height: box.height,
          email
        })
          .then(() => {
            mounted.current = true
          })
          .catch((error: unknown) => console.error("[online-bi] mount", error))
      })
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    window.addEventListener("resize", sync)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("resize", sync)
      mounted.current = false
      void invoke("online_bi_embed_close").catch(() => {})
    }
    // `src` is read on mount only; later changes navigate (see below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A new URL — or the refresh button — navigates the existing view. Same URL navigates to
  // itself, which reloads the page without touching the cookie jar.
  useEffect(() => {
    if (!mounted.current) return
    void invoke("online_bi_embed_navigate", { url: src }).catch((error: unknown) =>
      console.error("[online-bi] navigate", error)
    )
  }, [src, reload])

  return <div ref={host} className="h-full w-full bg-background" />
}
