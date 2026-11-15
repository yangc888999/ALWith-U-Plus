function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/")
}

/**
 * Last path segment (file or folder name), cross-platform: `\` is normalised to `/` first,
 * so `C:\Users\foo\bar` and `/Users/foo/bar` both give `bar`. A trailing separator is
 * trimmed; an all-empty result falls back to the input.
 */
export function basename(p: string): string {
  if (!p) return p
  const normalized = normalizeSlashes(p).replace(/\/+$/, "")
  const last = normalized.split("/").pop()
  return last && last.length > 0 ? last : p
}

/** Path segments of a directory: separators normalised, empty segments and trailing `/` dropped. */
export function directorySegments(path: string | null | undefined): string[] {
  if (path === null || path === undefined) return []
  return normalizeSlashes(path.trim())
    .split("/")
    .filter((segment) => segment !== "")
}

/** Where the fixed `Documents/ALWith/groups` triple sits in the segment list, or -1. */
function groupsRootIndex(segments: string[]): number {
  for (let index = segments.length - 3; index >= 0; index -= 1) {
    if (
      segments[index].toLowerCase() === "documents" &&
      segments[index + 1].toLowerCase() === "alwith" &&
      segments[index + 2].toLowerCase() === "groups"
    )
      return index
  }
  return -1
}

/**
 * Whether the path **is** the Groups root (`~/Documents/ALWith/groups`).
 *
 * The on-disk spelling mixes `ALwith`, `ALWith` and `ALWITH` on case-insensitive macOS volumes, so
 * the fixed segments are compared lower-cased; `C:\Users\x\Documents\ALWith\groups` normalises to
 * the same thing.
 */
export function isGroupsRootDirectory(path: string): boolean {
  const segments = directorySegments(path)
  const root = groupsRootIndex(segments)
  return root >= 0 && segments.length === root + 3
}

/**
 * The meeting folder a directory sits in: `…/Documents/ALWith/groups/定价会` → `定价会`, and the same
 * for anything nested deeper inside it.
 *
 * `null` for a directory outside the Groups folder, for the Groups root itself (a meeting cannot be
 * the folder that holds every meeting), and for an empty path. Callers get the raw segment — the
 * caller decides whether it needs to fold case, which `groupByDirectory` does and a display name
 * does not.
 */
export function groupsFolderName(path: string | null | undefined): string | null {
  const segments = directorySegments(path)
  const root = groupsRootIndex(segments)
  if (root < 0 || segments.length <= root + 3) return null
  return segments[root + 3]
}
