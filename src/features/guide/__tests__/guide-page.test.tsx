import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"

import { GuidePage } from "../guide-page"
import i18n, { initI18n } from "@/lib/i18n"

vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }))
vi.mock("@alwith/module-chat/markdown", () => ({
  CodexMarkdownRenderer: ({ text }: { text: string }) => <div>{text}</div>
}))
beforeAll(() => initI18n("en"))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test("home cards and the interface map open chapters and return to the guide home", () => {
  const view = render(<GuidePage />)
  fireEvent.click(view.getByRole("button", { name: "Open files" }))
  expect(view.getByRole("main", { name: "Work with project files" })).toBeTruthy()
  fireEvent.click(view.getByRole("button", { name: "Guide home" }))
  fireEvent.click(view.getByRole("button", { name: /^Choose a model / }))
  expect(view.getByRole("main", { name: "Choose a model" })).toBeTruthy()
  fireEvent.click(view.getByRole("button", { name: "Next Work with project files" }))
  expect(view.getByRole("main", { name: "Work with project files" })).toBeTruthy()
})

test("the bundled English guide starts at welcome and navigates to complete chapters", () => {
  const view = render(<GuidePage />)
  expect(view.getByRole("main", { name: "Welcome" }).textContent).toContain("independent desktop client")
  for (const chapter of [
    "Start here",
    "Find your way around",
    "Chat and review work",
    "Choose a model",
    "Work with project files",
    "Plugins and extensions",
    "Cloud files",
    "Settings and shortcuts",
    "Troubleshooting"
  ]) {
    const button = view.getByRole("button", { name: chapter })
    fireEvent.click(button)
    expect(button).toHaveAttribute("aria-current", "page")
    expect(view.getByRole("main", { name: chapter }).textContent?.length).toBeGreaterThan(200)
    expect(view.queryByRole("main", { name: "Welcome" })).toBeNull()
  }
})

test.each(["Win32", "MacIntel"] as const)("%s uses the appropriate guide title bar", (platform) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform)
  const view = render(<GuidePage />)
  const header = view.container.querySelector(".guide-window > div > [data-tauri-drag-region]")
  if (platform === "Win32") expect(header).toBeNull()
  else expect(header).toHaveTextContent("ALWith U⁺ Guide")
  expect(view.getByRole("navigation", { name: "Guide chapters" })).toBeVisible()
  expect(view.getByRole("main", { name: "Welcome" })).toBeVisible()
})

test("the guide switches to the bundled Chinese edition", async () => {
  await i18n.changeLanguage("zh-CN")
  try {
    const view = render(<GuidePage />)
    expect(view.getByRole("navigation", { name: "指南章节" })).toBeVisible()
    expect(view.getByRole("main", { name: "欢迎" })).toBeVisible()
    fireEvent.click(view.getByRole("button", { name: "从这里开始" }))
    expect(view.getByRole("main", { name: "从这里开始" }).textContent).toContain("登录 ALwith 账号")
  } finally {
    await i18n.changeLanguage("en")
  }
})
