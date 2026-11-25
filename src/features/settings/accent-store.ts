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

// Order is the order they appear in the picker. Elegant black / pearl white are the two neutral
// presets; the five colour presets follow. YUP red remains the default brand colour.
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "elegant-black", labelKey: "settings.accent.elegantBlack", swatch: "oklch(0.24 0.006 265)" },
  { id: "snow-white", labelKey: "settings.accent.snowWhite", swatch: "oklch(0.97 0.004 250)" },
  { id: "yup-red", labelKey: "settings.accent.yupRed", swatch: "oklch(0.64 0.20 29)" },
  { id: "girly-pink", labelKey: "settings.accent.girlyPink", swatch: "oklch(0.74 0.14 350)" },
  { id: "lemon-green", labelKey: "settings.accent.lemonGreen", swatch: "oklch(0.80 0.16 125)" },
  { id: "sky-blue", labelKey: "settings.accent.skyBlue", swatch: "oklch(0.66 0.13 240)" },
  { id: "emerald", labelKey: "settings.accent.emerald", swatch: "oklch(0.68 0.12 168)" }
]

const DEFAULT_ACCENT: AccentId = "yup-red"

/** A stored accent from an older build may have been removed from the picker. */
export function normalizeAccentId(value: string | null | undefined): AccentId {
  return value !== null && value !== undefined && ACCENT_PRESETS.some((preset) => preset.id === value)
    ? (value as AccentId)
    : DEFAULT_ACCENT
}

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
//
// ⚠️ 只有「真的不一样」才采纳。persist 在每次 setState 后都会再写一次 localStorage，而那次写入
// 又会在**另一个窗口**触发 storage 事件——如果两个窗口各持一个不同的值，就会互相采纳、互相回写，
// 无限来回：现场表现是强调色在「柠檬绿 ⇄ 少女粉」之间一直切，整个窗口的色调跟着一起闪。
// 采纳前先比对当前值，值和本地一致就到此为止，回写链自己断开。
export function adoptRemoteAccent(raw: string | null): void {
  if (raw === null) return
  try {
    const parsed = JSON.parse(raw) as { state?: { accent?: AccentId } }
    const next = normalizeAccentId(parsed.state?.accent)
    if (useAccentStore.getState().accent === next) return
    useAccentStore.setState({ accent: next })
  } catch {
    // Ignore malformed payloads; the next write will correct them.
  }
}

if (typeof window !== "undefined" && "addEventListener" in window) {
  window.addEventListener("storage", (event) => {
    if (event.key !== "alwith-settings-accent") return
    adoptRemoteAccent(event.newValue)
  })
}

/**
 * Mirrors the selected accent onto <html data-accent> so the global token rules in index.css
 * re-theme the whole window. Call once per window (main + settings).
 */
export function useAccentDataAttribute(): void {
  const stored = useAccentStore((state) => state.accent)
  const accent = normalizeAccentId(stored)
  useEffect(() => {
    if (accent !== stored) useAccentStore.setState({ accent })
    document.documentElement.setAttribute("data-accent", accent)
  }, [accent, stored])
}

/**
 * 纯色档的两个中性配色跟着「实际明暗」走。
 *
 * 两个必须遵守的约束（2026-11-17 现场踩过）：**唯一写入者**与**合并瞬态**。
 *
 * 1. 唯一写入者：主窗口（`app.tsx`）传入 `writer: true`，设置窗口只读。
 *    两个窗口各按自己的 `html.dark` 决定「该用珍珠白还是雅致黑」时，一旦明暗不一致就会
 *    互相覆盖——A 写珍珠白、B 读到来又写回雅致黑、A 再写……配色就这样一直跳。
 *    设置窗口通过 accent-store 的 storage 事件同步主窗口的结论即可。
 *
 * 2. 合并瞬态：`ThemeProvider` 应用主题时是 `classList.remove("light","dark")` 再 `add()`，
 *    这一瞬间没有任何 dark class。逐次读会先判成「浅色 → 珍珠白」，再判回深色，视觉上闪一下。
 *    所以回调统一推迟到下一帧，只认最终态。
 */
export function syncNeutralAccentWithTheme(options?: { writer?: boolean }): void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return
  if (options?.writer !== true) return
  let queued = false
  const apply = (): void => {
    const root = document.documentElement
    const state = useAccentStore.getState()
    if (root.dataset.appearance !== "solid") return
    // 纯色档下这两个中性色**就是**跟着明暗走的默认值；彩色强调色不是中性对，不干预。
    if (state.accent !== "snow-white" && state.accent !== "elegant-black") return
    const want: AccentId = root.classList.contains("dark") ? "elegant-black" : "snow-white"
    if (state.accent !== want) state.setAccent(want, { auto: true })
  }
  const schedule = (): void => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      apply()
    })
  }
  new MutationObserver(schedule).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-appearance"]
  })
  apply()
}
