import { useSyncExternalStore } from "react"

import { settingsStore } from "@/lib/settings-store"

/**
 * Fixed four-column workspace: sessions, chat, file tree and preview side by side.
 *
 * It is the layout now, not an option — the setting that used to switch it off is gone. The stored
 * value is still honoured as `false` for anyone who wants to keep it that way by hand, but the UI
 * no longer offers the toggle.
 */
const KEY = "appearance.fixedFour"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)

export function fixedFourEnabled(): boolean {
  // Only an explicit `false` turns it off; a missing or unreadable value means on.
  return settingsStore.get<boolean>(KEY) !== false
}

export function useFixedFour(): boolean {
  return useSyncExternalStore(subscribe, fixedFourEnabled)
}
