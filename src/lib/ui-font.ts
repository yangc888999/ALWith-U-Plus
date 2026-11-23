// Interface fonts are installed system families, never bundled webfonts. A saved id is
// validated before it reaches CSS so a stale preference cannot inject an arbitrary family.
export const DEFAULT_UI_FONT = "pingfang"

export const UI_FONT_OPTIONS = [
  {
    id: "pingfang",
    labelKey: "settings.uiFonts.pingfang",
    family: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Inter Variable", sans-serif'
  },
  {
    id: "system",
    labelKey: "settings.uiFonts.system",
    family: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
  },
  {
    id: "hiragino",
    labelKey: "settings.uiFonts.hiragino",
    family: '"Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
  },
  {
    id: "songti",
    labelKey: "settings.uiFonts.songti",
    family: '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif'
  },
  {
    id: "kaiti",
    labelKey: "settings.uiFonts.kaiti",
    family: '"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif CJK SC", serif'
  },
  {
    id: "yahei",
    labelKey: "settings.uiFonts.yahei",
    family: '"Microsoft YaHei", "PingFang SC", "Segoe UI", "Noto Sans CJK SC", sans-serif'
  },
  {
    id: "simsun",
    labelKey: "settings.uiFonts.simsun",
    family: '"SimSun", "Songti SC", "STSong", "Noto Serif CJK SC", serif'
  }
] as const

export type UiFont = (typeof UI_FONT_OPTIONS)[number]["id"]

export function isUiFont(value: string): value is UiFont {
  return UI_FONT_OPTIONS.some((option) => option.id === value)
}

export function resolveUiFont(value: string | null | undefined): UiFont {
  return value !== null && value !== undefined && isUiFont(value) ? value : DEFAULT_UI_FONT
}

function uiFontFamily(font: UiFont): string {
  return UI_FONT_OPTIONS.find((option) => option.id === font)!.family
}

/** Applied before React mounts so the first frame already uses the saved family. */
export function applyUiFont(value: string | null | undefined): UiFont {
  const font = resolveUiFont(value)
  document.documentElement.style.setProperty("--app-font-family", uiFontFamily(font))
  document.documentElement.dataset.uiFont = font
  return font
}
