// 外观材质：两档（玻璃 / 纯色），同时驱动**窗口**和 **CSS** 两层。
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
import { emit, listen } from "@tauri-apps/api/event"
import { useSyncExternalStore } from "react"

import { commands, type AppearanceEffect } from "@/bindings"

export const APPEARANCE_MODES = ["solid", "aero"] as const
export type AppearanceMode = (typeof APPEARANCE_MODES)[number]

const STORAGE_KEY = "alwith:appearance-mode"

const listeners = new Set<() => void>()

/** 当前模式；纯色是默认，`aero` 是固定的毛玻璃档。 */
let mode: AppearanceMode = readStored()

/**
 * 毛玻璃档的固定不透明度。工作工具优先可读性，不再暴露透明度滑块：
 * 纯色档 alpha = 1；毛玻璃固定到 0.82（约 18% 透出桌面），既看得到雾面，
 * 又不会让壁纸杂色压过正文。
 */
const FROSTED_ALPHA = 0.82
const LEGACY_TRANSPARENCY_KEYS = [
  "alwith:appearance-transparency",
  "alwith:appearance-transparency:solid",
  "alwith:appearance-transparency:liquid-glass"
]

/** 旧版透明度只留清理：不读取、不写入，避免残留值继续影响底色。 */
try {
  for (const key of [...LEGACY_TRANSPARENCY_KEYS, "alwith:appearance-optimal-default"]) {
    localStorage.removeItem(key)
  }
} catch {
  // 存储不可用：本次运行就是默认值。
}

/**
 * 把固定透明度写成 `--appearance-alpha`，由 `index.css` 里各材质的 `calc()` 乘进 alpha。
 * 这一段不再读取用户输入：材质档只决定「纯色 / 毛玻璃」，不决定透明度。
 */
function paintSurfaceAlpha(): void {
  if (typeof document === "undefined") return
  const alpha = mode === "solid" ? 1 : FROSTED_ALPHA
  document.documentElement.style.setProperty("--appearance-alpha", alpha.toFixed(3))
}

/**
 * 跨窗口广播：WKWebView 的多个 webview 各有独立 JS 上下文，localStorage 写入**不会**在
 * 另一个 webview 里触发 `storage` 事件（设置页换成玻璃、主窗口没跟着变就是这么来的）。
 * Tauri 的全局事件才是可靠通道：谁改了，就把值广播给所有窗口。
 */
const APPEARANCE_EVENT = "appearance:changed"

function broadcast(): void {
  if (!isTauri()) return
  void emit(APPEARANCE_EVENT, { mode }).catch(() => undefined)
}
/** 最近一次原生切换的结果。`null` = 还没试过 / 不在 Tauri 里。 */
let effect: AppearanceEffect | null = null
/** 切换失败的原因（命令本身抛错时才有）。 */
let failure: string | null = null

function readStored(): AppearanceMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === "solid" || raw === "aero") return raw
    // The old Liquid Glass choice becomes the product's frosted-glass choice.
    if (raw === "liquid-glass") return "aero"
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
  // 切档同时重算底色 alpha：纯色恒为 1，玻璃固定到清晰优先的 0.90。
  paintSurfaceAlpha()
  publish()
  broadcast()
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
paintSurfaceAlpha()

export function startAppearanceMode(): () => void {
  paint(mode)
  publish()
  void applyNative(mode)
  return () => undefined
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

// ---------------------------------------------------------------------------------------------
// 跨窗口同步（主窗口 ↔ 设置窗口）
//
// 设置窗口与主窗口是两个 webview：在设置里换材质，改的是**本窗口**的
// `--appearance-alpha` / `data-appearance`，主窗口既没有 storage 监听也不会重绘 —— 于是
// 「设置页换了、主界面没反应」。localStorage 同源共享，`storage` 事件就是那条现成的通道：
// 读到别人的写入后，本窗口按同一份值重绘（材质那层由 Rust 命令作用于主窗口，这里只负责 DOM）。
/** 由 App 启动时调用一次：订阅别的窗口发来的材质变更。 */
export function startAppearanceSync(): void {
  if (!isTauri()) return
  void listen<{ mode: AppearanceMode }>(APPEARANCE_EVENT, (event) => {
    const payload = event.payload
    if (payload === null || typeof payload !== "object") return
    const nextMode = (APPEARANCE_MODES as readonly string[]).includes(payload.mode) ? payload.mode : mode
    if (nextMode === mode) return
    mode = nextMode
    paint(mode)
    paintSurfaceAlpha()
    publish()
  }).catch(() => undefined)
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return
    const nextMode = readStored()
    if (nextMode === mode) return
    mode = nextMode
    paint(mode)
    paintSurfaceAlpha()
    publish()
  })
}
