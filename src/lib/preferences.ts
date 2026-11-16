// Small per-user preferences. Codex owns every conversation; this file only
// remembers what the user was looking at and which language they chose.
import { invoke } from "@tauri-apps/api/core"
import { emit } from "@tauri-apps/api/event"
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"

import type { NavigationInstrument, NavigationSoundMode } from "@/features/chat/codex/navigation-instruments"

import { setProjectAppPreference } from "./project-app-preference"
import { settingsStore, updateSettings } from "./settings-store"

export type Preferences = {
  composerPredictions?: boolean
  sidebarPinned: boolean
  chatWindowShortcut?: string
  lastProjectDirectory: string | null
  language: string | null
  zoomLevel: number | null
  /** Explicit model choices are independent for the main and floating chat slots. */
  modelSelections: { main: string | null; chat: string | null }
  /** Sounds the user-message navigation rail plays (ALwith Desktop's navigation melody). */
  navigationSoundMode: NavigationSoundMode
  navigationInstrument: NavigationInstrument
  /** Bundle id (Windows: exe path) of the app "Open in …" last used for a project. */
  externalEditor: string | null
  /** Conversation that was on screen at quit, reopened at launch. */
  lastSession?: { id: string; cwd: string } | null
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
  language: "general.language",
  zoomLevel: "appearance.zoomLevel",
  modelSelections: "chat.modelSelections",
  navigationSoundMode: "chat.navigationSoundMode",
  navigationInstrument: "chat.navigationInstrument",
  externalEditor: "general.externalEditor",
  lastSession: "chat.lastSession",
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
    language: null,
    zoomLevel: null,
    modelSelections: { main: null, chat: null },
    navigationSoundMode: "scale",
    navigationInstrument: "acoustic_grand_piano",
    externalEditor: null,
    lastSession: null,
    profileNickname: null,
    profileAvatar: null,
    profileOwner: null
  }
}

export async function loadPreferences(): Promise<Preferences> {
  await settingsStore.read()
  const [
    lastProjectDirectory,
    language,
    zoomLevel,
    modelSelections,
    navigationSoundMode,
    navigationInstrument,
    externalEditor,
    sidebarPinned
  ] = await Promise.all([
    store.get<string>("lastProjectDirectory"),
    store.get<string>("language"),
    store.get<number>("zoomLevel"),
    store.get<Preferences["modelSelections"]>("modelSelections"),
    store.get<NavigationSoundMode>("navigationSoundMode"),
    store.get<NavigationInstrument>("navigationInstrument"),
    store.get<string>("externalEditor"),
    store.get<boolean>("sidebarPinned")
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
    language: language ?? null,
    zoomLevel: zoomLevel ?? null,
    modelSelections: modelSelections ?? { main: null, chat: null },
    navigationSoundMode: navigationSoundMode ?? "scale",
    navigationInstrument: navigationInstrument ?? "acoustic_grand_piano",
    externalEditor: externalEditor ?? null,
    lastSession: (await store.get<Preferences["lastSession"]>("lastSession")) ?? null,
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
