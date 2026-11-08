import { fireEvent, render } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"

import { getActivePreview, setActivePreview } from "@/lib/active-preview"

import { ActivePreviewChip } from "../active-preview-chip"

const document = { path: "/tmp/report.md", title: "report.md", root: "/tmp" }

afterEach(() => setActivePreview(null))

test("clicking the X clears the reference", () => {
  setActivePreview(document)
  const view = render(<ActivePreviewChip />)
  // The chip renders one button: the clear affordance.
  fireEvent.click(view.getByRole("button"))
  expect(getActivePreview()).toBeNull()
})

test("double-clicking the chip clears the reference", () => {
  setActivePreview(document)
  const view = render(<ActivePreviewChip />)
  fireEvent.doubleClick(view.getByRole("button").parentElement as HTMLElement)
  expect(getActivePreview()).toBeNull()
})

test("renders nothing without an active document", () => {
  const view = render(<ActivePreviewChip />)
  expect(view.container.innerHTML).toBe("")
})
