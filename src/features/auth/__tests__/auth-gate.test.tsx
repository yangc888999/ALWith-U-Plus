import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

import { AuthGate, LOCAL_PASSPHRASE, PlatformLogin, readPassphraseUnlocked } from "../auth-gate"
import { authClient, usePlatformAuth } from "../store"

await initI18n("en")

// `AuthGate` reads the window label to decide whether Settings may render its own sign-in form.
// jsdom has no Tauri internals behind that API, so the label is the one thing the suite supplies.
vi.mock("@tauri-apps/api/window", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/window")>()),
  getCurrentWindow: () => ({ label: "main" })
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
  usePlatformAuth.setState({ isLoading: false, isAuthenticated: false })
})

/** Advances fake timers inside `act` so the state updates they cause are flushed. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Opens the local passphrase door, the one mode with no verification code and no network. */
function openPassphrase(onPassphrase?: () => void) {
  render(<PlatformLogin onPassphrase={onPassphrase} />)
  fireEvent.click(screen.getByRole("tab", { name: "Passphrase" }))
  return {
    field: screen.getByLabelText("Passphrase"),
    unlock: screen.getByRole("button", { name: "Unlock with passphrase" })
  }
}

// The passphrase door is local only, so the form that offers it must not be doing work of its own
// while the reader types. The old form kept a one-second `Date.now()` interval for its whole
// lifetime — in every mode — re-rendering the tabs, all fields and both buttons once a second.

test("an idle passphrase form runs no clock at all", async () => {
  vi.useFakeTimers()
  const { field } = openPassphrase(() => {})
  // One pending repeating timer was exactly the per-second re-render.
  expect(vi.getTimerCount()).toBe(0)
  fireEvent.change(field, { target: { value: LOCAL_PASSPHRASE } })
  await advance(3_000)
  expect(vi.getTimerCount()).toBe(0)
})

test("the passphrase door starts with the documented default and enters in one click", async () => {
  const onPassphrase = vi.fn()
  const { field, unlock } = openPassphrase(onPassphrase)
  expect(field).toHaveValue(LOCAL_PASSPHRASE)
  expect(screen.getByText(/Default passphrase: YUP/)).toBeInTheDocument()
  await act(async () => {
    fireEvent.click(unlock)
  })
  expect(onPassphrase).toHaveBeenCalledOnce()
  expect(readPassphraseUnlocked()).toBe(true)
})

test("the login form no longer carries the Desktop sign-in footnote", () => {
  render(<PlatformLogin onPassphrase={() => {}} />)
  expect(screen.queryByText(/sign in independently/i)).toBeNull()
})

test("the verification-code cooldown still counts down and frees the resend button", async () => {
  vi.useFakeTimers()
  vi.spyOn(authClient, "sendVerificationCode").mockResolvedValue(undefined)
  render(<PlatformLogin onPassphrase={() => {}} />)
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "reader@alwith.ai" } })
  const send = screen.getByRole("button", { name: "Send code" })
  expect(send).not.toBeDisabled()

  await act(async () => {
    fireEvent.click(send)
  })
  expect(authClient.sendVerificationCode).toHaveBeenCalledWith("reader@alwith.ai", "LOGIN")
  // The cooldown is the one thing on this form that legitimately needs a clock.
  expect(vi.getTimerCount()).toBe(1)
  expect(screen.getByRole("button", { name: /Resend in 60s/ })).toBeDisabled()

  await advance(1_000)
  expect(screen.getByRole("button", { name: /Resend in 59s/ })).toBeDisabled()

  await advance(59_000)
  expect(screen.getByRole("button", { name: "Send code" })).not.toBeDisabled()
  // The clock stops the moment it has nothing left to count.
  expect(vi.getTimerCount()).toBe(0)
})

