import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"

import { commands } from "@/bindings"
import { initI18n } from "@/lib/i18n"

const fixtures = vi.hoisted(() => ({
  status: {
    available: true,
    cliPath: "/Users/flyme/.local/lib/alwith/lark-cli/lark-cli",
    version: "1.0.99",
    hint: ""
  },
  auth: {
    loggedIn: true,
    brand: "feishu",
    appId: "cli_x",
    defaultIdentity: "auto",
    identities: [
      {
        kind: "user",
        available: true,
        status: "ready",
        userName: "Chen Yang (Leo)",
        openId: "ou_123",
        tokenStatus: "valid",
        scopes: ["im:message"]
      },
      {
        kind: "bot",
        available: true,
        status: "ready",
        userName: null,
        openId: null,
        tokenStatus: null,
        scopes: []
      }
    ]
  },
  profile: {
    name: "Chen Yang (Leo)",
    openId: "ou_123",
    avatarUrl: "https://s1-imfile.feishucdn.com/avatar.png"
  },
  update: {
    hasUpdate: true,
    currentVersion: "1.0.93",
    latestVersion: "1.0.99",
    message: "",
    url: "https://example/release",
    changelog: "https://example/CHANGELOG.md"
  },
  login: {
    verificationUrl: "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc",
    deviceCode: "dc_1",
    userCode: "ABCD-1234",
    expiresIn: 600
  }
}))

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }))
vi.mock("@/lib/open", () => ({ openExternal: vi.fn() }))
vi.mock("@/bindings", () => ({
  commands: {
    larkCliStatus: vi.fn(async () => fixtures.status),
    larkCliAuthStatus: vi.fn(async () => fixtures.auth),
    larkCliUserProfile: vi.fn(async () => fixtures.profile),
    larkCliCheckUpdate: vi.fn(async () => fixtures.update),
    larkCliInstall: vi.fn(),
    larkCliUpdate: vi.fn(),
    larkCliAuthLogin: vi.fn(),
    // `auth login --device-code` blocks until the user scans or the code expires; keep it pending
    // so a dialog under test stays open instead of instantly closing.
    larkCliAuthComplete: vi.fn(() => new Promise<{ ok: boolean; message: string }>(() => {})),
    larkCliAuthLogout: vi.fn()
  }
}))

import { LarkCliCard } from "../lark-cli-card"

/** `auth logout` only clears the user token; the app-level bot credential stays ready. */
const signedOutAuth = {
  loggedIn: true,
  brand: "feishu",
  appId: "cli_x",
  defaultIdentity: "auto",
  identities: [
    {
      kind: "user",
      available: false,
      status: "missing",
      userName: null,
      openId: null,
      tokenStatus: null,
      scopes: []
    },
    {
      kind: "bot",
      available: true,
      status: "ready",
      userName: null,
      openId: null,
      tokenStatus: null,
      scopes: []
    }
  ]
}

/** A fresh install: `auth status --json` returns `ok:false / not_configured` with exit code 0,
 * which Rust parses into appId=null and an empty identity list. */
const unconfiguredAuth = {
  loggedIn: false,
  brand: null,
  appId: null,
  defaultIdentity: null,
  identities: []
}

beforeAll(() => initI18n("en"))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test("the real Lark avatar, name and open id come from the profile command", async () => {
  const { container } = render(<LarkCliCard />)
  const avatar = await waitFor(() => {
    const image = container.querySelector("img")
    expect(image).not.toBeNull()
    return image as HTMLImageElement
  })
  expect(avatar.getAttribute("src")).toBe(fixtures.profile.avatarUrl)
  expect(await screen.findByText("Chen Yang (Leo)")).toBeVisible()
  expect(await screen.findByText("ou_123")).toBeVisible()
})

test("the install path and update details stay inside the Version row", async () => {
  render(<LarkCliCard />)
  await screen.findByText("Lark CLI 1.0.99")
  const versionRow = screen.getByRole("group", { name: "Version" })

  // The path used to sit in the row description, where align-items:center squeezed it against
  // the row border. It is now part of the control column but still inside the same Version row.
  expect(versionRow).toContainElement(screen.getByText(fixtures.status.cliPath))

  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }))
  const notice = await screen.findByText(/Update available/)
  expect(versionRow).toContainElement(notice)
  expect(versionRow).toContainElement(screen.getByRole("button", { name: "View changelog" }))
  expect(versionRow).toContainElement(screen.getByRole("button", { name: "Update now" }))
})

test("a broken avatar falls back to the name initial instead of a broken image", async () => {
  const { container } = render(<LarkCliCard />)
  const avatar = await waitFor(() => {
    const image = container.querySelector("img")
    expect(image).not.toBeNull()
    return image as HTMLImageElement
  })
  fireEvent.error(avatar)
  expect(container.querySelector("img")).toBeNull()
  expect(screen.getByText("C")).toBeVisible()
})

test("the component and the account are two distinct modules", async () => {
  render(<LarkCliCard />)
  expect(await screen.findByRole("heading", { name: "Lark CLI" })).toBeVisible()
  expect(screen.getByRole("heading", { name: "Feishu account" })).toBeVisible()
})

test("neither card stacks a hand-written divider on top of the row border", async () => {
  const { container } = render(<LarkCliCard />)
  await screen.findByText("Chen Yang (Leo)")
  const cards = container.querySelectorAll(".settings-card")
  expect(cards).toHaveLength(2)
  // `.settings-row` already owns a border-bottom. Adding `border-t` next to it produced the
  // doubled rule the user circled. Both cards must rely on the row border alone.
  for (const card of cards) {
    expect(card.querySelectorAll(".border-t")).toHaveLength(0)
  }
  // Component card: Version + App identity (bot). Account card: sign-in status only.
  expect(cards[0].querySelectorAll(".settings-row")).toHaveLength(2)
  expect(cards[1].querySelectorAll(".settings-row")).toHaveLength(1)
})

