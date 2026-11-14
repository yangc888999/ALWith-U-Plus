import { info } from "@tauri-apps/plugin-log"
import { settingsStore, updateSettings } from "@/lib/settings-store"
import { drive } from "@/features/drive/controller"

/**
 * First-run default sync selection.
 *
 * The engine's own default pins every root it can see, which downloads the whole company
 * library onto the machine. The product default is the opposite: one workspace
 * (部门/Operation/资料库/02_用户经营) stays selected and everything else is unpinned. The
 * engine has no server-side notion of this, so the host applies it once, on the first
 * snapshot that carries roots — `drive.rootDefaultsApplied` in the settings store marks it
 * done and every later snapshot (and every other root the server adds later) is left alone.
 */
const FLAG = "drive.rootDefaultsApplied"
const DEFAULT_ROOT_PATH = "部门/Operation/资料库/02_用户经营"

let applied = false

function desiredRoots(): boolean {
  return settingsStore.get<boolean>(FLAG) === true
}

export function watchDriveRootDefaults(): void {
  // The controller deduplicates refreshes, so a light poll is enough: this only runs until the
  // flag is written, and each tick is a subscribe-read, not a Drive request.
  const timer = setInterval(() => {
    if (applied || desiredRoots()) {
      if (timer !== undefined) clearInterval(timer)
      return
    }
    const roots = drive.getSnapshot().snapshot?.roots
    if (roots === undefined || roots.length === 0) return
    applied = true
    if (timer !== undefined) clearInterval(timer)
    const defaultRoot = roots.find((root) => root.drivePath === DEFAULT_ROOT_PATH || root.name === DEFAULT_ROOT_PATH)
    const changes = roots
      .filter((root) => root.kind !== "SKILL" && root.projectKey !== "ai-session-archive" && root.canWrite)
      .map((root) => ({ root, pinned: root === defaultRoot }))
      .filter(({ root, pinned }) => root.selected !== pinned)
    if (changes.length === 0) {
      void updateSettings({ [FLAG]: true }).catch(() => undefined)
      return
    }
    void (async () => {
      for (const { root, pinned } of changes) {
        try {
          await drive.request({ type: "pin", projectId: root.projectId, pinned })
        } catch (error: unknown) {
          applied = false
          void info(`[drive-root-defaults] pin ${root.drivePath} -> ${pinned} failed: ${String(error)}`)
          return
        }
      }
      await updateSettings({ [FLAG]: true }).catch(() => undefined)
      void info(`[drive-root-defaults] applied: ${changes.length} root(s) re-pinned, default = ${DEFAULT_ROOT_PATH}`)
    })()
  }, 1500)
}
