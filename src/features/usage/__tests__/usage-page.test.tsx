import { render } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

vi.mock("@/features/settings/sections/usage-section", () => ({
  UsageSection: () => (
    <>
      <section data-card="overview" />
      <section data-card="analysis" />
    </>
  )
}))

import { UsagePage } from "../usage-page"

await initI18n("en")

test("usage cards keep the shared settings rhythm instead of touching each other", () => {
  const view = render(<UsagePage />)
  const content = view.container.querySelector("[data-usage-page] > div")
  expect(content?.className).toContain("w-full")
  expect(content?.className).toContain("px-8")
  expect(content?.className).not.toContain("max-w-[88rem]")
  const body = view.container.querySelector(".settings-page-body")
  expect(body).not.toBeNull()
  expect(body?.querySelectorAll("[data-card]")).toHaveLength(2)
  view.unmount()
})
