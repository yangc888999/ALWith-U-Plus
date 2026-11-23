import { afterEach, expect, test } from "vitest"

import { applyUiFont, resolveUiFont } from "../ui-font"

afterEach(() => {
  document.documentElement.style.removeProperty("--app-font-family")
  delete document.documentElement.dataset.uiFont
})

test("PingFang is the default and unknown saved ids fall back to it", () => {
  expect(resolveUiFont(null)).toBe("pingfang")
  expect(resolveUiFont("not-a-font")).toBe("pingfang")
  expect(resolveUiFont("songti")).toBe("songti")
})

test("applying a system family updates the live interface and exposes the choice", () => {
  expect(applyUiFont(null)).toBe("pingfang")
  expect(document.documentElement.style.getPropertyValue("--app-font-family")).toContain("PingFang SC")
  expect(document.documentElement.dataset.uiFont).toBe("pingfang")

  applyUiFont("kaiti")
  expect(document.documentElement.style.getPropertyValue("--app-font-family")).toContain("Kaiti SC")
  expect(document.documentElement.dataset.uiFont).toBe("kaiti")
})
