// Small per-user preferences. Codex owns every conversation; this file only
// remembers what the user was looking at and which language they chose.
import { invoke } from "@tauri-apps/api/core"
import { emit } from "@tauri-apps/api/event"
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"

import type { NavigationInstrument, NavigationSoundMode } from "@/features/chat/codex/navigation-instruments"

import { FONT_SIZE_DEFAULTS, resolveFontSizes, type FontSizes } from "./font-size"
import { setProjectAppPreference } from "./project-app-preference"
import { settingsStore, updateSettings } from "./settings-store"
import { DEFAULT_UI_FONT, resolveUiFont, type UiFont } from "./ui-font"

export type Preferences = {
  composerPredictions?: boolean
  sidebarPinned: boolean
  chatWindowShortcut?: string
  lastProjectDirectory: string | null
  /** Which new-task tab the next launch opens on. */
  defaultStartSurface: "chat" | "work"
  language: string | null
  zoomLevel: number | null
  /** Installed system family used by the application chrome. */
  uiFont: UiFont
  /** Per-location text sizes; the defaults are the recommended 14/14/13px. */
  fontSizes: FontSizes
  /** Explicit model choices are independent for the main and floating chat slots. */
  modelSelections: { main: string | null; chat: string | null }
  /** Sounds the user-message navigation rail plays (ALwith Desktop's navigation melody). */
  navigationSoundMode: NavigationSoundMode
  navigationInstrument: NavigationInstrument
  /** Bundle id (Windows: exe path) of the app "Open in …" last used for a project. */
  externalEditor: string | null
  /** Local profile overrides, attributed to the account that set them. */
  profileNickname: string | null
  profileAvatar: string | null
  profileOwner: string | null
}

const preferenceKeys: Record<keyof Preferences, string> = {
  composerPredictions: "chat.composerPredictions",
  sidebarPinned: "appearance.sidebarPinned",
  chatWindowShortcut: "chat.windowShortcut",
  lastProjectDirectory: "general.lastProjectDirectory",
  defaultStartSurface: "general.defaultStartSurface",
  language: "general.language",
  zoomLevel: "appearance.zoomLevel",
  uiFont: "appearance.uiFont",
  fontSizes: "appearance.fontSizes",
  modelSelections: "chat.modelSelections",
  navigationSoundMode: "chat.navigationSoundMode",
  navigationInstrument: "chat.navigationInstrument",
  externalEditor: "general.externalEditor",
  profileNickname: "profile.nickname",
  profileAvatar: "profile.avatar",
  profileOwner: "profile.owner"
}
const store = {
  get<T>(key: keyof Preferences): Promise<T | undefined> {
    return Promise.try(() => {
      return settingsStore.get<T>(preferenceKeys[key])
    })
  }
}

/** The values a fresh install starts with; also the fallback when the store cannot be read. */
export function defaultPreferences(): Preferences {
  return {
    composerPredictions: true,
    sidebarPinned: true,
    chatWindowShortcut: "Alt+Space",
    lastProjectDirectory: null,
    defaultStartSurface: "chat",
    language: null,
    zoomLevel: null,
    uiFont: DEFAULT_UI_FONT,
    fontSizes: { ...FONT_SIZE_DEFAULTS },
    modelSelections: { main: null, chat: null },
    navigationSoundMode: "scale",
    navigationInstrument: "acoustic_grand_piano",
    externalEditor: null,
    profileNickname: null,
    profileAvatar: null,
    profileOwner: null
  }
}

export async function loadPreferences(): Promise<Preferences> {
  await settingsStore.read()
  const [
    lastProjectDirectory,
    defaultStartSurface,
    language,
    zoomLevel,
    modelSelections,
    navigationSoundMode,
    navigationInstrument,
    externalEditor,
    sidebarPinned,
    uiFont,
    fontSizes
  ] = await Promise.all([
    store.get<string>("lastProjectDirectory"),
    store.get<"chat" | "work">("defaultStartSurface"),
    store.get<string>("language"),
    store.get<number>("zoomLevel"),
    store.get<Preferences["modelSelections"]>("modelSelections"),
    store.get<NavigationSoundMode>("navigationSoundMode"),
    store.get<NavigationInstrument>("navigationInstrument"),
    store.get<string>("externalEditor"),
    store.get<boolean>("sidebarPinned"),
    store.get<string>("uiFont"),
    store.get<unknown>("fontSizes")
  ])
  let restoredDirectory = lastProjectDirectory ?? null
  if (restoredDirectory !== null) {
    try {
      await invoke<string>("draft_directory", { cwd: restoredDirectory })
    } catch (error: unknown) {
      // Only an unavailable saved directory resets startup to the default workspace.
      // Bridge and host failures must not erase a valid project preference.
      const message = error instanceof Error ? error.message : String(error)
      if (message !== `Project directory is unavailable: ${restoredDirectory}`) throw error
      await updateSettings({ [preferenceKeys.lastProjectDirectory]: null })
      restoredDirectory = null
    }
  }
  return {
    composerPredictions: (await store.get<boolean>("composerPredictions")) ?? true,
    // Default to the expanded (pinned) sidebar: a fresh install opens with the panel docked.
    sidebarPinned: sidebarPinned ?? true,
    chatWindowShortcut: (await store.get<string>("chatWindowShortcut")) ?? "Alt+Space",
    lastProjectDirectory: restoredDirectory,
    defaultStartSurface: defaultStartSurface === "work" ? "work" : "chat",
    language: language ?? null,
    zoomLevel: zoomLevel ?? null,
    uiFont: resolveUiFont(uiFont),
    fontSizes: resolveFontSizes(fontSizes),
    modelSelections: modelSelections ?? { main: null, chat: null },
    navigationSoundMode: navigationSoundMode ?? "scale",
    navigationInstrument: navigationInstrument ?? "acoustic_grand_piano",
    externalEditor: externalEditor ?? null,
    profileNickname: (await store.get<string>("profileNickname")) ?? null,
    profileAvatar: (await store.get<string>("profileAvatar")) ?? null,
    profileOwner: (await store.get<string>("profileOwner")) ?? null
  }
}

/** Broadcast after every save so the other window follows (see `preference-sync.ts`). */
export const PREFERENCES_CHANGED = "preferences:changed"
export type PreferenceChange = { key: keyof Preferences; value: unknown; window: string }

export async function savePreference<K extends keyof Preferences>(key: K, value: Preferences[K]): Promise<void> {
  await updateSettings({ [preferenceKeys[key]]: value })
  if (key === "externalEditor") setProjectAppPreference(value as Preferences["externalEditor"])
  const change: PreferenceChange = { key, value, window: getCurrentWebviewWindow().label }
  await emit(PREFERENCES_CHANGED, change)
}
