import { invoke } from "@tauri-apps/api/core"

// The switch labelled 「连接中断自动重试」. **On by default**: when a provider connection times out
// or drops mid-turn, the bridge re-sends the same request instead of failing the turn, so a flaky
// upstream costs a wait rather than a lost round. **Off**: the failure reaches the reader as an
// error and they decide what to do.
//
// Two stores, one direction of truth: **localStorage owns the value, the bridge mirrors it.** The
// mirror is an in-process `AtomicBool` in `bridge.rs` — it is read on the request path, and it does
// NOT survive a restart. That is why this module has no import-time side effect any more: a push
// that only happens when the settings page is opened silently re-enabled the switch for every user
// who turned it off and then restarted without visiting 设置. `startGatewayRetrySync()` is called
// from the boot path so the mirror is primed on every launch.
//
// `gateway_retry_get()` is deliberately not read back: the flag has one owner (this module) and one
// direction, so a divergent mirror can never become a second source of truth.
const STORAGE_KEY = "chat.gateway-retry-enabled"
const DEFAULT_ENABLED = true

const listeners = new Set<() => void>()

function read(): boolean {
  if (typeof localStorage === "undefined") return DEFAULT_ENABLED
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === null || value === "" ? DEFAULT_ENABLED : value !== "false"
  } catch {
    // Private mode / disabled storage: keep the default instead of throwing on render.
    return DEFAULT_ENABLED
  }
}

/** Mirrors one value into the bridge. Fire-and-forget: no native side (Node, unit tests) must
 *  never surface as a boot failure. */
function syncGatewayRetry(enabled: boolean): void {
  if (typeof window === "undefined") return
  try {
    void invoke("gateway_retry_set", { enabled }).catch(() => {})
  } catch {
    // `invoke` is unavailable when the Tauri runtime is absent; keep the local value anyway.
  }
}

let current = read()
let syncStarted = false

export function gatewayRetryEnabled(): boolean {
  return current
}

export function setGatewayRetryEnabled(enabled: boolean): void {
  current = enabled
  try {
    localStorage.setItem(STORAGE_KEY, String(current))
  } catch {
    // Persisting is best effort; the in-memory value still drives this render tree.
  }
  for (const listener of listeners) listener()
  syncGatewayRetry(current)
}

export function subscribeGatewayRetryEnabled(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Primes the bridge with the stored value. Idempotent — the boot path and any other caller may both
 * ask for it, and the process still sees exactly one push.
 *
 * The value is re-read here rather than trusting the module-load snapshot: between the import and
 * this call another webview may have written `chat.gateway-retry-enabled`.
 */
export function startGatewayRetrySync(): void {
  if (syncStarted) return
  syncStarted = true
  current = read()
  syncGatewayRetry(current)
}

// Settings and the main chat window are separate Tauri webviews sharing one origin. Apply writes in
// the settings window; this window only sees a storage event, so re-read instead of keeping the
// value cached at module load — otherwise the switch needs an app restart.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return
    const next = read()
    if (next === current) return
    current = next
    for (const listener of listeners) listener()
  })
}
