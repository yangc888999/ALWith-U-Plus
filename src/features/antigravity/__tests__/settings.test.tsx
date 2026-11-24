import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

import { AntigravityAccountSection, useAntigravityAccount } from "../antigravity-account"
import { AntigravityModelSettings } from "../antigravity-model-settings"
import { antigravityDefaultThinking, antigravityModelRows } from "../models"

const host = vi.hoisted(() => ({
  listener: undefined as ((event: { payload: string }) => void) | undefined,
  status: vi.fn(async () => ({ signedIn: true, authType: "oauth-personal" })),
  start: vi.fn(async () => null),
  send: vi.fn(async (_args: { message: string }) => null)
}))

vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<object>()), isTauri: () => true }))
vi.mock("@tauri-apps/api/event", async (original) => ({
  ...(await original<object>()),
  listen: async (_event: string, listener: typeof host.listener) => {
    host.listener = listener
    return () => {
      host.listener = undefined
    }
  }
}))
vi.mock("@/bindings", () => ({
  commands: { antigravityStatus: host.status, antigravityStart: host.start, antigravitySend: host.send }
}))

function Settings() {
  const account = useAntigravityAccount(true)
  return (
    <>
      <AntigravityAccountSection account={account} />
      <AntigravityModelSettings />
    </>
  )
}

function emit(message: unknown): void {
  act(() => host.listener?.({ payload: JSON.stringify(message) }))
}

async function lastCommand() {
  await waitFor(() => expect(host.send).toHaveBeenCalled())
  return JSON.parse(host.send.mock.lastCall![0].message) as { type: string; readId?: string; methodId?: string }
}

beforeAll(async () => {
  await initI18n("en")
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel")
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

test("opens a saved Google sign-in without starting OAuth; changing models or Effort never reads the account", async () => {
  localStorage.setItem("alwith:antigravity:tier", JSON.stringify({ name: "Google AI Pro" }))
  localStorage.setItem("alwith:antigravity:default-thinking", "low")
  render(<Settings />)
  expect(await screen.findByText("Google account signed in · Google AI Pro")).toBeInTheDocument()
  expect(screen.getAllByRole("listitem")).toHaveLength(4)
  expect(antigravityDefaultThinking("gemini-4-argon")).toBe("low")

  fireEvent.click(screen.getByRole("combobox", { name: /Gemini 4 Argon/ }))
  const option = await screen.findByRole("option", { name: "medium" })
  fireEvent.pointerDown(option, { pointerType: "mouse" })
  fireEvent.click(option)
  expect(antigravityDefaultThinking("gemini-4-argon")).toBe("medium")
  expect(antigravityDefaultThinking("gemini-4-neon")).toBe("low")

  fireEvent.click(screen.getByRole("switch", { name: /Gemini 4 Neon/ }))
  expect(antigravityModelRows().find((row) => row.id === "gemini-4-neon")?.enabled).toBe(false)
  expect(host.status).toHaveBeenCalledTimes(1)
  expect(host.start).not.toHaveBeenCalled()
  expect(host.send).not.toHaveBeenCalled()
})

test("manual quota refresh uses the existing account, keeps a good snapshot on failure and clears it on logout", async () => {
  render(<Settings />)
  await screen.findByText("Google account signed in")
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  const read = await lastCommand()
  expect(read).toMatchObject({ type: "usage", readId: expect.any(String) })
  emit({ type: "usage", readId: "stale", usage: { status: "unavailable" } })
  expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled()
  emit({
    type: "usage",
    readId: read.readId,
    tier: { name: "Google AI Pro" },
    usage: {
      status: "ready",
      limits: [
        { group: "Gemini Models", label: "Weekly", remainingPercent: 73, resetsAt: Date.UTC(2026, 10, 29) },
        { group: "Gemini Models", label: "Credits", remainingUnits: 10, resetsAt: null }
      ]
    }
  })
  expect(screen.getByRole("progressbar", { name: "Weekly" })).toHaveAttribute("aria-valuenow", "73")
  expect(screen.getByText("27% used")).toBeInTheDocument()
  expect(screen.getByText("10 units remaining")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  await waitFor(() => expect(host.send).toHaveBeenCalledTimes(2))
  emit({ type: "usage", readId: (await lastCommand()).readId, usage: { status: "error" } })
  expect(screen.getByRole("progressbar", { name: "Weekly" })).toHaveAttribute("aria-valuenow", "73")
  expect(screen.getByText(/showing the last/)).toBeInTheDocument()
  emit({ type: "logged_out" })
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Connect Google" })).toBeInTheDocument()
  expect(host.send.mock.calls.map(([request]) => JSON.parse(request.message).type)).toEqual(["usage", "usage"])
})

test("a successful explicit sign-in reads quota once without repeating login", async () => {
  host.status.mockResolvedValueOnce({ signedIn: false, authType: "oauth-personal" })
  render(<Settings />)
  fireEvent.click(await screen.findByRole("button", { name: "Connect Google" }))
  expect(await lastCommand()).toMatchObject({ type: "login", methodId: "oauth-personal" })
  emit({ type: "logged_in", tier: { name: "Google AI Pro" } })
  await waitFor(() => expect(host.send).toHaveBeenCalledTimes(2))
  expect(await lastCommand()).toMatchObject({ type: "usage", readId: expect.any(String) })
  expect(screen.getByText("Google account signed in · Google AI Pro")).toBeInTheDocument()
})
