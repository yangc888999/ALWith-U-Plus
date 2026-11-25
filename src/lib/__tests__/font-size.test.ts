import { afterEach, expect, test } from "vitest"

import { applyFontSizes, FONT_SIZE_DEFAULTS, resolveFontSizes } from "../font-size"

afterEach(() => {
  for (const name of [
    "--chat-font-size",
    "--composer-font-size",
    "--sidebar-font-size",
    "--settings-font-size"
  ]) {
    document.documentElement.style.removeProperty(name)
  }
})

test("recommended defaults are 14 / 14 / 13 / 14 and invalid values fall back per location", () => {
  expect(FONT_SIZE_DEFAULTS).toEqual({ chat: 14, composer: 14, sidebar: 13, settings: 14 })
  expect(resolveFontSizes(undefined)).toEqual(FONT_SIZE_DEFAULTS)
  expect(resolveFontSizes({ chat: 16, composer: 999, sidebar: "15", settings: 15 })).toEqual({
    chat: 16,
    composer: 14,
    sidebar: 13,
    settings: 15
  })
})

test("applying sizes writes the three CSS variables the chat, composer and sidebar read", () => {
  const applied = applyFontSizes({ chat: 16, composer: 15, sidebar: 14, settings: 15 })
  expect(applied).toEqual({ chat: 16, composer: 15, sidebar: 14, settings: 15 })
  expect(document.documentElement.style.getPropertyValue("--chat-font-size")).toBe("16px")
  expect(document.documentElement.style.getPropertyValue("--composer-font-size")).toBe("15px")
  expect(document.documentElement.style.getPropertyValue("--sidebar-font-size")).toBe("14px")
  expect(document.documentElement.style.getPropertyValue("--settings-font-size")).toBe("15px")
})
