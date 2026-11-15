// The switch labelled 「长时间无输出自动催一句」. **On by default**.
//
// Purely a renderer preference: the progress row nudges the running turn when the model has been
// silent for 90 seconds (`src/features/chat/turn-progress.tsx`), and that is a decision only the
// window that draws the row can make. There is no Rust-side flag, nothing reads this in the bridge,
// and the nudge itself is the same `client.prompt` call the row's manual button makes.
//
// Same shape as `overload-retry-settings.ts` and `gateway-retry-settings.ts` so all three switches
// on the provider page behave identically, including the cross-window `storage` sync.
const STORAGE_KEY = "chat.auto-nudge-enabled"
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

let current = read()

export function autoNudgeEnabled(): boolean {
  return current
}

export function setAutoNudgeEnabled(enabled: boolean): void {
  current = enabled
  try {
    localStorage.setItem(STORAGE_KEY, String(current))
  } catch {
    // Persisting is best effort; the in-memory value still drives this render tree.
  }
  for (const listener of listeners) listener()
}

export function subscribeAutoNudge(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Settings and the main chat window are separate Tauri webviews sharing one origin: a write in the
// settings window only reaches this one as a storage event.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return
    const next = read()
    if (next === current) return
    current = next
    for (const listener of listeners) listener()
  })
}
