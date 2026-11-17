import { useSyncExternalStore } from "react"

import { usePlatformAuth } from "@/features/auth/store"
import { isDriveVisible } from "@/features/drive/visibility"
import { drive } from "@/features/drive/controller"
import { settingsStore, updateSettings } from "@/lib/settings-store"

/**
 * 云盘的**产品级总开关**（设置 → 通用 → 关闭云盘）。
 *
 * 云盘本体已经整体换成上游 `ALwith-ai/alwith-u` 的实现，上游的可见性规则只有一条：
 * 「已登录且邮箱属于公司域」(`isDriveVisible`)。但产品要求用户能自己关掉云盘，所以这一层
 * 保留在应用侧，不塞回 `features/drive` 里——上游文件保持可整体覆盖。
 *
 * 语义：
 *   * 开关关闭 → 侧栏入口、设置里的云盘分组都消失，并立即停掉同步与连接；
 *   * 开关打开 → 仍需满足上游规则（未登录时不会凭空出现云盘）。
 */
const KEY = "drive.yupEnabled"

const subscribe = (notify: () => void): (() => void) => settingsStore.subscribe(notify)
const read = (): boolean => settingsStore.get<boolean>(KEY) ?? true

/** 用户开关（不看登录态）。 */
export function useDriveEnabledPreference(): boolean {
  return useSyncExternalStore(subscribe, read)
}

/** 最终是否显示云盘：用户开关 + 上游的账号规则，两者都为真才显示。 */
export function useDriveEnabled(): boolean {
  const preference = useDriveEnabledPreference()
  const visible = usePlatformAuth((state) => isDriveVisible(state.isAuthenticated, state.user?.login_email))
  return preference && visible
}

export function setDriveEnabled(enabled: boolean): Promise<void> {
  return (async () => {
    await updateSettings({ [KEY]: enabled })
    if (!enabled) {
      // 从未启动过的 drive 会直接拒绝 stop，忽略即可——连接由 `useDriveConnection` 负责释放。
      await drive.request({ type: "stop" }).catch(() => undefined)
    }
  })()
}
