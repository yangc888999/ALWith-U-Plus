import { createContext, useContext } from "react"
export interface FilePosition {
  lineNumber: number
  column: number
}

export interface WorkspaceActions {
  visible: boolean
  viewMode?: boolean
  /** `workspace !== null && cwd !== null`: the button's selected state must match the real columns. */
  directoryReady?: boolean
  toggle: () => void
  /** The one action behind 四方格 / 文件栏 / 折叠态 FolderTree. */
  showProjectTree?: () => void
  openFile: (path: string, root: string | null, position?: FilePosition) => Promise<void>
  openProject: (path: string) => Promise<void>
  revealEntry: (path: string, root: string) => Promise<void>
}
export const WorkspaceContext = createContext<WorkspaceActions | null>(null)
export function useWorkspace(): WorkspaceActions | null {
  return useContext(WorkspaceContext)
}

export const WorkspaceHeaderContext = createContext<HTMLElement | null>(null)
