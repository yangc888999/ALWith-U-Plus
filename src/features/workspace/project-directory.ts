/**
 * The single, front-end-only source of truth for "which project directory the current surface is
 * showing".
 *
 * Before this module the directory was recomputed as `session?.cwd ?? lastDirectory` in `app.tsx`
 * and independently by a dozen `groupByDirectory(cwd)` lookups. A conversation whose directory had
 * not arrived yet — the common case for a 拉会 session resumed from history — resolved to `null`,
 * which `isTemporaryChatDir` classified as a temporary chat: the four columns never opened, the
 * file-toolbar was hidden and the 文件栏 button only flipped a `treeVisible` flag that nothing was
 * rendering. Group folders were never handed to `FileWorkspace` at all.
 *
 * A binding is written at every path that *knows* the directory (opening a conversation, starting a
 * meeting, picking a folder, viewing a meeting's files). The reader then resolves one directory for
 * the whole layout. The table lives in memory only: no Tauri command, no Rust change, no migration.
 */

import { useSyncExternalStore } from "react"

import { isGroupsRootDirectory } from "@/lib/path"
import { isChatOwnDirectory, isTemporaryChatDir } from "@/lib/quick-chat"

/** The draft composer has no session id yet, but still owns a project directory (a fresh meeting). */
export const DRAFT_DIRECTORY_KEY = "__draft__"

export type ProjectDirectoryReason = "project" | "group" | "temporary" | "missing" | "invalid"

/** The three states the workspace can explain to the reader when no file workspace can be shown. */
export type WorkspaceEmptyReason = "missing" | "invalid" | "temporary"

export interface ProjectDirectoryBinding {
  directory: string
  groupId: string | null
  /** Set when the attempted directory was rejected (empty or the Groups root). */
  invalid?: boolean
}

export interface ProjectDirectoryResolution {
  directory: string | null
  groupId: string | null
  reason: ProjectDirectoryReason
}

/**
 * `useSyncExternalStore` compares snapshots by identity. Each binding is a frozen object stored by
 * key, so re-reading the same key returns the same reference until it is actually rebound — a fresh
 * object per read would re-render forever (React #185). This mirrors `lib/groups.ts`'s cached read.
 */
const bindings = new Map<string, Readonly<ProjectDirectoryBinding>>()
const listeners = new Set<() => void>()

function bindingKey(key: string): string {
  return key === "" ? DRAFT_DIRECTORY_KEY : key
}

function bindingFor(key: string): Readonly<ProjectDirectoryBinding> | null {
  return bindings.get(bindingKey(key)) ?? null
}

/**
 * Whether a path is the Groups *root* (`~/Documents/ALWith/groups`) rather than a meeting's own
 * folder (`~/Documents/ALWith/groups/定价会`).
 *
 * The retired settings "attach" flow pinned some group records onto the parent. That path must be
 * repaired before it can be shown as a project: opening it as a workspace would list every meeting
 * at once. Paths are compared with trailing slashes removed, backslashes normalised and the fixed
 * `Documents/ALWith/groups` segments lower-cased, because the on-disk spelling mixes `ALwith`,
 * `ALWith` and `ALWITH` on case-insensitive macOS volumes.
 */
export function isGroupsRoot(directory: string): boolean {
  return isGroupsRootDirectory(directory)
}

/**
 * Binds a directory to a conversation (or to the draft surface).
 *
 * Empty paths and the Groups root are *not* silently dropped: they are stored as `invalid` so the
 * workspace can explain the problem and offer the one-click `group_directory_heal` repair. The
 * directory is deliberately left untouched otherwise — healing belongs to the caller, which knows
 * the meeting name.
 */
export function bindProjectDirectory(key: string, directory: string, groupId: string | null = null): void {
  const id = bindingKey(key)
  const invalid = directory.trim() === "" || isGroupsRoot(directory)
  const previous = bindings.get(id)
  if (
    previous !== undefined &&
    previous.directory === directory &&
    previous.groupId === groupId &&
    (previous.invalid === true) === invalid
  )
    return
  bindings.set(id, Object.freeze(invalid ? { directory, groupId, invalid: true } : { directory, groupId }))
  for (const listener of listeners) listener()
}

/** The valid binding for a key, or `null` when there is none or the attempt was invalid. */
export function projectDirectoryFor(key: string): Readonly<ProjectDirectoryBinding> | null {
  const record = bindingFor(key)
  return record === null || record.invalid === true ? null : record
}

/**
 * The raw binding including a rejected `invalid` attempt. The empty state needs the rejected path
 * to call `group_directory_heal`, which `projectDirectoryFor` intentionally hides.
 */
export function projectDirectoryAttempt(key: string): Readonly<ProjectDirectoryBinding> | null {
  return bindingFor(key)
}

