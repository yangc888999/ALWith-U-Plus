import { render } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

vi.mock("@/features/settings/sections/skills-section", () => ({
  SkillsSection: () => (
    <>
      <section data-card="mine" />
      <section data-card="system" />
    </>
  )
}))

import { SkillsPage } from "../skills-page"

await initI18n("en")

test("skills uses the same full-width shell and card rhythm as plugins and extensions", () => {
  const view = render(<SkillsPage />)
  const content = view.container.querySelector("[data-skills-page] > div")
  expect(content?.className).toContain("w-full")
  expect(content?.className).toContain("px-8")
  expect(content?.className).not.toContain("max-w-[88rem]")
  const body = view.container.querySelector(".settings-page-body")
  expect(body).not.toBeNull()
  expect(body?.querySelectorAll("[data-card]")).toHaveLength(2)
  view.unmount()
})
