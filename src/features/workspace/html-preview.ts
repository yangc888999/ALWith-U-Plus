import type { PreviewHost } from "@alwith/module-editor/previews"
import { type FileSystem } from "@alwith/module-fs/core"
import { info } from "@tauri-apps/plugin-log"
import { toast } from "sonner"

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>

/**
 * The native HTML preview host, plus the self-write suppression the WYSIWYG editor needs.
 *
 * The provider rebuilds the iframe on *any* change in the document's directory (css, siblings,
 * agent writes). Saving the edited document would therefore tear down the very frame the user is
 * typing in. Three layers keep the frame alive:
 *  1. `markSelfWrite(path)` records our own saves; a watch event for that exact path within
 *     SELF_WRITE_WINDOW is ignored (sibling changes still refresh).
 *  2. `setEditing(path, true)` suspends rebuilds for that document entirely; events are held and
 *     replayed once editing ends, so the caret and undo stack survive a save.
 *  3. The global watch relay is untouched — agent replay behavior is unchanged.
 */
export interface HtmlPreviewHostControl {
  /** Record that we just wrote `path` ourselves, so the resulting watch event is not a rebuild. */
  markSelfWrite: (path: string) => void
  /** Suspend rebuilds for `path` while it is being edited; replay held changes when it ends. */
  setEditing: (path: string, editing: boolean) => void
}

export type HtmlPreviewHost = NonNullable<PreviewHost["htmlPreview"]> & HtmlPreviewHostControl

/** How long a self-write suppresses the matching watch event. */
const SELF_WRITE_WINDOW = 1200

/** Native capabilities share the workspace's authorization and existing filesystem watcher. */
export function createHtmlPreviewHost(
  root: string,
  fs: FileSystem,
  invoke: Invoke,
  windows: boolean
): HtmlPreviewHost {
  const selfWrites = new Map<string, number>()
  const editing = new Set<string>()
  const held = new Map<string, () => void>()

  const isSelfWrite = (path: string): boolean => {
    const at = selfWrites.get(path)
    if (at === undefined) return false
    if (Date.now() - at < SELF_WRITE_WINDOW) return true
    selfWrites.delete(path)
    return false
  }

  return {
    markSelfWrite(path) {
      selfWrites.set(path, Date.now())
    },
    setEditing(path, on) {
      if (on) {
        editing.add(path)
        return
      }
      editing.delete(path)
      const replay = held.get(path)
      if (replay !== undefined) {
        held.delete(path)
        replay()
      }
    },
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
          dispose() {
            // Non-blocking: fire the close without awaiting it so tab close never stalls on the
            // round-trip. The returned promise still satisfies the PreviewHost `() => Promise<void>`
            // contract; T01 already removed the close-time rebuild wave that this guarded against.
            return invoke("html_preview_close", { token })
              .then(() => {})
              .catch(() => {})
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
        return fs.subscribe((change) => {
          const paths =
            change.type === "change" ? change.paths : "to" in change ? [change.path, change.to] : [change.path]
          // Only rebuild when the previewed file *itself* changes. This used to be a directory-level
          // subscription: `paths.some((changed) => containsPath(directory, changed) || containsPath(changed, directory))`.
          // Any sibling write, Finder's .DS_Store churn, or an agent writing a sibling file tore down
          // and rebuilt the whole iframe (2 IPC round-trips plus a protocol re-fetch of every css/js/img).
          // That made opening feel slow and made closing slow too, because saving a sibling on tab close
          // fanned into reloading the other previews in the same directory. We now react only to `path`.
          // Trade-off: a referenced sub-resource (css/js/img) changing no longer auto-refreshes this
          // preview in the same tick — the user can re-save the document or rely on the next rebuild.
          const selfWriteOfThis = paths.some((p) => p === path) && paths.every((p) => isSelfWrite(p))
          if (selfWriteOfThis) return
          // Ignore sibling files, directory noise and .DS_Store: only the previewed file matters.
          if (!paths.some((p) => p === path)) return
          // Editing this document: hold the rebuild until editing ends.
          if (editing.has(path)) {
            held.set(path, onChange)
            return
          }
          onChange()
        })
      })
    }
  }
}
