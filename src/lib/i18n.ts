import { chatLocales } from "@alwith/module-chat/locales"
import i18n, { type Resource } from "i18next"
import { initReactI18next } from "react-i18next"

import ar from "@/locales/ar.json"
import de from "@/locales/de.json"
import en from "@/locales/en.json"
import es from "@/locales/es.json"
import fr from "@/locales/fr.json"
import hi from "@/locales/hi.json"
import id from "@/locales/id.json"
import it from "@/locales/it.json"
import ja from "@/locales/ja.json"
import ko from "@/locales/ko.json"
import ptBR from "@/locales/pt-BR.json"
import ru from "@/locales/ru.json"
import zhCN from "@/locales/zh-CN.json"

/** Supported application languages, shared with ALwith Desktop. */
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "简体中文" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "es", label: "Español" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "ru", label: "Русский" },
  { code: "ar", label: "العربية" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "hi", label: "हिन्दी" },
  { code: "id", label: "Bahasa Indonesia" }
] as const

export type LanguageCode = (typeof LANGUAGES)[number]["code"]

export function isLanguageCode(value: string): value is LanguageCode {
  return LANGUAGES.some((language) => language.code === value)
}

/** Desktop's mapping of a system locale to the closest supported language. */
function mapSystemLocale(value: string): LanguageCode | null {
  const lower = value.toLowerCase()
  if (lower.startsWith("en")) return "en"
  if (lower.startsWith("zh")) return "zh-CN"
  if (lower.startsWith("fr")) return "fr"
  if (lower.startsWith("de")) return "de"
  if (lower.startsWith("it")) return "it"
  if (lower.startsWith("es")) return "es"
  if (lower.startsWith("ja")) return "ja"
  if (lower.startsWith("ko")) return "ko"
  if (lower.startsWith("ru")) return "ru"
  if (lower.startsWith("ar")) return "ar"
  if (lower.startsWith("pt")) return "pt-BR"
  if (lower.startsWith("hi")) return "hi"
  if (lower.startsWith("id")) return "id"
  return null
}

/**
 * Resolve either a saved preference (`zh-CN`) or an OS/webview BCP-47 tag (`zh-Hans-CN`,
 * `en-US`) to a language we actually ship. The two shapes used to be conflated: an OS tag is not
 * a supported code, so it fell through to the `navigator.language` fallback.
 */
export function resolveLanguage(value: string | null | undefined): LanguageCode | null {
  if (value === null || value === undefined || value === "") return null
  return isLanguageCode(value) ? value : mapSystemLocale(value)
}

/**
 * Last resort when nothing was stored. WKWebView reports the *bundle's* language, not the user's
 * system language: with only `CFBundleDevelopmentRegion = English` macOS hands the webview
 * `en-US` even on a Chinese Mac. `main.tsx` therefore passes the OS locale explicitly; this path
 * only covers non-Tauri environments (tests, browser preview) and a failed OS lookup.
 */
function systemLanguage(): LanguageCode {
  return resolveLanguage(navigator.language) ?? resolveLanguage(navigator.languages?.[0]) ?? "en"
}

const translations = { en, "zh-CN": zhCN, fr, de, it, es, ja, ko, ru, ar, "pt-BR": ptBR, hi, id } satisfies Record<
  LanguageCode,
  object
>

export function initI18n(language: string | null): Promise<unknown> {
  const resources: Resource = Object.fromEntries(
    LANGUAGES.map(({ code }) => [
      code,
      {
        translation: translations[code],
        alwithChat: chatLocales[code]
      }
    ])
  )

  // Window actions shared with module-chat navigation.
  const navigation = {
    en: { navigation: { mainWindow: "Main window", chatWindow: "Chat window" } },
    "zh-CN": { navigation: { mainWindow: "主窗", chatWindow: "聊天浮窗" } }
  } as const
  for (const code of ["en", "zh-CN"] as const) resources[code] = { ...resources[code], common: navigation[code] }

  return i18n.use(initReactI18next).init({
    resources,
    supportedLngs: LANGUAGES.map(({ code }) => code),
    lng: resolveLanguage(language) ?? systemLanguage(),
    fallbackLng: "en",
    interpolation: { escapeValue: false }
  })
}

export default i18n
