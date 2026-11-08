/**
 * Coalesces filesystem watch events before they reach the editor.
 *
 * `module-fs` broadcasts a `{ type: "change" }` for every path the native watcher reports, and the
 * naive adapter used to forward them one by one. Drive writes a synced project one file at a time
 * (a full sync can be dozens a second), and each broadcast invalidates the editor's document cache
 * and rebuilds the open preview — which reads as the preview pane flickering continuously.
 *
 * A trailing debounce turns a burst into a single notification once writes go quiet. Paths the
 * reader has hidden are dropped before they can enter the batch, so filtering a conflict copy out
 * of the tree also stops it from waking the preview.
 */
export interface WatchRelay {
  schedule: (paths: readonly string[]) => void
  dispose: () => void
}

export function createWatchRelay(
  changed: (paths: string[]) => void,
  accept: (path: string) => boolean = () => true,
  delay = 200
): WatchRelay {
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    timer = null
    if (pending.size === 0) return
    const batch = Array.from(pending)
    pending.clear()
    changed(batch)
  }
  return {
    schedule(paths) {
      for (const path of paths) if (accept(path)) pending.add(path)
      if (pending.size === 0) return
      // Trailing, not leading: a long sync keeps extending the timer and costs one reload at the
      // end. 200ms is short enough that a single AI edit still appears without a visible lag.
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, delay)
    },
    dispose() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending.clear()
    }
  }
}
