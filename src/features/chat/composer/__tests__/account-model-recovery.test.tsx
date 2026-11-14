/**
 * Account-model recovery: the recovery card is the *only* usable model picker on the surface, and
 * "继续" must stay disabled until a real model has been picked. A failed resume keeps the pick.
 */
import type { Session } from "@alwith/api"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

const controls = vi.hoisted(() => ({
  resume: vi.fn(async (_id: string, _model: string | null) => {}),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock("@/bindings", () => ({
  commands: {},
  events: new Proxy({}, { get: () => ({ name: "stub" }) })
}))
vi.mock("@/lib/client", () => ({
  client: {
    resumeAccountModel: controls.resume,
    store: { getState: () => ({ accountModelRecovery: {} }), subscribe: () => () => {} }
  },
  useApp: () => undefined
}))
vi.mock("@/lib/use-providers", () => ({ useProviders: () => null }))
vi.mock("sonner", () => ({
  toast: { error: controls.toastError, success: controls.toastSuccess, info: vi.fn() }
}))
// A minimal stand-in for the package picker: it renders the trigger label and reports one model.
// The placeholder logic under test lives in `DraftModelSelect`, which this proxy still exercises.
vi.mock("@alwith/module-chat/model-select", () => ({
  ModelSelect: ({ value, onChange }: { value: { label: string }; onChange: (item: { api_id: string }) => void }) => (
    <button
      type="button"
      data-testid="recovery-model-trigger"
      onClick={() => onChange({ api_id: "gateway:demo:model-a" })}
    >
      {value.label}
    </button>
  )
}))

import { AccountModelRecovery } from "../account-model-recovery"

const session = { id: "session-recovery" } as unknown as Session
const MODEL = "gateway:demo:model-a"

beforeAll(async () => {
  await initI18n("en")
})
beforeEach(() => {
  controls.resume.mockReset()
  controls.resume.mockResolvedValue(undefined)
  controls.toastError.mockClear()
  controls.toastSuccess.mockClear()
})
afterEach(cleanup)

test("nothing picked shows the placeholder, the hint and a disabled resume button", () => {
  render(<AccountModelRecovery session={session} />)
  expect(screen.getByTestId("recovery-model-trigger")).toHaveTextContent("Select a model")
  expect(screen.getByText("Choose a model in the recovery card below first")).toBeTruthy()
  expect(screen.getByText("Select a model to continue. History remains available.")).toBeTruthy()
  const resume = screen.getByRole("button", { name: "Continue with selected model" })
  expect((resume as HTMLButtonElement).disabled).toBe(true)
  expect(document.querySelector("[data-recovery-model]")?.getAttribute("data-recovery-model")).toBe("none")
})

test("picking a model enables resume, echoes back and calls client.resumeAccountModel", async () => {
  render(<AccountModelRecovery session={session} />)
  fireEvent.click(screen.getByTestId("recovery-model-trigger"))
  expect(screen.getByTestId("recovery-model-trigger")).not.toHaveTextContent("Select a model")
  expect(document.querySelector("[data-recovery-model]")?.getAttribute("data-recovery-model")).toBe(MODEL)
  const resume = screen.getByRole("button", { name: "Continue with selected model" })
  expect((resume as HTMLButtonElement).disabled).toBe(false)
  await act(async () => {
    fireEvent.click(resume)
  })
  expect(controls.resume).toHaveBeenCalledWith("session-recovery", MODEL)
  expect(controls.toastSuccess).toHaveBeenCalledWith("Recovered. You can continue the conversation.")
})

test("a failed resume keeps the selected model and shows the reason", async () => {
  controls.resume.mockRejectedValueOnce(new Error("account changed again"))
  render(<AccountModelRecovery session={session} />)
  fireEvent.click(screen.getByTestId("recovery-model-trigger"))
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Continue with selected model" }))
  })
  expect(screen.getByRole("alert")).toHaveTextContent("account changed again")
  expect(document.querySelector("[data-recovery-model]")?.getAttribute("data-recovery-model")).toBe(MODEL)
  expect(screen.getByTestId("recovery-model-trigger")).not.toHaveTextContent("Select a model")
  expect((screen.getByRole("button", { name: "Continue with selected model" }) as HTMLButtonElement).disabled).toBe(
    false
  )
  expect(controls.toastError).toHaveBeenCalledWith("account changed again")
})
