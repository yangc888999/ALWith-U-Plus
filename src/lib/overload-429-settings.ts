import { invoke } from "@tauri-apps/api/core"

// Persist the original reminder polarity so saved preferences keep their behavior when
// the UI exposes the inverse switch, 「禁用模型异常提醒」.
const STORAGE_KEY = "chat.overload-429-reminder-enabled"
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
function syncOverload429Mute(mute: boolean): void {
  if (typeof window === "undefined") return
  try {
    void invoke("set_overload_429_mute", { mute }).catch(() => {})
  } catch {
    // `invoke` is unavailable when the Tauri runtime is absent; keep the local value anyway.
  }
}

let current = read()
syncOverload429Mute(!current)

export function overload429ReminderDisabled(): boolean {
  return !current
}

export function setOverload429ReminderDisabled(disabled: boolean): void {
  current = !disabled
  localStorage.setItem(STORAGE_KEY, String(current))
  for (const listener of listeners) listener()
  syncOverload429Mute(!current)
}

export function subscribeOverload429ReminderDisabled(listener: () => void): () => void {
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
    syncOverload429Mute(!current)
    for (const listener of listeners) listener()
  })
}
