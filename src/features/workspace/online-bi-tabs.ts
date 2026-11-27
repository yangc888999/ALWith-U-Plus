import { normalizeOnlineBiReportUrl, onlineBiStoredReportUrl } from "./online-bi"

export interface OnlineBiTab {
  id: string
  label: string
  /** Normalized report address without `?s=` or embed-only flags. */
  url: string
}

export interface OnlineBiTabsState {
  tabs: OnlineBiTab[]
  activeId: string
}

const STORAGE_KEY = "alwith:online-bi-tabs-v1"
const MAX_TABS = 30

function newTabId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `bi-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function fallbackState(defaultLabel: string): OnlineBiTabsState {
  const tab = { id: newTabId(), label: defaultLabel, url: onlineBiStoredReportUrl() }
  return { tabs: [tab], activeId: tab.id }
}

export function loadOnlineBiTabs(defaultLabel = "个人看板"): OnlineBiTabsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return fallbackState(defaultLabel)
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeId?: unknown }
    if (!Array.isArray(parsed.tabs)) return fallbackState(defaultLabel)
    const ids = new Set<string>()
    const tabs = parsed.tabs.flatMap((entry): OnlineBiTab[] => {
      if (typeof entry !== "object" || entry === null) return []
      const value = entry as Record<string, unknown>
      if (typeof value.id !== "string" || typeof value.label !== "string" || typeof value.url !== "string") return []
      const id = value.id.trim()
      const label = value.label.trim()
      const url = normalizeOnlineBiReportUrl(value.url)
      if (id === "" || label === "" || url === null || ids.has(id)) return []
      ids.add(id)
      return [{ id, label: label.slice(0, 40), url }]
    })
    if (tabs.length === 0) return fallbackState(defaultLabel)
    const limited = tabs.slice(0, MAX_TABS)
    const activeId =
      typeof parsed.activeId === "string" && limited.some((tab) => tab.id === parsed.activeId)
        ? parsed.activeId
        : limited[0]!.id
    return { tabs: limited, activeId }
  } catch {
    return fallbackState(defaultLabel)
  }
}

export function saveOnlineBiTabs(state: OnlineBiTabsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: state.tabs.slice(0, MAX_TABS), activeId: state.activeId }))
  } catch {
    // The in-memory tabs still work for this session when storage is unavailable.
  }
}

export function createOnlineBiTab(label: string, url: string): OnlineBiTab | null {
  const normalized = normalizeOnlineBiReportUrl(url)
  const trimmed = label.trim()
  if (normalized === null || trimmed === "") return null
  return { id: newTabId(), label: trimmed.slice(0, 40), url: normalized }
}
