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
}

export function subscribeCompanyModelDisplayName(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
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
