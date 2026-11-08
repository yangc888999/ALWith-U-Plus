import { warn } from "@tauri-apps/plugin-log"
import { toast } from "sonner"

import { describeError } from "./error-text"
import { startupSilent } from "./startup-window"

let installed = false

/**
 * Localizes every string handed to `toast.error`, including package-level notices.
 *
 * Most call sites already call `describeError`, but packages (notably module-drive) and a few
 * settings rows still pass a raw English message. Wrapping the shared sonner object once catches
 * them all — including "The operation was aborted." — without touching each call site.
 *
 * 它同时是**启动期的唯一闸门**：引擎第一次 ready 之前，错误 toast 一律不上屏、只写日志。
 * 这覆盖了 `onHubExit`、`connect()` 的 catch、全局 unhandledrejection、`reportBackgroundError`
 * 以及各 feature 的启动 toast —— 不必逐个改调用点。真正的持续失败会在静默窗过期后照常弹出。
 */
export function installToastErrorLocalization(): void {
  if (installed) return
  installed = true
  const original = toast.error.bind(toast) as (...args: unknown[]) => unknown
  ;(toast as unknown as { error: (...args: unknown[]) => unknown }).error = (
    message: unknown,
    data?: unknown
  ) => {
    const text = typeof message === "string" ? describeError(message) : message
    if (startupSilent()) {
      const line = typeof text === "string" ? text : String(text)
      // 只记日志：这类失败多数是引擎冷启动 / 配置自愈的过程态，恢复后不该留任何痕迹。
      console.warn("[startup] suppressed error toast:", line)
      try {
        void Promise.resolve(warn(`[startup] suppressed error toast: ${line}`)).catch(() => undefined)
      } catch {
        // 日志通道本身不可用时也不许因此抛错。
      }
      return
    }
    return original(text, data)
  }
}
