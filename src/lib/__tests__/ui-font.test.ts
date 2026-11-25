import { afterEach, expect, test } from "vitest"

import { applyUiFont, resolveUiFont } from "../ui-font"

afterEach(() => {
  document.documentElement.style.removeProperty("--app-font-family")
  delete document.documentElement.dataset.uiFont
})

test("System UI is the default and unknown saved ids fall back to it", () => {
  expect(resolveUiFont(null)).toBe("system")
  expect(resolveUiFont("not-a-font")).toBe("system")
  expect(resolveUiFont("songti")).toBe("songti")
})

test("applying a system family updates the live interface and exposes the choice", () => {
  expect(applyUiFont(null)).toBe("system")
  expect(document.documentElement.style.getPropertyValue("--app-font-family")).toMatch(/^system-ui/)
  expect(document.documentElement.dataset.uiFont).toBe("system")

  applyUiFont("kaiti")
  expect(document.documentElement.style.getPropertyValue("--app-font-family")).toContain("Kaiti SC")
  expect(document.documentElement.dataset.uiFont).toBe("kaiti")
})
