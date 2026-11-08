import { chatLocales } from "@alwith/module-chat/locales"
import { expect, test } from "vitest"

import i18n, { initI18n, LANGUAGES, resolveLanguage } from "@/lib/i18n"
import en from "@/locales/en.json"
import zhCN from "@/locales/zh-CN.json"

// 目录里允许字符串数组（例如关于页的“主要调整内容”列表），其余仍是嵌套的消息表。
type TranslationTree = { readonly [key: string]: string | readonly string[] | TranslationTree }

function isMessageList(value: unknown): value is readonly string[] {
  return Array.isArray(value)
}

function leafMessages(tree: TranslationTree, prefix = ""): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`
    if (isMessageList(value)) return value.map((item, index): [string, string] => [`${path}.${index}`, item])
    return typeof value === "string" ? [[path, value] as [string, string]] : leafMessages(value, path)
  })
}

function resourceContract(tree: TranslationTree): Array<[string, string[]]> {
  return leafMessages(tree)
    .map(([key, value]): [string, string[]] => [
      key,
      [...value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1] ?? "").toSorted()
    ])
    .toSorted(([left], [right]) => left.localeCompare(right))
}

test("an OS BCP-47 locale resolves to a language we actually ship", () => {
  expect(resolveLanguage("zh-Hans-CN")).toBe("zh-CN")
  expect(resolveLanguage("en-US")).toBe("en")
  expect(resolveLanguage("ja-JP")).toBe("ja")
  expect(resolveLanguage("zh-CN")).toBe("zh-CN")
  expect(resolveLanguage(null)).toBeNull()
  expect(resolveLanguage("xx-YY")).toBeNull()
})

test("a first launch with only an OS locale still boots in Chinese", async () => {
  await initI18n("zh-Hans-CN")
  expect(i18n.language).toBe("zh-CN")
  expect(i18n.t("sidebar.chats")).toBe("聊天")
})

test("every English UI message has an explicit Simplified Chinese translation", async () => {
  await initI18n("zh-CN")

  expect(resourceContract(zhCN)).toEqual(resourceContract(en))
  // Singular messages can spell out one or interpolate count depending on the language.
  const chatContract = (tree: TranslationTree) =>
    resourceContract(tree).map(([key, placeholders]) => [
      key,
      key.endsWith("_one") ? placeholders.filter((name) => name !== "count") : placeholders
    ])
  expect(chatContract(chatLocales["zh-CN"])).toEqual(chatContract(chatLocales.en))
  expect(i18n.t("chat.project.chatCount", { count: 1 })).toBe("1 个会话")
  expect(i18n.t("chat.project.chatCount", { count: 7 })).toBe("7 个会话")
})

test("the Simplified Chinese activity sidebar uses translated labels", async () => {
  await initI18n("zh-CN")

  expect(i18n.t("sidebar.activity")).toBe("活动")
  expect(i18n.t("sidebar.background")).toBe("后台")
})

test("supported locales use the ALWith L product name", async () => {
  for (const { code: language } of LANGUAGES) {
    await initI18n(language)

    expect(i18n.t("app.name")).toBe("ALWith L")
    expect(i18n.t("platformAuth.signOut")).toContain("ALWith L")
  }
})

test.each(LANGUAGES)("$code loads application and chat catalogs", async ({ code }) => {
  await initI18n(code)

  expect(i18n.language).toBe(code)
  expect(i18n.resolvedLanguage).toBe(code)
  expect(i18n.getResourceBundle(code, "alwithChat")).toEqual(chatLocales[code])
  const catalog = i18n.getResourceBundle(code, "translation") as TranslationTree
  const source = new Map(resourceContract(en))
  for (const [key, placeholders] of resourceContract(catalog)) {
    expect(source.has(key), `${code}: unknown key ${key}`).toBe(true)
    expect(placeholders, `${code}: placeholders for ${key}`).toEqual(source.get(key))
  }
  for (const key of ["settings.title", "sidebar.newChat", "welcome.title", "composer.hint", "chatWindow.open"]) {
    expect(i18n.getResource(code, "translation", key), `${code}: ${key}`).toBeTruthy()
    if (code !== "en") expect(i18n.t(key)).not.toBe(i18n.t(key, { lng: "en" }))
  }
})

test("missing messages fall back to English without changing the selected locale", async () => {
  await initI18n("fr")
  i18n.addResource("en", "fallbackTest", "message", "Fallback message")
  expect(i18n.t("message", { ns: "fallbackTest" })).toBe("Fallback message")
  expect(i18n.resolvedLanguage).toBe("fr")
})

test("Arabic loads existing app and shared chat translations with English for missing messages", async () => {
  await initI18n("ar")
  expect(i18n.language).toBe("ar")
  expect(i18n.dir()).toBe("rtl")
  expect(i18n.t("settings.title")).toBe("الإعدادات")
  expect(i18n.t("actions.copy", { ns: "alwithChat" })).toBe(chatLocales.ar.actions.copy)
  expect(i18n.t("app.name")).toBe("ALWith L")
})
