import { invoke } from "@tauri-apps/api/core"

// Persist the original reminder polarity so saved preferences keep their behavior when
// the UI exposes the inverse switch, 「禁用模型异常提醒」.
//
// The mirror in `bridge.rs` is an in-process `AtomicBool` and is NOT persisted, so this module must
// not rely on its import side effect to prime it: the settings page is the only importer, and a user
// who disabled the alerts, quit and relaunched without opening 设置 got the notices back while the
// switch still read "disabled". `startOverload429MuteSync()` is called from the boot path instead.
const STORAGE_KEY = "chat.overload-429-reminder-enabled"
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

// The Rust side keeps the mute switch in a shared AtomicBool that the bridge reads on every
// upstream request, so a change applies immediately without restarting the engine. Mirror the
// value fire-and-forget: outside a Tauri webview (Node, unit tests) there is no bridge, and a
// rejected command must never break boot or the settings UI.
function syncOverload429Mute(mute: boolean): void {
  if (typeof window === "undefined") return
  try {
    void invoke("set_overload_429_mute", { mute }).catch(() => {})
  } catch {
    // `invoke` is unavailable when the Tauri runtime is absent; keep the local value anyway.
  }
}

let current = read()
let syncStarted = false

export function overload429ReminderDisabled(): boolean {
  return !current
}

export function setOverload429ReminderDisabled(disabled: boolean): void {
  current = !disabled
  try {
    localStorage.setItem(STORAGE_KEY, String(current))
  } catch {
    // Persisting is best effort; the in-memory value still drives this render tree.
  }
  for (const listener of listeners) listener()
  syncOverload429Mute(!current)
}

export function subscribeOverload429ReminderDisabled(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Primes the bridge with the stored value. Idempotent, so the boot path and any other caller may
 * both ask for it and the process still sees exactly one push.
 *
 * The value is re-read here rather than trusting the module-load snapshot: between the import and
 * this call another webview may have written `chat.overload-429-reminder-enabled`.
 */
export function startOverload429MuteSync(): void {
  if (syncStarted) return
  syncStarted = true
  current = read()
  syncOverload429Mute(!current)
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
    syncOverload429Mute(!current)
    for (const listener of listeners) listener()
  })
}
