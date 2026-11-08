/**
 * 「在线 BI」 — the company BI dashboard, opened from the sidebar in its own window.
 *
 * It is not an extension (BI 指标 comes from the extension host); this is one fixed URL the app
 * hosts itself, mounted in the same preview slot so it reads like its sibling.
 *
 * The login lives in the app's own cookie store, which is populated by the standalone window
 * (`openOnlineBiWindow`, still one click away in the preview header). An embedded frame alone cannot
 * finish that flow: the OAuth hand-off is a cross-site navigation and WKWebView drops the session
 * cookie for third-party frames. Instead the board restores a session from `?s=<JWT>`, the same trick
 * the BI Metrics extension uses — so once the standalone window has signed in, we read that token out
 * of its URL and hand it to the frame, and the frame opens already signed in.
 */
import { usePlatformAuth } from "@/features/auth/store"

export const ONLINE_BI_VIEW_ID = "alwith:online-bi"
// Open the board itself (not the bare portal root): after sign-in Streamlit appends ?s=<JWT> here,
// which is exactly what the embedded frame needs. The root / is a separate portal and ignores it.
export const ONLINE_BI_URL = "https://bi.finture.id/personal_dashboard?embed=true&embed_options=show_padding"
/** Which page the preview column opens: `/personal_dashboard` unless the reader changed it. */
export const ONLINE_BI_PATH_KEY = "alwith:online-bi-path"

export function storedOnlineBiPath(): string {
  const value = localStorage.getItem(ONLINE_BI_PATH_KEY)?.trim() ?? ""
  return value === "" ? "/personal_dashboard" : value
}

export function saveOnlineBiPath(path: string): void {
  localStorage.setItem(ONLINE_BI_PATH_KEY, path.trim())
}

/** Mirrors the switch in 设置 → 在线 BI; `off` disables the automatic fill. */
export const AUTOLOGIN_KEY = "alwith:online-bi-autologin"

/**
 * Waits for the sign-in in the standalone window to land, then reports it.
 *
 * The reliable signal that the board is authenticated is `?s=<JWT>` appearing in the URL — Streamlit
 * appends it after a successful sign-in. Returns `false` on timeout or when the user closed the window
 * first; the caller reloads the frame either way, since a live token may already be there.
 */
export async function waitForOnlineBiLogin(timeoutMs = 120_000): Promise<boolean> {
  const { invoke } = await import("@tauri-apps/api/core")
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    let url: string | null = null
    try {
      url = await invoke<string | null>("online_bi_window_url")
    } catch {
      return false
    }
    if (url === null) return false
    try {
      const parsed = new URL(url)
      // Still on a login/authorize screen → not done yet.
      if (/login|sign-?in|auth/i.test(parsed.pathname)) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        continue
      }
      // Authenticated == the dashboard URL now carries the session token.
      const token = parsed.searchParams.get("s")
      if (token && token.length > 0) return true
    } catch {
      /* not a parseable URL yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return false
}

/** Closes the sign-in window once the frame can take over. */
export async function closeOnlineBiWindow(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow")
  const existing = await WebviewWindow.getByLabel("online-bi")
  if (existing !== null) await existing.close().catch(() => {})
}

/** Opens the dashboard as its own window: a top-level webview keeps first-party cookies, so the
 *  login survives restarts even when the embedded frame cannot hold a third-party session. */
export async function openOnlineBiWindow(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core")
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow")
  const existing = await WebviewWindow.getByLabel("online-bi")
  if (existing !== null) {
    await existing.unminimize()
    await existing.show()
    await existing.setFocus()
    return
  }
  const dashboard = new WebviewWindow("online-bi", {
    url: ONLINE_BI_URL,
    title: "在线 BI",
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    center: true,
    hiddenTitle: !navigator.platform.includes("Win"),
    titleBarStyle: navigator.platform.includes("Win") ? "visible" : "overlay",
    visible: false
  })
  let ready!: () => void
  let fail!: (error: Error) => void
  const created = new Promise<void>((resolve, reject) => {
    ready = resolve
    fail = reject
  })
  const listeners: (() => void)[] = []
  const timer = setTimeout(() => fail(new Error("Online BI window creation timed out")), 15_000)
  try {
    await Promise.all([
      created,
      dashboard.once("tauri://created", ready).then((stop) => listeners.push(stop)),
      dashboard.once("tauri://error", ({ payload }) => fail(new Error(String(payload)))).then((stop) => listeners.push(stop))
    ])
  } finally {
    clearTimeout(timer)
    for (const stop of listeners) stop()
  }
  // Created hidden so the first frame is not a white flash; nothing else brings it on screen.
  await dashboard.show()
  await dashboard.setFocus()
  // The dashboard is a single-page app: the form appears after its own bundle boots, and a redirect
  // may mount a second one. Retry a few times instead of guessing one delay.
  if (localStorage.getItem(AUTOLOGIN_KEY) !== "off") {
    // When the BI session is not stored yet, prefill the account with the email the user signed in
    // to the app with, so they only need to type the password — never auto-submit a guessed account.
    const account = usePlatformAuth.getState().user?.login_email ?? null
    for (const delay of [2500, 6000, 11000]) {
      setTimeout(() => {
        void invoke("online_bi_autofill", { account }).catch((error: unknown) => {
          console.warn("[online-bi] autofill", error)
        })
      }, delay)
    }
  }
}

/**
 * Reads the live `?s=<JWT>` token out of the signed-in standalone window and persists it so the
 * embedded frame (and future launches) open already signed in. Returns the token, or null when no
 * window is open, it has not signed in, or its URL carries no token.
 */
export async function extractOnlineBiToken(): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core")
  let url: string | null = null
  try {
    url = await invoke<string | null>("online_bi_window_url")
  } catch {
    return null
  }
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (/login|sign-?in|auth/i.test(parsed.pathname)) return null
    const token = parsed.searchParams.get("s")
    if (token && token.length > 0) {
      await invoke("online_bi_credentials_save_token", { token }).catch(() => {})
      return token
    }
  } catch {
    /* not a parseable URL */
  }
  return null
}

