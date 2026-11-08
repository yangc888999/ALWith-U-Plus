import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import { reportBackgroundError } from "@/lib/background-errors"
import { settingsStore, updateSettings } from "@/lib/settings-store"

/**
 * Whether Drive's conflict copies are hidden from the file tree.
 *
 * These are the files the sync daemon leaves behind when the same document changed in two places:
 * `分析产出（冲突副本 · jie.yang · 2026-09-14 1952）.md`. A busy project accumulates them, and they
 * are indistinguishable from real deliverables in the tree.
 *
 * The switch is display-only by design. The daemon has no per-file ignore or delete, and removing
 * a synced file locally propagates upstream — so the only safe thing to change is what is listed.
 * Sync, uploads, downloads and the files on disk are untouched; turning the switch off brings every
 * copy straight back.
 */
const KEY = "drive.blockConflictCopies"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)
const read = () => settingsStore.get<boolean>(KEY) ?? false

export function setBlockConflictCopies(blocked: boolean): Promise<void> {
  if (blocked === read()) return Promise.resolve()
  return updateSettings({ [KEY]: blocked })
}

export function useBlockConflictCopies(): [boolean, (blocked: boolean) => void] {
  const stored = useSyncExternalStore(subscribe, read)
  const [blocked, setBlocked] = useState(stored)
  // Another window (or Settings) changed it: follow the store.
  useEffect(() => setBlocked(stored), [stored])
  const update = useCallback((next: boolean): void => {
    setBlocked(next)
    void setBlockConflictCopies(next).catch((error: unknown) =>
      reportBackgroundError("block-conflict-copies", error)
    )
  }, [])
  return [blocked, update]
}
