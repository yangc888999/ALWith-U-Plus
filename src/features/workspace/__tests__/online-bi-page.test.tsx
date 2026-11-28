import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"

import { commands } from "@/bindings"
import { initI18n } from "@/lib/i18n"

import { OnlineBiPage } from "../online-bi-page"

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: "dark", resolvedTheme: "dark", setTheme: vi.fn() })
}))
vi.mock("../online-bi-embed", () => ({
  OnlineBiNativeView: ({
    src,
    reload,
    hidden,
    theme
  }: {
    src: string
    reload?: number
    hidden?: boolean
    theme?: string
  }) => (
    <div
      data-testid="native-bi"
      data-src={src}
      data-reload={reload}
      data-hidden={hidden === true ? "true" : "false"}
      data-theme={theme}
    />
  )
}))
vi.mock("../online-bi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../online-bi")>()
  return {
    ...actual,
    getOnlineBiEmbedSrcFor: async (url: string) => actual.onlineBiEmbedUrl(url)
  }
})

await initI18n("en")

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

test("pins the current report address, then edits its label", async () => {
  vi.spyOn(commands, "onlineBiEmbedCurrentUrl").mockResolvedValue(
    "https://bi.finture.id/reports/sales?s=secret&embed=true&page=2"
  )
  const collapseSidebar = vi.spyOn(commands, "onlineBiEmbedCollapseSidebar").mockResolvedValue(null)
  const view = render(<OnlineBiPage />)

  expect(screen.getByRole("tab", { name: "Personal dashboard" })).toBeInTheDocument()
  expect(screen.getByRole("textbox", { name: "Report address" })).toHaveValue(
    "https://bi.finture.id/personal_dashboard"
  )

  fireEvent.click(screen.getByRole("button", { name: "Pin current report" }))
  const add = await screen.findByRole("dialog")
  await waitFor(() => expect(screen.getByTestId("native-bi")).toHaveAttribute("data-hidden", "true"))
  expect(screen.getByTestId("native-bi")).toHaveAttribute("data-theme", "dark")
  fireEvent.change(within(add).getByLabelText("Tab name"), { target: { value: "销售日报" } })
  fireEvent.click(within(add).getByRole("button", { name: "Capture current address" }))
  await waitFor(() =>
    expect(within(add).getByRole("textbox", { name: "Report address" })).toHaveValue(
      "https://bi.finture.id/reports/sales?page=2"
    )
  )
  fireEvent.click(within(add).getByRole("button", { name: "Confirm" }))
  await waitFor(() => expect(collapseSidebar).toHaveBeenCalledOnce())

  const tab = await screen.findByRole("tab", { name: "销售日报" })
  await waitFor(() => expect(tab).toHaveAttribute("aria-selected", "true"))
  await waitFor(() => expect(screen.getByTestId("native-bi").getAttribute("data-src")).toContain("/reports/sales"))

  fireEvent.click(screen.getByRole("button", { name: "Edit tab 销售日报" }))
  const edit = await screen.findByRole("dialog")
  fireEvent.change(within(edit).getByLabelText("Tab name"), { target: { value: "销售日报（新版）" } })
  fireEvent.click(within(edit).getByRole("button", { name: "Confirm" }))
  expect(await screen.findByRole("tab", { name: "销售日报（新版）" })).toBeInTheDocument()
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(screen.getByTestId("native-bi")).toHaveAttribute("data-hidden", "false")
  expect(view.getByRole("textbox", { name: "Report address" })).toHaveValue(
    "https://bi.finture.id/reports/sales?page=2"
  )
})

test("the address bar accepts a path and stays in the same page", async () => {
  render(<OnlineBiPage />)
  const address = screen.getByRole("textbox", { name: "Report address" })
  fireEvent.change(address, { target: { value: "/reports/weekly?week=46" } })
  fireEvent.click(screen.getByRole("button", { name: "Open" }))
  await waitFor(() =>
    expect(screen.getByTestId("native-bi").getAttribute("data-src")).toContain(
      "/reports/weekly?week=46&embed=true"
    )
  )
  expect(address).toHaveValue("https://bi.finture.id/reports/weekly?week=46")
})

test("a new tab label follows the board tab parameter", async () => {
  render(<OnlineBiPage />)
  const address = screen.getByRole("textbox", { name: "Report address" })
  fireEvent.change(address, {
    target: { value: "/self-board?board=885591f2&tab=01%20%E5%8C%97%E6%9E%81%E6%98%9F%E6%8C%87%E6%A0%87%E6%80%BB%E8%A7%88" }
  })
  fireEvent.click(screen.getByRole("button", { name: "Open" }))
  await waitFor(() => expect((address as HTMLInputElement).value).toContain("tab="))

  fireEvent.click(screen.getByRole("button", { name: "Pin current report" }))
  const dialog = await screen.findByRole("dialog")
  expect(within(dialog).getByLabelText("Tab name")).toHaveValue("北极星指标总览")
})
