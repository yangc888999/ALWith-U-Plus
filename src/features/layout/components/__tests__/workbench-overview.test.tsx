import { render, within } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

import { WorkbenchOverview } from "../workbench-overview"

await initI18n("en")

test("records share the left column with capabilities", () => {
  const view = render(<WorkbenchOverview onOpen={vi.fn()} />)
  const sections = [...view.container.querySelectorAll("section")]
  expect(sections.map((section) => section.querySelector("h2")?.textContent)).toEqual([
    "Capabilities",
    "Records",
    "Workflows"
  ])
  const columns = view.container.querySelectorAll<HTMLElement>(".grid > div")
  expect(within(columns[0]!).getByRole("heading", { name: "Records" })).toBeInTheDocument()
  expect(within(columns[1]!).queryByRole("heading", { name: "Records" })).toBeNull()
})
