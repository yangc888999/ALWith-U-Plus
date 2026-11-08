import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { settingsFixture } from "@/lib/__tests__/settings-fixture"
import { initI18n } from "@/lib/i18n"

import { TreeVisibleRow } from "../tree-visible-row"

beforeEach(async () => {
  await initI18n("en")
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test("starts on, closes the column and follows the folder button in the tree header", async () => {
  const fixture = settingsFixture()
  const view = render(<TreeVisibleRow />)
  const toggle = view.getByRole("switch", { name: "Show the file column" })
  expect(toggle).toBeChecked()
  fireEvent.click(toggle)
  // The switch answers on the click; the stored value lands right after.
  expect(toggle).not.toBeChecked()
  await waitFor(() => expect(fixture.values.get("workspace.treeVisible")).toBe(false))
  // The tree's own button writes the same key, so this switch has to follow it.
  act(() => fixture.changed({ "workspace.treeVisible": true }))
  expect(toggle).toBeChecked()
})

test("a closed column stays closed on the next launch", () => {
  settingsFixture({ "workspace.treeVisible": false })
  const view = render(<TreeVisibleRow />)
  expect(view.getByRole("switch", { name: "Show the file column" })).not.toBeChecked()
})
