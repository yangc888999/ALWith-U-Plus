// 云盘防旧版本覆盖的运行时：把设置开关推给 Rust，并在开启期间周期性跑一次扫描。
//
// 扫描本身在 Rust 侧完成（读指纹、比对历史、必要时用影子副本还原），这里只负责：
// 1. 把开关状态同步给 `drive_guard_set_enabled`；
// 2. 开启时按固定节奏调用 `drive_guard_scan`，让被守护进程写回的旧版本在几分钟内被还原；
// 3. 把 `drive:version-guard-restored` 事件变成一条用户能看到的 Toast。
//
// 关闭时什么都不做：没有定时器、没有指纹、没有影子副本。
import { listen } from "@tauri-apps/api/event"
import { info } from "@tauri-apps/plugin-log"
import { useEffect } from "react"
import { toast } from "sonner"

import { commands } from "@/bindings"
import { reportBackgroundError } from "@/lib/background-errors"
import { settingsStore } from "@/lib/settings-store"
import i18n from "@/lib/i18n"

import { useVersionGuard } from "./version-guard-preference"

const KEY = "drive.versionGuard"
/** One pass every five minutes: the daemon syncs on its own schedule, and hashing a Drive is
 *  cheap enough at this cadence to stay invisible but fast enough to rescue a rollback before the
 *  user opens the file. */
const SCAN_INTERVAL_MS = 5 * 60_000
const FIRST_SCAN_MS = 30_000

export function useDriveVersionGuard(): void {
  const [enabled] = useVersionGuard()

  useEffect(() => {
    void commands.driveGuardSetEnabled({ enabled }).catch((error: unknown) => {
      reportBackgroundError("version-guard-toggle", error)
    })
    if (!enabled) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let busy = false
    const run = (): void => {
      if (disposed) return
      if (busy || !(settingsStore.get<boolean>(KEY) ?? false)) {
        schedule(SCAN_INTERVAL_MS)
        return
      }
      busy = true
      void commands
        .driveGuardScan()
        .then((report) => {
          if (report.restored.length > 0) {
            void info(`[version-guard] restored ${report.restored.length} file(s)`)
          }
        })
        .catch((error: unknown) => reportBackgroundError("version-guard-scan", error))
        .finally(() => {
          busy = false
          schedule(SCAN_INTERVAL_MS)
        })
    }
    const schedule = (delay: number): void => {
      if (disposed) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(run, delay)
    }
    schedule(FIRST_SCAN_MS)
    const stopSettings = settingsStore.subscribe((keys) => {
      if (!keys.includes(KEY)) return
      if (!(settingsStore.get<boolean>(KEY) ?? false) && timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    })
    const stopEvent = listen<{ path: string }>("drive:version-guard-restored", (event) => {
      const name = event.payload.path.split("/").pop() ?? event.payload.path
      toast.warning(i18n.t("drive.versionGuardRestored", { name }), { duration: 10_000 })
    })
    return () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      stopSettings()
      void stopEvent.then((stop) => stop()).catch(() => {})
    }
  }, [enabled])
}
