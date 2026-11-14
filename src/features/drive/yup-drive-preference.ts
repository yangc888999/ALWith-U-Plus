import { useSyncExternalStore } from "react"

import { settingsStore, updateSettings } from "@/lib/settings-store"

import { drive } from "./controller"

/**
 * Master switch for the YUP cloud drive.
 *
 * Off hides the Drive sidebar/settings entry and stops synchronization (and releases the drive
 * client). It lives in the Rust-backed settings store so the Settings window can flip it and the
 * main window reacts immediately. The live connection is owned by `useDriveConnection`, which
 * re-attaches when this turns back on.
 */
const KEY = "drive.yupEnabled"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)
const read = () => settingsStore.get<boolean>(KEY) ?? true

export function useYupDriveEnabled(): boolean {
  return useSyncExternalStore(subscribe, read)
}

/** Flips the master switch. Turning it off stops the drive's background sync immediately (the
 *  `useDriveConnection` hook releases the client on its next tick); turning it on lets that hook
 *  re-attach and resume. */
export async function setYupDriveEnabled(enabled: boolean): Promise<void> {
  await updateSettings({ [KEY]: enabled })
  if (!enabled) {
    // A drive that was never started simply rejects; ignore it and let the hook dispose.
    await drive.request({ type: "stop" }).catch(() => undefined)
  }
}
