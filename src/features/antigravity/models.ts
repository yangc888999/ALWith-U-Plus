/**
 * Gemini models exposed by the official Antigravity ACP binary.
 *
 * These rows are intentionally kept out of the Codex provider/Router snapshot: the binary is a
 * second ACP agent, not an OpenAI-compatible gateway. The composer catalog appends this group so
 * the model is chosen from the same dropdown as Codex models, and a pick routes the surface to the
 * Antigravity agent instead of writing a Codex config option.
 */
export const ANTIGRAVITY_MODEL_GROUP = {
  id: "google-antigravity",
  name: "Google Antigravity"
} as const

export const ANTIGRAVITY_MODELS = [
  { id: "gemini-4-argon", label: "Gemini 4 Argon" },
  { id: "gemini-4-neon", label: "Gemini 4 Neon" },
  { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }
] as const

export const ANTIGRAVITY_MODEL_PREFIX = "antigravity:"
export const ANTIGRAVITY_ENABLED_KEY = "alwith:antigravity:enabled"
export const ANTIGRAVITY_DEFAULT_MODEL_KEY = "alwith:antigravity:default-model"
export const ANTIGRAVITY_DEFAULT_THINKING_KEY = "alwith:antigravity:default-thinking"
export const ANTIGRAVITY_TIER_KEY = "alwith:antigravity:tier"

export function antigravityModelSelection(modelId: string): string {
  return `${ANTIGRAVITY_MODEL_PREFIX}${modelId}`
}

/** The settings toggle is the only switch: off removes the whole group from the composer. */
export function antigravityEnabled(): boolean {
  try {
    return localStorage.getItem(ANTIGRAVITY_ENABLED_KEY) !== "false"
  } catch {
    return true
  }
}

export function isAntigravityModelSelection(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ANTIGRAVITY_MODEL_PREFIX)
}

export function antigravityModelId(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.startsWith(ANTIGRAVITY_MODEL_PREFIX)) return null
  const id = value.slice(ANTIGRAVITY_MODEL_PREFIX.length)
  return ANTIGRAVITY_MODELS.some((model) => model.id === id) ? id : null
}

export function antigravityModelLabel(modelId: string | null): string {
  return ANTIGRAVITY_MODELS.find((model) => model.id === modelId)?.label ?? "Gemini 4 Argon"
}

/** The saved default, normalized to a model the official binary actually offers. */
export function antigravityDefaultModel(): string {
  try {
    const saved = localStorage.getItem(ANTIGRAVITY_DEFAULT_MODEL_KEY)
    return typeof saved === "string" && ANTIGRAVITY_MODELS.some((model) => model.id === saved)
      ? saved
      : ANTIGRAVITY_MODELS[0].id
  } catch {
    return ANTIGRAVITY_MODELS[0].id
  }
}

export function antigravityDefaultThinking(): string {
  try {
    const saved = localStorage.getItem(ANTIGRAVITY_DEFAULT_THINKING_KEY)
    return saved === "low" || saved === "medium" || saved === "high" ? saved : "high"
  } catch {
    return "high"
  }
}
