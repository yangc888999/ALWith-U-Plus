import { useSyncExternalStore } from "react"

import { startupSilent, startupStalled, subscribeStartupWindow } from "./startup-window"

/**
 * 现在是启动静默期吗（引擎还没第一次 ready）。四个错误出口都用它决定"要不要上屏"。
 * 不在服务端渲染，第三个参数只是给 useSyncExternalStore 一个稳定快照。
 */
export function useStartupSilent(): boolean {
  return useSyncExternalStore(subscribeStartupWindow, startupSilent, () => false)
}

/**
 * 静默期已经久到可以显示一句中性的「正在启动」。热启动下始终是 false —— 不画东西，
 * 所以不会出现"闪一下"（哪怕是灰字）。
 */
export function useStartupStalled(): boolean {
  return useSyncExternalStore(subscribeStartupWindow, startupStalled, () => false)
}
