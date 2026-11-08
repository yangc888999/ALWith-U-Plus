import { useSyncExternalStore } from "react"

import {
  getWorkspaceLayout,
  subscribeWorkspaceLayout,
  type WorkspaceLayoutPreferences,
  workspaceLayoutDefaults
} from "./layout-preferences"

/** Live view of the persisted panel widths; updates immediately when Settings saves. */
export function useWorkspaceLayout(): WorkspaceLayoutPreferences {
  return useSyncExternalStore(subscribeWorkspaceLayout, getWorkspaceLayout, () => workspaceLayoutDefaults)
}
