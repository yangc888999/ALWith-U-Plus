import { containsPath, createFileSystem, type FileSystem } from "@alwith/module-fs"
import { createTauriAdapter } from "@alwith/module-fs/tauri"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"

import { commands } from "@/bindings"
import { text } from "@/lib/text"

import { drive } from "./controller"

/** Authorize only paths belonging to indexed Drive projects, including launcher searches. */
export async function driveFileSystem(path: string): Promise<FileSystem> {
  const snapshot = drive.getSnapshot().snapshot
  const root = snapshot?.roots
    .filter((root) => root.drivePath && containsPath(root.localPath, path))
    .toSorted((a, b) => b.localPath.length - a.localPath.length)[0]
  if (!root) throw new Error("This path does not belong to an indexed Drive project")
  // `@alwith/module-fs/commands` 只存在于 0.6.x；本应用的 0.1.0-rc 用同名的 Rust 命令
  // `workspace_open` / `workspace_file`，参数形状一致。适配器也不需要 `watch`（上游这里传
  // false，等价于不订阅）。
  const authorized = await invoke<string>("workspace_open", { path: root.localPath })
  return createFileSystem({
    adapter: createTauriAdapter({
      root: authorized,
      transport: { invoke: (request) => invoke("workspace_file", { request }) }
    }),
    reportError: (error) => toast.error(text(error))
  })
}

/** Check indexed cloud paths without opening a workspace that may not exist yet. */
export async function drivePathExists(path: string): Promise<boolean> {
  return commands.drivePathExists({ path })
}
