// Settings open/close entry points. The settings surface now lives inside the main window as an
// overlay (see `settings-overlay.ts`); these functions only drive that store so every historical
// call site keeps working unchanged.

import { openSettingsOverlay, toggleSettingsOverlay } from "@/lib/settings-overlay"

export type SettingsSection =
  | "mobile"
  | "trackpad"
  | "general"
  | "editor"
  | "appearance"
  | "account"
  | "provider"
  | "voice"
  | "computer"
  | "extensions"
  | "skills"
  | "groups"
  | "drive"
  | "usage"
  | "automation"
  | "about"
export const SETTINGS_SECTIONS: SettingsSection[] = [
  "account",
  "general",
  "provider",
  "appearance",
  "editor",
  "drive",
  "voice",
  "trackpad",
  "computer",
  "mobile",
  "extensions",
  "skills",
  "usage",
  "automation",
  "about"
]
/** Default window width is sized around the usage overview's 3×3 stat grid: 240px sidebar +
 *  48px page padding + three ~180px columns + two 16px gutters, plus slack. Every settings
 *  section shares this reference width; the grid never grows past three columns on a wider
 *  window and drops to two only when the user deliberately narrows below 860px. */
export const SETTINGS_DEFAULT_WIDTH = 880
export const SETTINGS_DEFAULT_HEIGHT = 800
export const SETTINGS_CHANGE_TAB = "settings-change-tab"
/** Close hides this window instead of destroying it, so its scroll offset survives. Emitted on
 *  every reopen so the page header and the first card (the usage overview) are visible again. */
export const SETTINGS_RESET_SCROLL = "settings-reset-scroll"

export type SettingsTarget = { providerId?: string }
export type SettingsNavigation = { section: SettingsSection; providerId?: string }

/** Click-again closes: the rail's avatar/gear toggle Settings instead of stacking focus. */
export async function toggleSettingsWindow(section?: SettingsSection, target: SettingsTarget = {}): Promise<void> {
  toggleSettingsOverlay(section, target)
}

/** Open (or re-target) the in-main-window settings overlay. The separate settings window is gone,
 *  so this is instant and never pulls focus out of a full-screen chat. */
export async function openSettingsWindow(section?: SettingsSection, target: SettingsTarget = {}): Promise<void> {
  openSettingsOverlay(section, target)
}