test("after signing out, permissions and every bot status disappear", async () => {
  vi.mocked(commands.larkCliAuthStatus).mockResolvedValueOnce(signedOutAuth)
  render(<LarkCliCard />)

  expect(await screen.findByText(/You're not signed in with your Feishu account/)).toBeVisible()
  // The whole permission block and its checkbox/authorization chain must be gone.
  expect(screen.queryByText("Your account's permissions")).toBeNull()
  expect(screen.queryByRole("button", { name: /Permission details/ })).toBeNull()
  expect(screen.queryByRole("button", { name: /Request selected/ })).toBeNull()
  // Neither the old merged wording nor any "bot is ready" status may survive the logout.
  expect(screen.queryByRole("button", { name: /Sign in \/ Authorize/ })).toBeNull()
  expect(screen.queryByText(/Bot identity ready/)).toBeNull()
  expect(screen.queryByText("Ready")).toBeNull()
  expect(screen.queryByText("Chen Yang (Leo)")).toBeNull()
  // The way back stays visible: title, hint, and a pure sign-in button.
  expect(screen.getByRole("heading", { name: "Feishu account" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Sign in to Feishu" })).toBeEnabled()
})

test("a first install without app credentials shows an explicit setup path", async () => {
  vi.mocked(commands.larkCliAuthStatus).mockResolvedValueOnce(unconfiguredAuth)
  render(<LarkCliCard />)

  expect(await screen.findByText("One more step: set up app credentials")).toBeVisible()
  expect(screen.getByText("lark-cli config init --new")).toBeVisible()
  expect(screen.getByRole("button", { name: "Recheck" })).toBeEnabled()
  // Signing in before an app is bound only fails, so it is not offered yet.
  expect(screen.getByRole("button", { name: "Sign in to Feishu" })).toBeDisabled()
  expect(screen.queryByText("Your account's permissions")).toBeNull()
})

test("scope authorization starts only from the checkbox chain and has its own dialog title", async () => {
  vi.mocked(commands.larkCliAuthLogin).mockResolvedValueOnce(fixtures.login)
  render(<LarkCliCard />)
  await screen.findByText("Chen Yang (Leo)")

  // The top button is sign-out only; no mixed "sign in / authorize" action exists.
  expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled()
  expect(screen.queryByRole("button", { name: /Sign in \/ Authorize/ })).toBeNull()
  expect(screen.queryByRole("button", { name: /Request selected/ })).toBeNull()

  fireEvent.click(screen.getByRole("button", { name: /Permission details/ }))
  fireEvent.click(screen.getByRole("checkbox", { name: "读取消息与群聊" }))
  fireEvent.click(screen.getByRole("button", { name: "Request selected (1)" }))

  expect(await screen.findByText("Request permissions")).toBeVisible()
  expect(vi.mocked(commands.larkCliAuthLogin)).toHaveBeenCalledWith({
    scopes: ["im:message:readonly"]
  })
  expect(screen.queryByText("Sign in to Feishu")).toBeNull()
})

test("the sign-in dialog polls by itself with no confirmation button to press", async () => {
  vi.mocked(commands.larkCliAuthStatus).mockResolvedValueOnce(signedOutAuth)
  vi.mocked(commands.larkCliAuthLogin).mockResolvedValueOnce(fixtures.login)
  render(<LarkCliCard />)

  fireEvent.click(await screen.findByRole("button", { name: "Sign in to Feishu" }))
  expect(
    await screen.findByText("Waiting for the scan — this finishes automatically, no button to press.")
  ).toBeVisible()
  expect(vi.mocked(commands.larkCliAuthComplete)).toHaveBeenCalledWith({ deviceCode: "dc_1" })
  expect(screen.queryByRole("button", { name: "I've signed in" })).toBeNull()
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled()
  // The countdown comes from expires_in, not from the blocking CLI call.
  expect(screen.getByText(/Code expires in 10:00/)).toBeVisible()
})

test("an expired device code withdraws the QR code and offers a fresh one", async () => {
  vi.mocked(commands.larkCliAuthStatus).mockResolvedValueOnce(signedOutAuth)
  vi.mocked(commands.larkCliAuthLogin)
    .mockResolvedValueOnce(fixtures.login)
    .mockResolvedValueOnce({ ...fixtures.login, deviceCode: "dc_2" })
  vi.mocked(commands.larkCliAuthComplete).mockResolvedValueOnce({
    ok: false,
    message: "device_code expired"
  })
  render(<LarkCliCard />)

  fireEvent.click(await screen.findByRole("button", { name: "Sign in to Feishu" }))
  expect(await screen.findByText(/This code has expired/)).toBeVisible()
  // No stale "finish" button, and the user can get a new code without leaving the dialog.
  expect(screen.queryByRole("button", { name: "I've signed in" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Get a new code" }))
  await waitFor(() => expect(vi.mocked(commands.larkCliAuthLogin)).toHaveBeenCalledTimes(2))
})

test("the bot identity stays visible in the component card after signing out", async () => {
  vi.mocked(commands.larkCliAuthStatus).mockResolvedValueOnce(signedOutAuth)
  render(<LarkCliCard />)

  expect(await screen.findByText("App identity (bot)")).toBeVisible()
  expect(screen.getByText("Ready for group pushes")).toBeVisible()
  expect(screen.getByText(/App ID: cli_x/)).toBeVisible()
  // The account card is still collapsed: the bot row is a component fact, not account state.
  expect(screen.queryByText("Your account's permissions")).toBeNull()
  expect(screen.queryByText(/Bot identity ready/)).toBeNull()
})
