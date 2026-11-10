import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import { reportBackgroundError } from "@/lib/background-errors"
import { settingsStore, updateSettings } from "@/lib/settings-store"

/**
 * 云盘「防旧版本覆盖」开关。
 *
 * 云端已经写入的旧版本无法撤回，所以防护只能在本地做：开启后本地端维护每个云盘文件的内容
 * 指纹和历史，一旦守护进程把「本机见过、且不是最新」的内容重新写回来（典型来源就是另一台
 * 设备上传的旧版本），就用本机影子副本还原，并把这次拦截告诉用户。用户自己刚保存过的文件
 * 有 15 秒宽限期，不会被误判成回滚。
 *
 * 默认关闭：关闭即恢复云盘原有机制，不记录指纹、不保留影子副本、不做任何还原。
 */
const KEY = "drive.versionGuard"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)
const read = () => settingsStore.get<boolean>(KEY) ?? false

export function versionGuardEnabled(): boolean {
  return read()
}

export function setVersionGuardEnabled(enabled: boolean): Promise<void> {
  if (enabled === read()) return Promise.resolve()
  return updateSettings({ [KEY]: enabled })
}

export function useVersionGuard(): [boolean, (enabled: boolean) => void] {
  const stored = useSyncExternalStore(subscribe, read)
  const [enabled, setEnabled] = useState(stored)
  // Another window (or Settings) changed it: follow the store.
  useEffect(() => setEnabled(stored), [stored])
  const update = useCallback((next: boolean): void => {
    setEnabled(next)
    void setVersionGuardEnabled(next).catch((error: unknown) =>
      reportBackgroundError("version-guard", error)
    )
  }, [])
  return [enabled, update]
}
