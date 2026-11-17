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
  | "snow-white"
  | "elegant-black"

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
  { id: "emerald", labelKey: "settings.accent.emerald", swatch: "oklch(0.68 0.12 168)" },
  // 与「纯色」材质配套的两档中性色：浅色选雪域白、深色选极致黑，整窗只有黑白灰，
  // 不再有彩色强调点与纯色底打架。
  { id: "snow-white", labelKey: "settings.accent.snowWhite", swatch: "oklch(0.97 0.004 250)" },
  { id: "elegant-black", labelKey: "settings.accent.elegantBlack", swatch: "oklch(0.24 0.006 265)" }
]

export const DEFAULT_ACCENT: AccentId = "yup-red"

type AccentState = {
  accent: AccentId
  /** 当前配色是「跟着纯色 + 明暗自动挑的」，还是用户自己点的。 */
  autoPair: boolean
  setAccent: (accent: AccentId, options?: { auto?: boolean }) => void
}

export const useAccentStore = create<AccentState>()(
  persist(
    (set) => ({
      accent: DEFAULT_ACCENT,
      autoPair: false,
      setAccent: (accent, options) => set({ accent, autoPair: options?.auto === true })
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

/**
 * 纯色档的两个中性配色要跟着「实际明暗」走，而不是只在你点「纯色」的那一下决定。
 *
 * 主题选「系统」时，明暗由 macOS 决定，切换发生时 `<html class="dark">` 会变，但配色不会自己
 * 跟着变——之前就是在点击时读一次 class，于是系统从浅色切到深色后还停在雪域白。
 *
 * 这里监听 class 变化，只在「纯色档 + 当前配色是自动挑的」时才改；用户手动点过其它配色
 * （`autoPair=false`）就不再干预。
 */
export function syncNeutralAccentWithTheme(): void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return
  const apply = (): void => {
    const root = document.documentElement
    const state = useAccentStore.getState()
    if (root.dataset.appearance !== "solid") return
    // 不再要求 `autoPair`：纯色档下这两个中性色**就是**「跟着明暗走的默认值」。
    // 旧实现只在点击「纯色」的那一下读一次 class（且记了一个 auto 标记），升级过设置、
    // 或系统在之后切了明暗，就会停在雪域白——这正是用户截图里的现象。
    // 彩色配色不受影响：它们不是中性对，进来就返回。
    if (state.accent !== "snow-white" && state.accent !== "elegant-black") return
    const want: AccentId = root.classList.contains("dark") ? "elegant-black" : "snow-white"
    if (state.accent !== want) state.setAccent(want, { auto: true })
  }
  new MutationObserver(apply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-appearance"]
  })
  apply()
}
