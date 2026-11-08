// Settings accent (强调色): a restrained-but-lively brand colour that drives every highlight
// on the settings pages — the page glyph, card headers, notes. The rest of the app stays
// neutral, so this is purely a settings-window flourish (front-end only, no functional impact).
import { useEffect } from "react"
import { create } from "zustand"
import { persist } from "zustand/middleware"

export type AccentId =
  | "yup-red"
  | "lemon-green"
  | "girly-pink"
  | "linen-gray"
  | "warm-brown"
  | "sky-blue"
  | "emerald"

export interface AccentPreset {
  id: AccentId
  /** i18n key for the human label (柠檬绿 / 少女粉 / …). */
  labelKey: string
  /** Representative light-theme colour, used for the picker swatch dot. */
  swatch: string
}

// Order is the order they appear in the picker. YUP红 is the default brand colour, sampled
// from the YUP logo gradient (orange → red → pink).
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "yup-red", labelKey: "settings.accent.yupRed", swatch: "oklch(0.64 0.20 29)" },
  { id: "lemon-green", labelKey: "settings.accent.lemonGreen", swatch: "oklch(0.80 0.16 125)" },
  { id: "girly-pink", labelKey: "settings.accent.girlyPink", swatch: "oklch(0.74 0.14 350)" },
  { id: "linen-gray", labelKey: "settings.accent.linenGray", swatch: "oklch(0.72 0.025 85)" },
  { id: "warm-brown", labelKey: "settings.accent.warmBrown", swatch: "oklch(0.62 0.09 55)" },
  { id: "sky-blue", labelKey: "settings.accent.skyBlue", swatch: "oklch(0.66 0.13 240)" },
  { id: "emerald", labelKey: "settings.accent.emerald", swatch: "oklch(0.68 0.12 168)" }
]

export const DEFAULT_ACCENT: AccentId = "yup-red"

type AccentState = {
  accent: AccentId
  setAccent: (accent: AccentId) => void
}

export const useAccentStore = create<AccentState>()(
  persist(
    (set) => ({
      accent: DEFAULT_ACCENT,
      setAccent: (accent) => set({ accent })
    }),
    { name: "alwith-settings-accent" }
  )
)

// Settings and the main window are separate Tauri webviews that share one origin, so the
// persisted choice lands in the same localStorage. zustand's persist does not echo writes
// across windows, so we listen for the storage event and re-read, keeping every window on
// the same accent without a reload.
if (typeof window !== "undefined" && "addEventListener" in window) {
  window.addEventListener("storage", (event) => {
    if (event.key !== "alwith-settings-accent" || event.newValue === null) return
    try {
      const parsed = JSON.parse(event.newValue) as { state?: { accent?: AccentId } }
      if (parsed.state?.accent !== undefined) useAccentStore.setState({ accent: parsed.state.accent })
    } catch {
      // Ignore malformed payloads; the next write will correct them.
    }
  })
}

/**
 * Mirrors the selected accent onto <html data-accent> so the global token rules in index.css
 * re-theme the whole window. Call once per window (main + settings).
 */
export function useAccentDataAttribute(): void {
  const accent = useAccentStore((state) => state.accent)
  useEffect(() => {
    document.documentElement.setAttribute("data-accent", accent)
  }, [accent])
}