export function subscribeProjectDirectories(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Whether the workspace should open its preview + file columns by default.
 *
 * The rule the layout follows (2026-11-16): a first launch and a plain chat stay at two columns
 * (sidebar + conversation); only actually *entering a project* may open four, and even then the
 * reader's 显示预览栏 setting has the final say.
 *
 * The trap this avoids: `resolveProjectDirectory` falls back to `lastDirectory` when neither the
 * draft key nor the session carries a binding. Left unchecked, that fallback made the home screen —
 * which has no session and never picked a folder this run — look like a project and spring open a
 * preview of somebody else's files. So "has a usable directory" is deliberately NOT enough here;
 * the directory must come from an explicit source: a binding for the current key (a folder picked
 * for this draft/session, a meeting, a 查看文件 action) or the session's own cwd.
 */
export function shouldOpenFourColumns(input: {
  /** An explicit binding for the current surface key (draft key or session id). */
  boundDirectory: string | null
  /** The selected session's own cwd, when a session is open. */
  sessionCwd: string | null
  /** The 显示预览栏 preference — even a real project stays two-column when it is off. */
  previewVisible: boolean
  /** A rejected directory must open the pane so its one-click repair hint is on screen. */
  invalidDirectory?: boolean
}): boolean {
  // An invalid attempt is the one case that opens regardless of the visibility preference: the
  // repair affordance lives inside the workspace column and cannot help anyone while it is shut.
  if (input.invalidDirectory) return true
  if (!input.previewVisible) return false
  const explicit = input.boundDirectory ?? input.sessionCwd
  if (explicit === null || explicit.trim() === "") return false
  // A conversation's own quick-chat folder is locatable like a project; the quick-chat root and
  // a directory-less draft are not.
  return (!isTemporaryChatDir(explicit) || isChatOwnDirectory(explicit)) && !isGroupsRoot(explicit)
}

/**
 * React-facing read; the snapshot is the frozen binding object, stable across renders.
 *
 * It must be the *raw* attempt, not the valid-only `projectDirectoryFor`. A rejected (Groups-root
 * or empty) directory is still a real state change `null → object`; publishing that object is what
 * makes `useSyncExternalStore` re-render the app so the repair hint appears. With the valid-only
 * read an invalid write also returned `null`, so the app never re-rendered and the invalid empty
 * state could not show up on its own. Callers that only care about valid bindings must filter on
 * `invalid` themselves — the one current caller (`app.tsx`) only subscribes and ignores the value.
 */
export function useBoundProjectDirectory(key: string): Readonly<ProjectDirectoryBinding> | null {
  const snapshot = (): Readonly<ProjectDirectoryBinding> | null => projectDirectoryAttempt(key)
  return useSyncExternalStore(subscribeProjectDirectories, snapshot, snapshot)
}

function resolveDirectory(directory: string, groupId: string | null): ProjectDirectoryResolution {
  // The Groups root is invalid before any other test: a quick-chat path can never be that root,
  // and failing to flag it here would show every meeting's folder as one project.
  if (isGroupsRoot(directory)) return { directory: null, groupId, reason: "invalid" }
  if (isTemporaryChatDir(directory)) {
    // The conversation's own folder stays locatable: selecting that chat must open *its* files,
    // never a stale project. Only the quick-chat root itself has no workspace.
    if (isChatOwnDirectory(directory)) return { directory, groupId, reason: "temporary" }
    return { directory: null, groupId, reason: "temporary" }
  }
  return { directory, groupId, reason: groupId !== null ? "group" : "project" }
}

/**
 * Resolves the directory for the surface, in priority order:
 * ① an explicit binding (draft uses `DRAFT_DIRECTORY_KEY`) → ② the session's own cwd
 * → ③ nothing (`missing`).
 *
 * There is deliberately no `lastDirectory` fallback: a selected conversation whose cwd has not
 * arrived yet must show *nothing*, not the previous project's files, and a brand-new task must
 * not inherit whichever folder was picked last. `lastDirectory` is accepted for call-site
 * compatibility but never consulted.
 */
export function resolveProjectDirectory(input: {
  sessionId: string | null
  sessionCwd: string | null
  lastDirectory: string | null
}): ProjectDirectoryResolution {
  const key = bindingKey(input.sessionId ?? DRAFT_DIRECTORY_KEY)
  const bound = bindingFor(key)
  if (bound !== null) {
    if (bound.invalid === true) return { directory: null, groupId: bound.groupId, reason: "invalid" }
    return resolveDirectory(bound.directory, bound.groupId)
  }
  const cwd = input.sessionCwd
  if (cwd !== null && cwd.trim() !== "") return resolveDirectory(cwd, null)
  return { directory: null, groupId: null, reason: "missing" }
}
