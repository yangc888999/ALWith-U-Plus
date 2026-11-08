import { useSyncExternalStore } from "react"

import { settingsStore, updateSettings } from "@/lib/settings-store"

/**
 * Master switch for the YUP cloud drive.
 *
 * Off hides the Drive sidebar and stops synchronization; it lives in the Rust-backed settings
 * store so the Settings window can flip it and the main window reacts immediately.
 */
const KEY = "drive.yupEnabled"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)
const read = () => settingsStore.get<boolean>(KEY) ?? true

export function useYupDriveEnabled(): boolean {
  return useSyncExternalStore(subscribe, read)
}

export function setYupDriveEnabled(enabled: boolean): Promise<void> {
  return updateSettings({ [KEY]: enabled })
}
