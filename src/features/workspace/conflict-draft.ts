import type { FileSystem } from "@alwith/module-fs/core"

/** One fixed, hidden draft per document; repeated conflicts overwrite it instead of adding files. */
export function conflictDraftPath(path: string, fallbackExtension: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  const directory = slash >= 0 ? path.slice(0, slash + 1) : ""
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : fallbackExtension
  return `${directory}.${stem}.conflict-draft${extension}`
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false
  return true
}

/**
 * Saves the local side of a save conflict to its fixed hidden draft path.
 *
 * A cloud-synced directory already produces conflict copies on its own. Timestamped drafts or a
 * new file per conflict only multiply those copies, so this function always uses one hidden path
 * and skips the write when the bytes are already there.
 */
export async function writeConflictDraft(
  fs: FileSystem,
  path: string,
  bytes: Uint8Array,
  fallbackExtension: string
): Promise<string> {
  const draftPath = conflictDraftPath(path, fallbackExtension)
  if ((await fs.stat(draftPath)) !== null && sameBytes(await fs.readFile(draftPath), bytes)) return draftPath
  await fs.writeFile(draftPath, bytes, { mode: "upsert" })
  return draftPath
}
