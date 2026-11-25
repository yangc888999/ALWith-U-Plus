/**
 * 「在线 BI」 — the company BI dashboard, opened from the sidebar in the preview column.
 *
 * It is not an extension (BI 指标 comes from the extension host); this is one fixed URL the app
 * hosts itself, mounted in the same preview slot so it reads like its sibling.
 *
 * The board restores a session from `?s=<JWT>`, the same trick the BI Metrics extension uses. The
 * embedded URL is built from the stored token and page, and a live token is reused when a BI window
 * is already open.
 */
export const ONLINE_BI_VIEW_ID = "alwith:online-bi"
// Open the board itself (not the bare portal root): after sign-in Streamlit appends ?s=<JWT> here,
// which is exactly what the embedded frame needs. The root / is a separate portal and ignores it.
export const ONLINE_BI_URL = "https://bi.finture.id/personal_dashboard?embed=true&embed_options=show_padding"
/** Which page the preview column opens: `/personal_dashboard` unless the reader changed it. */
const ONLINE_BI_PATH_KEY = "alwith:online-bi-path"

function storedOnlineBiPath(): string {
  const value = localStorage.getItem(ONLINE_BI_PATH_KEY)?.trim() ?? ""
  return value === "" ? "/personal_dashboard" : value
}

export function saveOnlineBiPath(path: string): void {
  localStorage.setItem(ONLINE_BI_PATH_KEY, path.trim())
}

/** Closes the sign-in window once the frame can take over. */
export async function closeOnlineBiWindow(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow")
  const existing = await WebviewWindow.getByLabel("online-bi")
  if (existing !== null) await existing.close().catch(() => {})
}

/**
 * Reads the live `?s=<JWT>` token out of the signed-in standalone window and persists it so the
 * embedded frame (and future launches) open already signed in. Returns the token, or null when no
 * window is open, it has not signed in, or its URL carries no token.
 */
async function extractOnlineBiToken(): Promise<string | null> {
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
