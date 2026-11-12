import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import { reportBackgroundError } from "@/lib/background-errors"
import { settingsStore, updateSettings } from "@/lib/settings-store"

/**
 * Whether the session sidebar starts collapsed and re-opens when the cursor reaches the left edge.
 *
 * Only meaningful when the four-column project layout is off — with four columns on, every column
 * is shown and the sidebar is not collapsible on its own. While four columns is on this preference
 * is forced off and the toggle is disabled; once four columns is off the user may let the sidebar
 * collapse to a thin rail and expand on hover.
 */
const KEY = "workspace.sidebarAutoCollapse"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)
const read = () => settingsStore.get<boolean>(KEY) === true

export function sidebarAutoCollapse(): boolean {
  return read()
}

export function setSidebarAutoCollapsePreference(enabled: boolean): Promise<void> {
  if (enabled === read()) return Promise.resolve()
  return updateSettings({ [KEY]: enabled })
}

export function useSidebarAutoCollapsePreference(): [boolean, (enabled: boolean) => void] {
  const stored = useSyncExternalStore(subscribe, read)
  const [enabled, setEnabled] = useState(stored)
  useEffect(() => setEnabled(stored), [stored])
  const update = useCallback((next: boolean): void => {
    setEnabled(next)
    void setSidebarAutoCollapsePreference(next).catch((error: unknown) =>
      reportBackgroundError("sidebar-auto-collapse-preference", error)
    )
  }, [])
  return [enabled, update]
}
