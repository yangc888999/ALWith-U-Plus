/**
 * In-app settings overlay state.
 *
 * Earlier releases opened Settings as a separate Tauri `WebviewWindow`. That had three user-visible
 * problems: the cold window took a beat to appear (sometimes needed a second click), opening it
 * while the main window was full-screen pulled focus out of the chat, and collapsing the sidebar
 * repainted the portal it lived in. Settings now renders inside the main window as an overlay driven
 * by this single store, so every `openSettingsWindow` / `toggleSettingsWindow` call just updates
 * state — the window is gone, the three symptoms with it.
 *
 * Kept deliberately small: one snapshot object, referentially stable between changes so
 * `useSyncExternalStore` never loops.
 */
import { useSyncExternalStore } from "react"

import type { SettingsSection, SettingsTarget } from "@/lib/window-manager"

export type SettingsOverlayState = {
  open: boolean
  section: SettingsSection
  providerId?: string
}

let state: SettingsOverlayState = { open: false, section: "general", providerId: undefined }
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): SettingsOverlayState {
  return state
}

/** Open (or re-target) the settings overlay on a given section. */
export function openSettingsOverlay(section?: SettingsSection, target: SettingsTarget = {}): void {
  state = { open: true, section: section ?? "general", providerId: target.providerId }
  emit()
}

/** Click-again closes: the rail's avatar / gear toggle Settings instead of stacking focus. */
export function toggleSettingsOverlay(section?: SettingsSection, target: SettingsTarget = {}): void {
  if (state.open) {
    closeSettingsOverlay()
    return
  }
  openSettingsOverlay(section, target)
}

export function closeSettingsOverlay(): void {
  state = { ...state, open: false }
  emit()
}

/** Section chosen inside the embedded SettingsPage (sidebar nav); keeps the store in step so a
 *  later `open(section)` that matches the current one still re-syncs the mounted page. */
export function setSettingsOverlaySection(section: SettingsSection, providerId?: string): void {
  state = { ...state, section, providerId }
  emit()
}

export function useSettingsOverlay(): SettingsOverlayState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Current state without React — for tests and any non-component reader. */
export function getSettingsOverlayState(): SettingsOverlayState {
  return state
}