/**
 * The embeddable URL for the preview column.
 *
 * Prefers a stored token; if none is stored (or it is a mis-paste of the page path) but the
 * standalone sign-in window is already authenticated, reuse its live `?s=` token so the frame opens
 * signed in without the user copy-pasting anything.
 */
export async function getOnlineBiEmbedSrc(): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core")
  // The stored credentials decide the origin and the token; the page comes from the local setting,
  // so changing it never needs the keychain round-trip.
  const base = withStoredPath(await invoke<string>("online_bi_embed_url"))
  // A real token is a long JWT-ish string; a path like /personal_dashboard is a common mis-paste
  // that would make the embed fail silently, so treat it as "no usable token" and try the window.
  const storedToken = base.match(/[?&]s=([^&]*)/)?.[1] ?? ""
  const storedLooksValid = storedToken.length > 16 && !/^\/|personal_dashboard/i.test(storedToken)
  if (storedLooksValid) return base
  const token = await extractOnlineBiToken()
  if (token) {
    const separator = base.includes("?") ? "&" : "?"
    return `${base}${separator}s=${encodeURIComponent(token)}`
  }
  return base
}

/**
 * Opens the standalone sign-in window, waits for the dashboard to load, pulls the session token out
 * of the resulting URL, persists it for the embedded frame, and closes the window. Returns the token,
 * or null if the user did not finish signing in (the window stays open so they can retry).
 */
export async function openOnlineBiLogin(): Promise<string | null> {
  await openOnlineBiWindow()
  const ok = await waitForOnlineBiLogin()
  if (!ok) return null
  const token = await extractOnlineBiToken()
  if (token) await closeOnlineBiWindow().catch(() => {})
  return token
}

/**
 * The same URL with any `?s=<JWT>` removed.
 *
 * The embedded dashboard signs itself in through its own login screen; the token is only the
 * shortcut the standalone window can capture. Loading without it is the default so a stale token
 * can never be the reason a frame looks broken.
 */
export function stripOnlineBiToken(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete("s")
    return parsed.toString()
  } catch {
    return url
  }
}

/** Keeps the origin and query of `url`, swaps the path for the one stored in settings. */
function withStoredPath(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.pathname = storedOnlineBiPath()
    return parsed.toString()
  } catch {
    return url
  }
}
