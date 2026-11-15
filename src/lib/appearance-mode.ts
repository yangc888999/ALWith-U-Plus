// 外观材质：三档（Liquid Glass / Aero / 纯色），同时驱动**窗口**和 **CSS** 两层。
//
// 为什么要两层：
//   * 真正把桌面内容折射进来的材质来自 AppKit（`NSVisualEffectView` / macOS 26 的
//     `NSGlassEffectView`），只能由 Rust 侧挂到窗口上 —— 也就是 `commands.appearanceEffect`；
//   * 但材质要在 webview 里看得见，页面底色必须让出透明度，而且卡片/侧栏要跟着变半透明，
//     这套是 CSS 的事（`index.css` 里 `html[data-appearance=…]` 那几段）。
//
// 两条纪律：
//   1. **纯色是默认，也是「什么都没改」**。它不碰窗口、不碰 token，和升级前完全一样。
//   2. **不回谎报**。系统不支持窗口材质时（非 macOS / macOS 26 以下退到 vibrancy 也算支持），
//      store 里留下 `applied: false` 与原因，设置页据此显示一行说明，CSS 则回落到更不透明的
//     「厚玻璃」版本 —— 看起来仍然是这个风格，但不假装有折射。

import { isTauri } from "@tauri-apps/api/core"
import { useSyncExternalStore } from "react"

import { commands, type AppearanceEffect } from "@/bindings"

export const APPEARANCE_MODES = ["solid", "liquid-glass", "aero"] as const
export type AppearanceMode = (typeof APPEARANCE_MODES)[number]

const STORAGE_KEY = "alwith:appearance-mode"

const listeners = new Set<() => void>()

/** 当前模式；`solid` 是默认值，也是唯一「不透明」的一档。 */
let mode: AppearanceMode = readStored()

/** 透明度（0-100，越大越透）：只缩放窗口底色 / 卡片 / 侧栏的 alpha，不动文字与边框。 */
const TRANSPARENCY_KEY = "alwith:appearance-transparency"
/** 100 档把底色压到原 alpha 的 15%：再低就开始看不清内容，属于「看不见」而不是「透明」。 */
const TRANSPARENCY_FLOOR = 0.15
let transparency = readTransparency()

function readTransparency(): number {
  try {
    const raw = localStorage.getItem(TRANSPARENCY_KEY)
    if (raw === null || raw === "") return 0
    const value = Number(raw)
    if (!Number.isFinite(value)) return 0
    return Math.min(100, Math.max(0, Math.round(value)))
  } catch {
    return 0
  }
}

/**
 * 把透明度写成 `--appearance-alpha`，由 `index.css` 里各材质的 `calc()` 乘进 alpha。
 *
 * 用变量而不是逐档改 token：三个材质各有自己的基准透明度，乘同一个系数才能保证
 * 「同一根滑块，三档观感一致」。默认 0（系数 1）时与升级前逐像素相同。
 */
function paintTransparency(): void {
  if (typeof document === "undefined") return
  const alpha = 1 - (transparency / 100) * (1 - TRANSPARENCY_FLOOR)
  document.documentElement.style.setProperty("--appearance-alpha", alpha.toFixed(3))
  document.documentElement.dataset.appearanceTransparency = String(transparency)
}

/** 设置透明度：先落 CSS，再落存储。同一个值重复设置是无操作。 */
export function setAppearanceTransparency(next: number): void {
  const value = Math.min(100, Math.max(0, Math.round(next)))
  if (value === transparency) return
  transparency = value
  try {
    localStorage.setItem(TRANSPARENCY_KEY, String(value))
  } catch {
    // 存储不可用：本次运行有效。
  }
  paintTransparency()
  publish()
}

export function appearanceTransparencySnapshot(): number {
  return transparency
}

export function useAppearanceTransparency(): number {
  return useSyncExternalStore(subscribeAppearanceMode, appearanceTransparencySnapshot, appearanceTransparencySnapshot)
}
/** 最近一次原生切换的结果。`null` = 还没试过 / 不在 Tauri 里。 */
let effect: AppearanceEffect | null = null
/** 切换失败的原因（命令本身抛错时才有）。 */
let failure: string | null = null

