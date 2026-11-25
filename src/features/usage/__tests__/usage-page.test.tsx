import { fireEvent, render, screen } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

vi.mock("@/features/settings/sections/usage-section", () => ({
  UsageSection: ({ priceConfigOpen }: { priceConfigOpen?: boolean }) => (
    <div data-price-config-open={String(priceConfigOpen === true)}>
      <section data-card="overview" />
      <section data-card="analysis" />
    </div>
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

test("the price configuration entry sits in the page header and controls the dialog state", () => {
  const view = render(<UsagePage />)
  const trigger = screen.getByRole("button", { name: /model price configuration/i })
  const header = trigger.closest("header")
  expect(header).not.toBeNull()
  expect(header).toContainElement(trigger)
  expect(view.container.querySelector("[data-price-config-open]")).toHaveAttribute("data-price-config-open", "false")
  fireEvent.click(trigger)
  expect(view.container.querySelector("[data-price-config-open]")).toHaveAttribute("data-price-config-open", "true")
  view.unmount()
})
