import { modelSelectionId, parseModelIdentity } from "@/lib/model-identity"
import { isMac } from "@/lib/platform"

import catalog from "./catalog.json"

export const ANTIGRAVITY_MODEL_GROUP = {
  id: catalog.id,
  name: catalog.name
} as const

export const ANTIGRAVITY_MODELS = catalog.models
export const ANTIGRAVITY_EFFORTS = catalog.efforts
export const ANTIGRAVITY_ENABLED_KEY = "alwith:antigravity:enabled"
const DEFAULT_MODEL_KEY = "alwith:antigravity:default-model"
const LEGACY_THINKING_KEY = "alwith:antigravity:default-thinking"
const MODEL_PREFERENCES_KEY = "alwith:antigravity:model-preferences"

type ModelPreference = { enabled: boolean; effort: string | null }

function storedModelPreferences(): Record<string, unknown> {
  const raw = localStorage.getItem(MODEL_PREFERENCES_KEY)
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return {}
  }
  return {}
}

function validEffort(value: unknown): value is string {
  return typeof value === "string" && ANTIGRAVITY_EFFORTS.includes(value)
}

export function antigravityModelRows(): Array<(typeof ANTIGRAVITY_MODELS)[number] & ModelPreference> {
  let preferences: Record<string, unknown> = {}
  let inherited: string | null = null
  try {
    preferences = storedModelPreferences()
    const legacy = localStorage.getItem(LEGACY_THINKING_KEY)
    if (validEffort(legacy)) inherited = legacy
  } catch {
    preferences = {}
  }
  return ANTIGRAVITY_MODELS.map((model) => {
    const raw = preferences[model.id]
    const saved = raw !== null && typeof raw === "object" ? (raw as Partial<ModelPreference>) : null
    return {
      ...model,
      enabled: saved?.enabled !== false,
      effort: saved?.effort === null || validEffort(saved?.effort) ? saved.effort : inherited
    }
  })
}

export function setAntigravityModelPreference(modelId: string, change: Partial<ModelPreference>): void {
  const row = antigravityModelRows().find((model) => model.id === modelId)
  if (row === undefined || (change.effort != null && !validEffort(change.effort))) {
    throw new Error("Invalid Antigravity model preference")
  }
  const preference: ModelPreference = { enabled: row.enabled, effort: row.effort, ...change }
  localStorage.setItem(MODEL_PREFERENCES_KEY, JSON.stringify({ ...storedModelPreferences(), [modelId]: preference }))
}

export function antigravityModelSelection(modelId: string): string {
  return modelSelectionId(catalog.id, modelId)
}

/** The settings toggle is the only switch: off removes the whole group from the composer. */
export function antigravityEnabled(): boolean {
  if (!isMac()) return false
  try {
    return localStorage.getItem(ANTIGRAVITY_ENABLED_KEY) !== "false"
  } catch {
    return true
  }
}

export function antigravityModel(value: string | null) {
  if (value === null) return undefined
  const identity = parseModelIdentity(value)
  if (identity.kind !== "gateway" || identity.gatewayId !== catalog.id) return undefined
  return ANTIGRAVITY_MODELS.find((model) => model.id === identity.modelId)
}

/** The saved default, normalized to a model the official binary actually offers. */
export function antigravityDefaultModel(): string {
  try {
    const saved = localStorage.getItem(DEFAULT_MODEL_KEY)
    return typeof saved === "string" && ANTIGRAVITY_MODELS.some((model) => model.id === saved)
      ? saved
      : ANTIGRAVITY_MODELS[0]!.id
  } catch {
    return ANTIGRAVITY_MODELS[0]!.id
  }
}

export function setAntigravityDefaultModel(modelId: string): void {
  if (!ANTIGRAVITY_MODELS.some((model) => model.id === modelId)) throw new Error("Invalid Antigravity model")
  localStorage.setItem(DEFAULT_MODEL_KEY, modelId)
}

export function antigravityDefaultThinking(modelId: string): string {
  return antigravityModelRows().find((model) => model.id === modelId)?.effort ?? catalog.defaultEffort
}