function readStored(): AppearanceMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw !== null && (APPEARANCE_MODES as readonly string[]).includes(raw)) return raw as AppearanceMode
  } catch {
    // 存储不可用：本次运行就是默认的纯色。
  }
  return "solid"
}

function publish(): void {
  for (const listener of listeners) listener()
}

/**
 * 把模式写到 `<html data-appearance>`。
 *
 * 这一层必须**同步**完成：窗口材质是异步的，如果等它回来再改 CSS，用户会先看到一段
 * 「透明但还没上材质」的空白。CSS 先落地，材质随后补上（或者补不上，由 fallback 标记收场）。
 */
function paint(next: AppearanceMode): void {
  if (typeof document === "undefined") return
  document.documentElement.dataset.appearance = next
  // 换档时先当 CSS 模式：等原生确认之后再摘掉，避免半透明底在没有材质的那一瞬间露出来。
  if (next === "solid") delete document.documentElement.dataset.appearanceFallback
  else document.documentElement.dataset.appearanceFallback = "css"
}

/** 把原生材质切到该模式，并把结果记下来。失败不抛给调用者：这是装饰，不是功能。 */
async function applyNative(next: AppearanceMode): Promise<void> {
  if (!isTauri()) {
    effect = null
    failure = null
    markFallback(next, true)
    publish()
    return
  }
  try {
    // 命令成功时直接给出结果对象，失败时 reject —— 没有 `{ status, data }` 包装。
    effect = await commands.appearanceEffect({ mode: next })
    failure = null
    markFallback(next, effect.applied === false)
  } catch (error: unknown) {
    effect = null
    failure = error instanceof Error ? error.message : String(error)
    markFallback(next, true)
  }
  publish()
}

/**
 * `data-appearance-fallback="css"` 表示「窗口材质没上去，只有 CSS」。
 *
 * CSS 用它把透明度收回来一档：没有折射层还硬做 60% 半透明，会把桌面直接透成背景色一块脏
 * 东西。宁可厚一点，也不装成有材质。
 */
function markFallback(next: AppearanceMode, on: boolean): void {
  if (typeof document === "undefined") return
  if (on && next !== "solid") document.documentElement.dataset.appearanceFallback = "css"
  else delete document.documentElement.dataset.appearanceFallback
}

/** 设置模式：先落 CSS，再请原生材质。重复设置同一个值是无操作。 */
export function setAppearanceMode(next: AppearanceMode): void {
  if (next === mode) return
  mode = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 存储不可用：本次运行有效，下次启动回默认。
  }
  paint(next)
  publish()
  void applyNative(next)
}

/**
 * 启动时调用一次：把存下来的模式重新落到 DOM 和窗口上。
 *
 * 模块加载时就先 paint 一次：窗口是透明的（`tauri.conf` 的 `transparent: true`），如果等
 * React 挂载才写 `<html data-appearance>`，玻璃档会在样式表加载后短暂用不透明底色铺一遍，
 * 看起来像闪了一下。同步写在这里，样式表一到就是对的。
 */
paint(mode)
paintTransparency()

export function startAppearanceMode(): () => void {
  paint(mode)
  publish()
  void applyNative(mode)
  return () => undefined
}

/** 给「跟着系统深浅色切换」留的钩子：材质不需要重挂，但 CSS 透明度要靠 data 属性重算。 */
export function currentAppearanceMode(): AppearanceMode {
  return mode
}

export function appearanceModeSnapshot(): AppearanceMode {
  return mode
}

/** 最近一次原生结果，未尝试时为 null。 */
export function appearanceEffectSnapshot(): AppearanceEffect | null {
  return effect
}

/** 原生切换本身报错时的文案（不是「系统不支持」那种降级）。 */
export function appearanceFailureSnapshot(): string | null {
  return failure
}

export function subscribeAppearanceMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAppearanceMode(): AppearanceMode {
  return useSyncExternalStore(subscribeAppearanceMode, appearanceModeSnapshot, appearanceModeSnapshot)
}

export function useAppearanceEffect(): AppearanceEffect | null {
  return useSyncExternalStore(subscribeAppearanceMode, appearanceEffectSnapshot, appearanceEffectSnapshot)
}

export function useAppearanceFailure(): string | null {
  return useSyncExternalStore(subscribeAppearanceMode, appearanceFailureSnapshot, appearanceFailureSnapshot)
}
