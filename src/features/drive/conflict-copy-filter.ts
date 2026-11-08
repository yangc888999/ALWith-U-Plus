import type { FileEntry, FileSystem } from "@alwith/module-fs"

import { settingsStore } from "@/lib/settings-store"

const KEY = "drive.blockConflictCopies"

/**
 * Drive's conflict copies, as the server names them.
 *
 * Observed on this machine (each one a sibling of the file it collided with):
 *
 *   拉取进度（冲突副本 · jie.yang · 2026-09-14 1952）.json.yupcloud
 *   timestamp重跑v2_拉取进度（冲突副本 · jie.yang · 2026-09-21 2020） (4).json.yupcloud
 *
 * The marker is localised by whoever produced the copy, and macOS appends ` (n)` when the name is
 * already taken, so the pattern matches the parenthesised marker anywhere in the name rather than
 * anchoring to the end. `conflicted copy` is the English counterpart.
 *
 * Deliberately narrow: a plain ` (1)` suffix is NOT a conflict copy. Dropbox-style numeric copies
 * are what a user makes on purpose, and hiding them would look like data loss.
 */
const CONFLICT_COPY = /（冲突副本[^）]*）|\(冲突副本[^)]*\)|\(conflicted copy[^)]*\)/i

export function isConflictCopy(name: string): boolean {
  return CONFLICT_COPY.test(name)
}

/** Read on every directory listing, so flipping the switch takes effect without a remount. */
export function blocksConflictCopies(): boolean {
  return settingsStore.get<boolean>(KEY) ?? false
}

/**
 * Watch events travel a separate path from directory listings. The native watcher reports every
 * file the sync daemon writes, including the conflict copies hidden from the tree. Filtering only
 * `readDirectory` therefore stopped them being *seen* but still let each write invalidate the
 * editor's cache and rebuild the open preview. Call this on watch paths too.
 */
export function isIgnoredWatchPath(path: string): boolean {
  return blocksConflictCopies() && isConflictCopy(path)
}

/**
 * Wraps a filesystem so conflict copies never reach the file tree.
 *
 * Display-only on purpose. The sync daemon lives in a prebuilt native library and offers no
 * per-file ignore or delete, and a local delete would propagate to the cloud — so the safe way to
 * stop seeing these files is to stop listing them. Nothing on disk, in the index, or upstream is
 * touched: new files, edits and deletions keep syncing exactly as before, and turning the switch
 * off brings every copy back into view.
 */
export function hideConflictCopies(fs: FileSystem): FileSystem {
  const readDirectory = async (
    path: string,
    options?: Parameters<FileSystem["readDirectory"]>[1]
  ): Promise<readonly FileEntry[]> => {
    const entries = await fs.readDirectory(path, options)
    if (!blocksConflictCopies()) return entries
    const visible = entries.filter((entry) => !isConflictCopy(entry.name))
    // `false` means "already hidden"; returning the original array keeps referential equality for
    // the tree's change detection when nothing was filtered.
    return visible.length === entries.length ? entries : visible
  }
  // A Proxy rather than spread: the controller's methods may rely on their own `this`, and only
  // `readDirectory` should differ. The receiver is deliberately not forwarded, so an accessor on
  // the target still sees the target as `this` instead of the proxy.
  return new Proxy(fs, {
    get(target, property) {
      if (property === "readDirectory") return readDirectory
      const value = Reflect.get(target, property) as unknown
      return typeof value === "function" ? value.bind(target) : value
    }
  })
}
