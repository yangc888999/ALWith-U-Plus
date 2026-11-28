import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeAll, beforeEach, expect, test, vi } from "vitest"

import { commands } from "@/bindings"
import { initI18n } from "@/lib/i18n"

import { PlaywrightComponentCard } from "../playwright-component-card"

const fixtures = vi.hoisted(() => {
  const status: {
    installed: boolean
    version: string | null
    browserRevision: string | null
    browserVersion: string | null
    browserPath: string | null
    installDir: string
    hint: string
  } = {
    installed: false,
    version: null,
    browserRevision: null,
    browserVersion: null,
    browserPath: null,
    installDir: "/Users/me/.local/lib/alwith/playwright",
    hint: "尚未安装"
  }
  return { status }
})

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }))
vi.mock("@/lib/open", () => ({ openExternal: vi.fn() }))
vi.mock("@/bindings", () => ({
  commands: {
    playwrightComponentStatus: vi.fn(async () => fixtures.status),
    playwrightComponentCheckUpdate: vi.fn(async () => ({
      hasUpdate: false,
      currentVersion: "1.65.0",
      latestVersion: "1.65.0",
      message: "已是最新版本",
      url: null
    })),
    playwrightComponentInstall: vi.fn(async () => ({ ok: true, message: "installed" })),
    playwrightComponentUpdate: vi.fn(async () => ({ ok: true, message: "updated" }))
  }
}))

beforeAll(async () => {
  await initI18n("en")
})

beforeEach(() => {
  fixtures.status = {
    installed: false,
    version: null,
    browserRevision: null,
    browserVersion: null,
    browserPath: null,
    installDir: "/Users/me/.local/lib/alwith/playwright",
    hint: "尚未安装"
  }
  vi.clearAllMocks()
})

test("an uninstalled Playwright component offers install and reports the managed directory", async () => {
  render(<PlaywrightComponentCard />)
  await waitFor(() => expect(screen.getByText("Not installed")).toBeTruthy())
  expect(screen.getByRole("button", { name: "Install" })).toBeTruthy()
  await waitFor(() => expect(screen.getByTitle("/Users/me/.local/lib/alwith/playwright")).toBeTruthy())
})

test("an installed component shows the matching headless shell and can check updates", async () => {
  fixtures.status = {
    installed: true,
    version: "1.65.0",
    browserRevision: "1254",
    browserVersion: "157.0.0",
    browserPath: "/Users/me/.local/lib/alwith/playwright/browsers/chromium_headless_shell-1254/chrome-headless-shell",
    installDir: "/Users/me/.local/lib/alwith/playwright",
    hint: "Playwright Core 和 Headless Shell 已就绪。"
  }
  render(<PlaywrightComponentCard />)
  await waitFor(() => expect(screen.getByText("Ready")).toBeTruthy())
  expect(screen.getByText("Playwright 1.65.0")).toBeTruthy()
  expect(screen.getByText("Headless Shell 1254")).toBeTruthy()
  await waitFor(() =>
    expect(screen.getByTitle(
      "/Users/me/.local/lib/alwith/playwright/browsers/chromium_headless_shell-1254/chrome-headless-shell"
    )).toBeTruthy()
  )
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }))
  await waitFor(() => expect(vi.mocked(commands.playwrightComponentCheckUpdate)).toHaveBeenCalledOnce())
})
