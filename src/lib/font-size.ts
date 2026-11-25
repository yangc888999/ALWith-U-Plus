/** Per-location interface text sizes. These are pixel values, not rem: chrome stays stable. */
export const FONT_SIZE_DEFAULTS = {
  chat: 14,
  composer: 14,
  sidebar: 13,
  settings: 14
} as const

export type FontSizes = {
  chat: number
  composer: number
  sidebar: number
  settings: number
}

export const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 17, 18, 20] as const

const MIN_SIZE = 11
const MAX_SIZE = 24

function normalizeFontSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  return rounded >= MIN_SIZE && rounded <= MAX_SIZE ? rounded : fallback
}

export function resolveFontSizes(value: unknown): FontSizes {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  return {
    chat: normalizeFontSize(source.chat, FONT_SIZE_DEFAULTS.chat),
    composer: normalizeFontSize(source.composer, FONT_SIZE_DEFAULTS.composer),
    sidebar: normalizeFontSize(source.sidebar, FONT_SIZE_DEFAULTS.sidebar),
    settings: normalizeFontSize(source.settings, FONT_SIZE_DEFAULTS.settings)
  }
}

/** Applies the saved sizes to the document before React paints. */
export function applyFontSizes(value: unknown): FontSizes {
  const sizes = resolveFontSizes(value)
  const root = document.documentElement
  root.style.setProperty("--chat-font-size", `${sizes.chat}px`)
  root.style.setProperty("--composer-font-size", `${sizes.composer}px`)
  root.style.setProperty("--sidebar-font-size", `${sizes.sidebar}px`)
  root.style.setProperty("--settings-font-size", `${sizes.settings}px`)
  return sizes
}
