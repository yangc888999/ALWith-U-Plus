import { useSyncExternalStore } from "react"

import { reportBackgroundError } from "@/lib/background-errors"
import { settingsStore, updateSettings } from "@/lib/settings-store"

/**
 * Whether a project conversation opens as four columns (sessions · chat · file tree · preview).
 *
 * On is the default: the preview column is part of the workspace, and a project chat that starts
 * without it hides the files the conversation is about. Off starts the chat three columns wide —
 * chat, tree, and the window's spare width — and brings the preview column back the first time a
 * file is opened, which is what a reader who almost never uses the right-hand pane wants.
 *
 * Only the *initial* state is decided here. Opening a file still opens the column, and a column
 * closed by hand is still remembered for the session.
 */
const KEY = "appearance.fourColumnsDefault"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)

export function fourColumnsDefault(): boolean {
  // Only an explicit `false` turns it off; a missing or unreadable value means the four columns.
  return settingsStore.get<boolean>(KEY) !== false
}

export function useFourColumnsDefault(): boolean {
  return useSyncExternalStore(subscribe, fourColumnsDefault)
}

export function setFourColumnsDefault(enabled: boolean): Promise<void> {
  // A redundant choice never reaches the store; comparisons use the stored value, not the caller's.
  if (enabled === fourColumnsDefault()) return Promise.resolve()
  return updateSettings({ [KEY]: enabled }).catch((error: unknown) => {
    reportBackgroundError("four-columns-preference", error)
  })
}
