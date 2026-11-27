/**
 * 「在线 BI」 — the company BI dashboard, opened as a full workbench page.
 *
 * It is not an extension (BI 指标 comes from the extension host); the workbench page owns the
 * native view directly so tabs, address navigation and the report session share one cookie jar.
 *
 * The board restores a session from `?s=<JWT>`, the same trick the BI Metrics extension uses. The
 * embedded URL is built from the stored token and page, and a live token is reused when a BI window
 * is already open.
 */
export const ONLINE_BI_VIEW_ID = "alwith:online-bi"
const ONLINE_BI_ORIGIN = "https://bi.finture.id"
const ONLINE_BI_DEFAULT_REPORT_URL = `${ONLINE_BI_ORIGIN}/personal_dashboard`
// Open the board itself (not the bare portal root): after sign-in Streamlit appends ?s=<JWT> here,
// which is exactly what the embedded frame needs. The root / is a separate portal and ignores it.
export const ONLINE_BI_URL = `${ONLINE_BI_DEFAULT_REPORT_URL}?embed=true&embed_options=show_padding`
/** Which page the preview column opens: `/personal_dashboard` unless the reader changed it. */
const ONLINE_BI_PATH_KEY = "alwith:online-bi-path"

function storedOnlineBiPath(): string {
  const value = localStorage.getItem(ONLINE_BI_PATH_KEY)?.trim() ?? ""
  return value === "" ? "/personal_dashboard" : value
}

export function saveOnlineBiPath(path: string): void {
  localStorage.setItem(ONLINE_BI_PATH_KEY, path.trim())
}

/** Normalize a full URL or a path pasted into 在线 BI. Tokens and embed-only flags never persist. */
export function normalizeOnlineBiReportUrl(raw: string): string | null {
  let value = raw.trim()
  if (value === "") return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (value.startsWith("/") || value.startsWith("?") || !value.includes(".")) {
      value = `${ONLINE_BI_ORIGIN}/${value.replace(/^\/+/, "")}`
    } else {
      value = `https://${value}`
    }
  }
  try {
    const parsed = new URL(value)
    if (parsed.hostname !== "bi.finture.id") return null
    parsed.searchParams.delete("s")
    parsed.searchParams.delete("embed")
    parsed.searchParams.delete("embed_options")
    return parsed.toString()
  } catch {
    return null
  }
}

/** The address the native view should load: normalized report URL plus Streamlit's embed switches. */
export function onlineBiEmbedUrl(reportUrl: string): string {
  const normalized = normalizeOnlineBiReportUrl(reportUrl) ?? ONLINE_BI_DEFAULT_REPORT_URL
  const parsed = new URL(normalized)
  parsed.searchParams.set("embed", "true")
  parsed.searchParams.set("embed_options", "show_padding")
  return parsed.toString()
}

/** Last single-page address from older builds, promoted into the default tab. */
export function onlineBiStoredReportUrl(): string {
  return normalizeOnlineBiReportUrl(`${ONLINE_BI_ORIGIN}${storedOnlineBiPath()}`) ?? ONLINE_BI_DEFAULT_REPORT_URL
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
  return getOnlineBiEmbedSrcFor(onlineBiStoredReportUrl())
}

/** Build an authenticated embed URL for any selected report tab. */
export async function getOnlineBiEmbedSrcFor(reportUrl: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core")
  const base = onlineBiEmbedUrl(reportUrl)
  // A real token is a long JWT-ish string; a path like /personal_dashboard is a common mis-paste
  // that would make the embed fail silently, so treat it as "no usable token" and try the window.
  const configured = await invoke<string>("online_bi_embed_url")
  const storedToken = configured.match(/[?&]s=([^&]*)/)?.[1] ?? ""
  const storedLooksValid = storedToken.length > 16 && !/^\/|personal_dashboard/i.test(storedToken)
  const authenticated = (token: string): string => {
    const parsed = new URL(base)
    parsed.searchParams.set("s", token)
    return parsed.toString()
  }
  if (storedLooksValid) return authenticated(storedToken)
  const token = await extractOnlineBiToken()
  if (token) return authenticated(token)
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
