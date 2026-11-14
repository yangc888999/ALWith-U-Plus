import { fireEvent, render, waitFor } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"

const host = vi.hoisted(() => ({
  user: { user_uuid: "alice" } as { user_uuid: string } | null,
  status: vi.fn(),
  request: vi.fn(),
  openSettings: vi.fn()
}))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/bindings", () => ({ commands: { enterpriseStatus: host.status, setCompanyModelReasoning: vi.fn() } }))
vi.mock("@/features/auth/store", () => ({
  usePlatformAuth: Object.assign(
    (select: (state: { user: typeof host.user }) => unknown) => select({ user: host.user }),
    { getState: () => ({ user: host.user }) }
  ),
  platformApiRequest: host.request
}))
vi.mock("@/lib/window-manager", () => ({ openSettingsWindow: host.openSettings }))

import { CompanyProviderCard } from "../company-provider-card"

const provider = {
  id: "custom_alwith_enterprise_abc",
  name: "Finture 公司模型",
  baseUrl: "https://gateway.finture.test/v1",
  models: [{ label: "DeepSeek V4.1 Flash", api_id: "deepseek-V4.1-flash", contextWindow: 1_000_000 }]
}

const authorizedNative = {
  generation: 7,
  email: "chen.yang@finture.id",
  automatic_renewal: true,
  requires_login: false,
  error: null
}
const authorizedServer = { enabled: true, authorization_status: "authorized", email: "chen.yang@finture.id" }

beforeEach(() => {
  vi.clearAllMocks()
  host.user = { user_uuid: "alice" }
  host.status.mockResolvedValue(authorizedNative)
  host.request.mockResolvedValue(authorizedServer)
})

test("the company card asks for a sign-in instead of for a URL and a key", async () => {
  host.status.mockResolvedValue({ generation: 7, automatic_renewal: false, requires_login: false, error: null })
  host.request.mockResolvedValue({ enabled: true, authorization_status: "none" })
  const view = render(<CompanyProviderCard provider={null} />)
  await waitFor(() => expect(view.getByTestId("company-provider-state").textContent).toBe("provider.companySignedOut"))
  expect(view.getByText("provider.companySignedOutHint")).toBeTruthy()
  // The whole point: this channel is never configured by hand.
  expect(view.queryByLabelText("Base URL")).toBeNull()
  expect(view.queryByLabelText("API key")).toBeNull()
  expect(view.queryByText("provider.companyModels")).toBeNull()
  fireEvent.click(view.getByRole("button", { name: "provider.companyLogin" }))
  expect(host.openSettings).toHaveBeenCalledWith("account")
})

test("a signed-in company account lists the models it issued and keeps effort editable", async () => {
  const view = render(<CompanyProviderCard provider={provider} />)
  await waitFor(() => expect(view.getByTestId("company-provider-state").textContent).toBe("provider.companySignedInAs"))
  expect(view.getByText("DeepSeek V4.1 Flash")).toBeTruthy()
  expect(view.getByText("deepseek-V4.1-flash")).toBeTruthy()
  // Only the thinking level is ours to change; everything else belongs to the account.
  expect(view.getByText("companyModel.reasoningLabel")).toBeTruthy()
  expect(view.queryByRole("button", { name: "provider.companyLogin" })).toBeNull()
  expect(view.queryByLabelText("Base URL")).toBeNull()
})

test("a cached provider with an expired token must NOT look signed in", async () => {
  // The provider list survives offline; the renewal is what proves sign-in. This is the regression
  // that kept showing 已登录 after the enterprise token had expired.
  host.status.mockResolvedValue({ generation: 7, automatic_renewal: true, requires_login: true, error: "invalid_grant" })
  host.request.mockResolvedValue({ enabled: true, authorization_status: "authorized" })
  const view = render(<CompanyProviderCard provider={provider} />)
  await waitFor(() => expect(view.getByTestId("company-provider-state").textContent).toBe("provider.companyExpired"))
  expect(view.queryByText("provider.companySignedIn")).toBeNull()
  expect(view.queryByText("provider.companySignedInAs")).toBeNull()
  expect(view.getByRole("button", { name: "provider.companyRelogin" })).toBeTruthy()
  expect(view.queryByText("provider.companyModels")).toBeNull()
})

test("a cached provider with no renewal at all must NOT look signed in", async () => {
  host.status.mockResolvedValue({ generation: 7, automatic_renewal: false, requires_login: false, error: null })
  host.request.mockResolvedValue({ enabled: true, authorization_status: "none" })
  const view = render(<CompanyProviderCard provider={provider} />)
  await waitFor(() => expect(view.getByTestId("company-provider-state").textContent).toBe("provider.companySignedOut"))
  expect(view.queryByText("provider.companySignedIn")).toBeNull()
  expect(view.getByRole("button", { name: "provider.companyLogin" })).toBeTruthy()
})

test("a healthy renewal off the company network reads as signed-in offline, not signed out", async () => {
  host.request.mockRejectedValue(new Error("offline"))
  const view = render(<CompanyProviderCard provider={provider} />)
  await waitFor(() => expect(view.getByTestId("company-provider-state").textContent).toBe("provider.companyOffline"))
  expect(view.getByText("DeepSeek V4.1 Flash")).toBeTruthy()
  expect(view.queryByRole("button", { name: "provider.companyLogin" })).toBeNull()
})

test("the server can revoke an otherwise healthy local renewal", async () => {
  host.request.mockResolvedValue({ enabled: false, authorization_status: "authorized" })
  const view = render(<CompanyProviderCard provider={provider} />)
  await waitFor(() => expect(view.getByTestId("company-provider-state").textContent).toBe("provider.companySignedOut"))
  expect(view.queryByText("provider.companySignedIn")).toBeNull()
})