test("a wrong passphrase reports it and never reaches the network", async () => {
  const onPassphrase = vi.fn()
  vi.spyOn(authClient, "sendVerificationCode").mockResolvedValue(undefined)
  const { field, unlock } = openPassphrase(onPassphrase)
  fireEvent.change(field, { target: { value: "nope" } })
  await act(async () => {
    fireEvent.click(unlock)
  })
  expect(onPassphrase).not.toHaveBeenCalled()
  expect(screen.getByText("Wrong passphrase.")).toBeInTheDocument()
  expect(readPassphraseUnlocked()).toBe(false)
})

test("the right passphrase unlocks locally and hands the door to the gate", async () => {
  const onPassphrase = vi.fn()
  const { field, unlock } = openPassphrase(onPassphrase)
  fireEvent.change(field, { target: { value: ` ${LOCAL_PASSPHRASE} ` } })
  await act(async () => {
    fireEvent.click(unlock)
  })
  expect(onPassphrase).toHaveBeenCalledTimes(1)
})

// The account service is unreachable outside the company network. A reader who already unlocked
// locally must not be handed back to its restore spinner — that is the trap the old ordering set:
// `isLoading` was answered before `unlocked`, so the escape hatch waited on the very service it
// exists to bypass.
test("an unlocked passphrase outranks the account restore spinner", () => {
  localStorage.setItem("alwith:platform-passphrase-unlocked", "1")
  usePlatformAuth.setState({ isLoading: true, isAuthenticated: false })
  const view = render(
    <AuthGate>
      <div data-testid="app">App</div>
    </AuthGate>
  )
  expect(view.getByTestId("app")).toBeInTheDocument()
  expect(view.container.querySelector("[data-slot='spinner']")).toBeNull()
})

test("an account login still waits for the restore before rendering", () => {
  usePlatformAuth.setState({ isLoading: true, isAuthenticated: false })
  const view = render(
    <AuthGate>
      <div data-testid="app">App</div>
    </AuthGate>
  )
  expect(view.queryByTestId("app")).toBeNull()
  expect(view.container.querySelector("[data-slot='spinner']")).not.toBeNull()
  act(() => usePlatformAuth.setState({ isLoading: false }))
  // No account, no passphrase: the form is the answer once the restore is done.
  expect(view.queryByTestId("app")).toBeNull()
  expect(view.getByRole("tab", { name: "Email code" })).toBeInTheDocument()
})

test("a slow account restore offers the local door instead of holding the spinner", async () => {
  vi.useFakeTimers()
  usePlatformAuth.setState({ isLoading: true, isAuthenticated: false })
  const view = render(
    <AuthGate>
      <div data-testid="app">App</div>
    </AuthGate>
  )
  expect(view.queryByTestId("app")).toBeNull()
  expect(screen.queryByRole("tab", { name: "Passphrase" })).toBeNull()

  await advance(500)
  expect(screen.getByRole("tab", { name: "Passphrase" })).toHaveAttribute("aria-selected", "true")
  expect(screen.getByLabelText("Passphrase")).toHaveValue(LOCAL_PASSPHRASE)
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Unlock with passphrase" }))
  })
  expect(view.getByTestId("app")).toBeInTheDocument()
})

test("unlocking while the account service is still restoring mounts the app, not a spinner", async () => {
  usePlatformAuth.setState({ isLoading: false, isAuthenticated: false })
  const view = render(
    <AuthGate>
      <div data-testid="app">App</div>
    </AuthGate>
  )
  fireEvent.click(screen.getByRole("tab", { name: "Passphrase" }))
  fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: LOCAL_PASSPHRASE } })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Unlock with passphrase" }))
  })
  expect(view.getByTestId("app")).toBeInTheDocument()
  // A restore that lands afterwards must not swap the app back for the spinner.
  act(() => usePlatformAuth.setState({ isLoading: true }))
  expect(view.getByTestId("app")).toBeInTheDocument()
  expect(view.container.querySelector("[data-slot='spinner']")).toBeNull()
})
