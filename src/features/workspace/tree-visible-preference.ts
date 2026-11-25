import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import { reportBackgroundError } from "@/lib/background-errors"
import { settingsStore, updateSettings } from "@/lib/settings-store"

/**
 * Whether the project file tree is shown next to the preview.
 *
 * The column used to open on every project visit, so a reader who only wanted the document had to
 * collapse it again each time. The choice now lives in the settings store: closing the tree keeps
 * it closed across projects and restarts, and the toggle in the tree header is the way back.
 *
 * The returned state is local-first: the button flips the column immediately and the store catches
 * up, so a click is never waiting on a round trip (and a window without a settings backend, such as
 * an embedded preview, still toggles).
 */
const KEY = "workspace.treeVisible"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)
const read = () => settingsStore.get<boolean>(KEY) ?? true

function setTreeVisiblePreference(visible: boolean): Promise<void> {
  // A redundant choice never reaches the store; comparisons use the stored value, not the caller's.
  if (visible === read()) return Promise.resolve()
  return updateSettings({ [KEY]: visible })
}

export function useTreeVisiblePreference(): [boolean, (visible: boolean) => void] {
  const stored = useSyncExternalStore(subscribe, read)
  const [visible, setVisible] = useState(stored)
  // Another window (or Settings) changed it: follow the store.
  useEffect(() => setVisible(stored), [stored])
  const update = useCallback((next: boolean): void => {
    setVisible(next)
    void setTreeVisiblePreference(next).catch((error: unknown) =>
      reportBackgroundError("tree-visible-preference", error)
    )
  }, [])
  return [visible, update]
}
