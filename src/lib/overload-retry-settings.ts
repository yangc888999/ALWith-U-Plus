import { invoke } from "@tauri-apps/api/core"

// The setting is the switch labelled 「屏蔽模型过载提醒」. **On by default**: the refusal
// reaches the user as a notice. **Off**: the bridge swallows `server_is_overloaded`, re-sends the
// same request immediately without waiting for the backend `retry-after`, and keeps doing so
// with no ceiling until a real response comes back or the stream ends — the 60-minute
// whole-request timeout is the only backstop. The quiet behaviour is the one the user switches
// *off*, which is what the label says: the notice is what gets switched off.
const STORAGE_KEY = "chat.overload-notice-enabled"
const DEFAULT_ENABLED = true

const listeners = new Set<() => void>()

function read(): boolean {
  if (typeof localStorage === "undefined") return DEFAULT_ENABLED
  const value = localStorage.getItem(STORAGE_KEY)
  return value === null || value === "" ? DEFAULT_ENABLED : value !== "false"
}

// The Rust side keeps the mute switch in a shared AtomicBool that the bridge reads on every
// upstream request, so a change applies immediately without restarting the engine. Mirror the
// value fire-and-forget: outside a Tauri webview (Node, unit tests) there is no bridge, and a
// rejected command must never break the settings UI.
function syncOverloadMute(mute: boolean): void {
  if (typeof window === "undefined") return
  try {
    void invoke("set_overload_mute", { mute }).catch(() => {})
  } catch {
    // `invoke` is unavailable when the Tauri runtime is absent; keep the local value anyway.
  }
}

let current = read()
syncOverloadMute(!current)

export function overloadNoticeEnabled(): boolean {
  return current
}

export function setOverloadNoticeEnabled(enabled: boolean): void {
  current = enabled
  localStorage.setItem(STORAGE_KEY, String(current))
  for (const listener of listeners) listener()
  syncOverloadMute(!current)
}

export function subscribeOverloadNoticeEnabled(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Settings and the main chat window are separate Tauri webviews sharing one origin. Apply writes
// in the settings window; this window only sees a storage event, so re-read instead of keeping the
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