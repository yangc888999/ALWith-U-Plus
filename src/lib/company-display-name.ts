/**
 * Custom display name for the company (enterprise) model channel.
 *
 * The channel's real name comes from the Finture gateway catalog (e.g. "企业内部模型"), and the
 * settings list falls back to the generic "公司模型". Users want to rename it to something that
 * reflects the actual model (e.g. "Deepseek Flash"). One global name covers the whole channel:
 * the desktop ships a single company channel, and the picker/sidebar/card all read this helper so
 * the rename stays consistent everywhere.
 *
 * Stored in localStorage (like company-model-config) so it survives restarts; an empty value means
 * "use the default name".
 */
import { useSyncExternalStore } from "react"

const STORAGE_KEY = "alwith:company-model-display-name"
const listeners = new Set<() => void>()
let cache: string | null = null

function read(): string {
  if (cache !== null) return cache
  let value = ""
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw !== null) value = raw
  } catch {
    // Storage can be unavailable; the default name applies for this launch.
  }
  cache = value
  return value
}

/** The custom display name, or "" when the default name should be used. */
export function getCompanyModelDisplayName(): string {
  return read()
}

/** Sets or clears the custom display name. An empty/whitespace value clears it. */
export function setCompanyModelDisplayName(name: string): void {
  const next = name.trim()
  if (cache !== null && cache === next) {
    cache = next
    return
  }
  cache = next
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage can be unavailable; the in-memory value still works for this launch.
  }
  for (const listener of listeners) listener()
  // Tauri 的多窗口 webview 不一定触发浏览器原生 storage 事件；主动广播一个
  // 同源自定义事件，聊天窗口可立即重建模型分组，而无需重启或重新打开会话。
  window.dispatchEvent(new CustomEvent("alwith:company-model-display-name-changed", { detail: next }))
}

export function subscribeCompanyModelDisplayName(listener: () => void): () => void {
  listeners.add(listener)
  // 设置页与聊天页可能运行在不同的 Tauri webview。localStorage 的 storage 事件是
  // 跨 webview 同源同步的唯一可靠通知；之前只通知当前 webview，所以设置里改名后
  // 聊天窗口仍一直显示旧的「企业内部模型」。
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY) return
    cache = event.newValue?.trim() ?? ""
    listener()
  }
  const onChanged = (): void => {
    cache = (() => {
      try { return localStorage.getItem(STORAGE_KEY)?.trim() ?? "" } catch { return "" }
    })()
    listener()
  }
  window.addEventListener("storage", onStorage)
  window.addEventListener("alwith:company-model-display-name-changed", onChanged)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
    window.removeEventListener("alwith:company-model-display-name-changed", onChanged)
  }
}

/** `useSyncExternalStore` snapshot; the stored string identity is stable until it changes. */
export function useCompanyModelDisplayName(): string {
  return useSyncExternalStore(subscribeCompanyModelDisplayName, getCompanyModelDisplayName, getCompanyModelDisplayName)
}

/** Returns the custom name when set, otherwise the supplied default (provider name or "公司模型"). */
export function companyModelLabel(fallback: string): string {
  const custom = getCompanyModelDisplayName()
  return custom.length > 0 ? custom : fallback
}
