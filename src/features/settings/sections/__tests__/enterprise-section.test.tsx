import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"

const host = vi.hoisted(() => ({
  user: { user_uuid: "alice" } as { user_uuid: string },
  handlers: {} as Record<string, ((event: { payload: Record<string, unknown> }) => void) | undefined>,
  status: vi.fn(),
  begin: vi.fn(),
  cancel: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
  request: vi.fn(),
  open: vi.fn()
}))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: Record<string, unknown> }) => void) => {
    host.handlers[name] = callback
    return () => {
      delete host.handlers[name]
    }
  })
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/bindings", () => ({
  commands: {
    enterpriseStatus: host.status,
    enterpriseBegin: host.begin,
    enterpriseCancel: host.cancel,
    enterpriseLogout: host.logout
  }
}))
vi.mock("@/lib/open", () => ({ openExternal: host.open }))
vi.mock("@/features/auth/store", () => ({
  usePlatformAuth: Object.assign(
    (select: (state: { user: typeof host.user }) => unknown) => select({ user: host.user }),
    { getState: () => ({ user: host.user }) }
  ),
  platformApiRequest: host.request,
  requestAccountProviderRefresh: host.refresh
}))
import { EnterpriseSection } from "../enterprise-section"

function emit(name: string, payload: Record<string, unknown>) {
  host.handlers[name]?.({ payload })
}

beforeEach(() => {
  vi.clearAllMocks()
  host.handlers = {}
  host.user = { user_uuid: "alice" }
  host.status.mockResolvedValue({ generation: 7, automatic_renewal: false, requires_login: false, error: null })
  host.request.mockResolvedValue({ enabled: true, authorization_status: "none" })
  host.refresh.mockResolvedValue(undefined)
  host.begin.mockResolvedValue({ state: "proof", authorization_url: "https://login.example/authorize" })
  host.cancel.mockResolvedValue(null)
  host.logout.mockResolvedValue(null)
  host.open.mockResolvedValue(undefined)
})

test("enterprise sign-in opens the native authorization URL and cancellation carries its proof", async () => {
  render(<EnterpriseSection />)
  await screen.findByText("enterprise.signedOut")
  fireEvent.click(screen.getByRole("button", { name: "enterprise.login" }))
  await waitFor(() => expect(host.open).toHaveBeenCalledWith("https://login.example/authorize"))
  expect(host.begin).toHaveBeenCalledWith({ generation: 7 })
  fireEvent.click(screen.getByRole("button", { name: "enterprise.cancel" }))
  await waitFor(() => expect(host.cancel).toHaveBeenCalledWith({ generation: 7, state: "proof" }))
  expect(host.request).not.toHaveBeenCalledWith(expect.anything(), "DELETE")
})

test("account replacement while preparing login cannot open the old callback", async () => {
  let finish!: () => void
  host.refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  render(<EnterpriseSection />)
  await screen.findByText("enterprise.signedOut")
  fireEvent.click(screen.getByRole("button", { name: "enterprise.login" }))
  host.user = { user_uuid: "alice" }
  await act(async () => finish())
  expect(host.begin).not.toHaveBeenCalled()
  expect(host.open).not.toHaveBeenCalled()
})

test("status is checked once on mount instead of polling every three seconds", async () => {
  vi.useFakeTimers()
  try {
    render(<EnterpriseSection />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const afterMount = host.request.mock.calls.length
    expect(afterMount).toBe(1)
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    // No steady-state polling: the account service is not hit again while the page sits idle.
    expect(host.request.mock.calls.length).toBe(afterMount)
    // A window focus without a pending OAuth login must not trigger a refresh either.
    await act(async () => {
      fireEvent.focus(window)
    })
    expect(host.request.mock.calls.length).toBe(afterMount)
  } finally {
    vi.useRealTimers()
  }
})

test("an expired token announced by the native renewal loop flips the section to signed-out", async () => {
  // Start authorized, then the renewal loop reports the token needs a fresh login. The section
  // must re-read on that event and stop claiming authorization — no focus or timer required.
  host.status.mockResolvedValue({ generation: 7, automatic_renewal: true, requires_login: false, error: null })
  host.request.mockResolvedValue({ enabled: true, authorization_status: "authorized", email: "chen.yang@finture.id" })
  render(<EnterpriseSection />)
  await screen.findByText("chen.yang@finture.id")
  expect(screen.getByRole("button", { name: "enterprise.logout" })).toBeInTheDocument()

  host.status.mockResolvedValue({ generation: 7, automatic_renewal: true, requires_login: true, error: "invalid_grant" })
  await act(async () => {
    emit("enterprise:event", { type: "enterpriseRenewalStatus", accountId: "alice", generation: 7 })
  })
  await screen.findByText("enterprise.signedOut")
  expect(screen.queryByText("chen.yang@finture.id")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "enterprise.login" })).toBeInTheDocument()
})

test("status errors expose retry without claiming enterprise authorization", async () => {
  host.request.mockRejectedValue(new Error("offline"))
  render(<EnterpriseSection />)
  await screen.findByRole("alert")
  expect(screen.getByRole("button", { name: "actions.retry" })).toBeInTheDocument()
  expect(screen.queryByText("enterprise.accountHint")).not.toBeInTheDocument()
})

test("a failed native callback releases the pending login so it can be retried", async () => {
  render(<EnterpriseSection />)
  await screen.findByText("enterprise.signedOut")
  fireEvent.click(screen.getByRole("button", { name: "enterprise.login" }))
  await screen.findByRole("button", { name: "enterprise.cancel" })
  await act(async () => {
    emit("enterprise:event", { type: "enterpriseLoginCompleted", accountId: "alice", generation: 7, error: "expired" })
  })
  expect(screen.queryByRole("button", { name: "enterprise.cancel" })).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "enterprise.login" })).toBeInTheDocument()
})

test("switching accounts during a pending sign-in unlocks the new account controls", async () => {
  let release!: () => void
  host.refresh.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const view = render(<EnterpriseSection />)
  await screen.findByText("enterprise.signedOut")
  fireEvent.click(screen.getByRole("button", { name: "enterprise.login" }))
  expect(screen.getByRole("button", { name: "enterprise.login" })).toBeDisabled()
  host.user = { user_uuid: "bob" }
  view.rerender(<EnterpriseSection />)
  await waitFor(() => expect(screen.getByRole("button", { name: "enterprise.login" })).toBeEnabled())
  await act(async () => release())
  expect(host.begin).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "enterprise.login" })).toBeEnabled()
})