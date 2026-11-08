import { useCallback, useSyncExternalStore } from "react"

import { settingsStore, updateSettings } from "./settings-store"

/**
 * One persisted boolean shared by every webview. Rust remains the writer, so a change made in
 * Settings reaches the main window through the existing `settings:changed` projection.
 */
export function useBooleanSetting(key: string, fallback = false): [boolean, (next: boolean) => void] {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => settingsStore.subscribe(() => onChange()),
    []
  )
  const value = useSyncExternalStore(
    subscribe,
    () => settingsStore.get<boolean>(key) ?? fallback,
    () => fallback
  )
  const set = (next: boolean): void => {
    void updateSettings({ [key]: next }).catch(() => undefined)
  }
  return [value, set]
}
