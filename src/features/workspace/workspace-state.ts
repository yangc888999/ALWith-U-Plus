import type { SavedEditorWorkspace } from "@alwith/module-editor"
import type { FileTreeProps } from "@alwith/module-file-tree"
import { containsPath } from "@alwith/module-fs"

export type IconTheme = NonNullable<FileTreeProps["iconTheme"]>
export interface WorkspaceState {
  tabLayout?: SavedEditorWorkspace
  tabs: { path: string; pinned: boolean }[]
  activePath: string | null
  expanded: string[]
  showHidden: boolean
  showIgnored: boolean
  iconTheme: IconTheme
}
export const iconThemes: readonly IconTheme[] = [
  "vscode-icons",
  "catppuccin-latte",
  "catppuccin-mocha",
  "material-icon-theme"
]

function decodeState(root: string, raw: string): WorkspaceState {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== "object" || value === null) throw new Error("Invalid workspace preferences")
  const state = value as Record<string, unknown>
  const validPath = (path: unknown): path is string => typeof path === "string" && containsPath(root, path)
  if (
    !Array.isArray(state.tabs) ||
    !(state.tabs as unknown[]).every(
      (tab) =>
        typeof tab === "object" &&
        tab !== null &&
        "path" in tab &&
        validPath(tab.path) &&
        "pinned" in tab &&
        typeof tab.pinned === "boolean"
    ) ||
    !Array.isArray(state.expanded) ||
    !state.expanded.every(validPath) ||
    (state.activePath !== null && !validPath(state.activePath)) ||
    typeof state.showHidden !== "boolean" ||
    typeof state.showIgnored !== "boolean" ||
    !iconThemes.includes(state.iconTheme as IconTheme)
  )
    throw new Error("Invalid workspace preferences")
  const layout = state.tabLayout as Partial<SavedEditorWorkspace> | null | undefined
  if (layout !== undefined) {
    if (
      !layout ||
      !Array.isArray(layout.tabs) ||
      !layout.tabs.every(
        (tab) =>
          typeof tab === "object" &&
          tab !== null &&
          (tab.kind === "new" || (tab.kind === "file" && validPath(tab.path)))
      ) ||
      (layout.activeIndex !== null &&
        (typeof layout.activeIndex !== "number" ||
          !Number.isInteger(layout.activeIndex) ||
          layout.activeIndex < 0 ||
          layout.activeIndex >= layout.tabs.length))
    )
      throw new Error("Invalid workspace tab layout")
    const paths = layout.tabs.filter((tab) => tab.kind === "file").map((tab) => tab.path)
    if (new Set(paths).size !== paths.length) throw new Error("Duplicate workspace tabs")
  }
  return state as unknown as WorkspaceState
}

/** Persist only file UI preferences; document bodies and Codex conversations never enter this store. */
export function createWorkspaceStateStore(storage: Storage = localStorage): {
  load: (root: string) => Promise<WorkspaceState | null>
  save: (root: string, state: WorkspaceState) => Promise<void>
} {
  return {
    load(root) {
      return Promise.try(() => {
        const value = storage.getItem(`workspace:${root}`)
        return value === null ? null : decodeState(root, value)
      })
    },
    save(root, state) {
      return Promise.try(() => {
        const value = JSON.stringify(state)
        decodeState(root, value)
        storage.setItem(`workspace:${root}`, value)
      })
    }
  }
}

/** Which document a conversation is looking at. */
export interface WorkspaceSessionState {
  tabs: { path: string; pinned: boolean }[]
  activePath: string | null
}

/**
 * The part of the workspace that belongs to one conversation rather than to the project.
 *
 * There is exactly one workspace instance per project — that is what keeps the tree, the editor
 * and any unsaved buffers alive while the reader switches chats, and it must stay that way. The
 * cost was that the persisted state was keyed by project alone, so every conversation in a project
 * reopened on the same tabs: starting a second chat showed the first chat's document, and going
 * back replaced it. Which files a conversation has open is conversation-scoped, so it is kept in
 * this second store and applied whenever the active conversation changes.
 *
 * Only `tabs` and `activePath` live here. The rest of `WorkspaceState` — expanded folders, the
 * hidden/ignored toggles, the icon theme, the editor split layout — is a project preference and
 * must not jump around when the reader moves between chats.
 */
export function createWorkspaceSessionStore(storage: Storage = localStorage): {
  load: (root: string, session: string) => Promise<WorkspaceSessionState | null>
  save: (root: string, session: string, state: WorkspaceSessionState) => Promise<void>
} {
  const key = (root: string, session: string): string => `workspace-session:${root}#${session}`
  return {
    load(root, session) {
      return Promise.try(() => {
        const raw = storage.getItem(key(root, session))
        if (raw === null) return null
        const value: unknown = JSON.parse(raw)
        if (typeof value !== "object" || value === null) return null
        const state = value as Record<string, unknown>
        if (!Array.isArray(state.tabs)) return null
        const tabs = state.tabs.filter((tab): tab is { path: string; pinned: boolean } => {
          if (typeof tab !== "object" || tab === null) return false
          const entry = tab as { path?: unknown; pinned?: unknown }
          return typeof entry.path === "string" && containsPath(root, entry.path) && typeof entry.pinned === "boolean"
        })
        // A conversation that never opened anything stores no active path; a path the project has
        // since lost (moved, renamed, unshared) is dropped rather than replayed as a broken tab.
        const activePath =
          typeof state.activePath === "string" && containsPath(root, state.activePath) ? state.activePath : null
        return { tabs, activePath }
      })
    },
    save(root, session, state) {
      return Promise.try(() => {
        const tabs = state.tabs.filter((tab) => containsPath(root, tab.path))
        storage.setItem(key(root, session), JSON.stringify({ tabs, activePath: state.activePath }))
      })
    }
  }
}
