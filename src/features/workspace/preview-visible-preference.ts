import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import { reportBackgroundError } from "@/lib/background-errors"
import { settingsStore, updateSettings } from "@/lib/settings-store"

/**
 * Whether the project preview column is shown.
 *
 * Unlike the file tree, the preview is normally part of the four-column layout, so its visibility
 * is derived from `fourColumnsDefault`: with four columns on it is always present. Once four columns
 * is turned off, this preference takes over — the user may keep the preview open by default or start
 * with just the chat and tree and open the preview on demand. The toggle in Settings only writes this
 * value when four columns is off; while four columns is on the preview is forced on regardless.
 *
 * The returned state is local-first: the switch flips the column immediately and the store catches
 * up, so a click never waits on a round trip.
 */
const KEY = "workspace.previewVisible"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)
const read = () => settingsStore.get<boolean>(KEY) ?? true

export function previewVisible(): boolean {
  return read()
}

export function setPreviewVisiblePreference(visible: boolean): Promise<void> {
  // A redundant choice never reaches the store; comparisons use the stored value, not the caller's.
  if (visible === read()) return Promise.resolve()
  return updateSettings({ [KEY]: visible })
}

export function usePreviewVisiblePreference(): [boolean, (visible: boolean) => void] {
  const stored = useSyncExternalStore(subscribe, read)
  const [visible, setVisible] = useState(stored)
  // Another window (or Settings) changed it: follow the store.
  useEffect(() => setVisible(stored), [stored])
  const update = useCallback((next: boolean): void => {
    setVisible(next)
    void setPreviewVisiblePreference(next).catch((error: unknown) =>
      reportBackgroundError("preview-visible-preference", error)
    )
  }, [])
  return [visible, update]
}
