import type { PreviewHost } from "@alwith/module-editor/previews"
import { containsPath, dirname, type FileSystem } from "@alwith/module-fs/core"
import { info } from "@tauri-apps/plugin-log"
import { toast } from "sonner"

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>

/** Native capabilities share the workspace's authorization and existing filesystem watcher. */
export function createHtmlPreviewHost(
  root: string,
  fs: FileSystem,
  invoke: Invoke,
  windows: boolean
): NonNullable<PreviewHost["htmlPreview"]> {
  return {
    async open(path, source) {
      try {
        const result = await invoke("html_preview_open", { root, path, source })
        if (
          result === null ||
          typeof result !== "object" ||
          !("token" in result) ||
          !("path" in result) ||
          typeof result.token !== "string" ||
          typeof result.path !== "string"
        )
          throw new Error("Invalid native HTML preview response")
        const token = result.token
        const resource = [token, ...result.path.split("/")].map(encodeURIComponent).join("/")
        return {
          url: `${windows ? "http://preview-html.localhost" : "preview-html://localhost"}/${resource}`,
          async dispose() {
            await invoke("html_preview_close", { token })
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        void info(`[html-preview] open failed root=${root} path=${path} error=${message}`)
        // A Drive placeholder (.yupcloud) or a file still downloading is a sync state, not a
        // broken report. The native command rejects it with this exact message. Rethrowing let the
        // preview retry loop stack one error toast per attempt (three white cards on top of each
        // other); one deduplicated notice and a blank surface is calmer and actionable.
        if (message.includes("HTML preview must reference a file")) {
          toast.error("这个文件还没同步到本地（或已被移走），等云盘下载完成后再打开", {
            id: "html-preview-missing",
            duration: 6_000
          })
          return { url: "about:blank", dispose: async () => {} }
        }
        throw error
      }
    },
    subscribe(path, onChange) {
      return Promise.try(() => {
        const directory = dirname(path)
        return fs.subscribe((change) => {
          const paths =
            change.type === "change" ? change.paths : "to" in change ? [change.path, change.to] : [change.path]
          if (paths.some((changed) => containsPath(directory, changed) || containsPath(changed, directory))) onChange()
        })
      })
    }
  }
}
