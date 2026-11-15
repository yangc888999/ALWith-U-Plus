/**
 * A revoked account model is a *notice*, not a lock.
 *
 * The reported bug: the composer was parked read-only, its model picker was replaced by a second
 * one inside a card, and CSS pinned the textarea to a single dead row — so a model problem looked
 * like a broken input box. What must hold now:
 *
 *   * the model picker the surface passed is the one that renders (never a replacement);
 *   * the composer is not disabled by the recovery flag;
 *   * exactly one line of text explains the state, and it takes no slot and carries no button;
 *   * sending anyway says what to do instead of failing silently.
 */
import type { Session } from "@alwith/api"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

const controls = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  toastError: vi.fn()
}))

vi.mock("@/bindings", () => ({
  commands: {},
  events: new Proxy({}, { get: () => ({ name: "stub" }) })
}))
vi.mock("sonner", () => ({
  toast: { info: controls.toastInfo, error: controls.toastError, success: vi.fn() }
}))
// The package composer is a third-party surface; what this file tests is which props U hands it.
vi.mock("@alwith/module-chat/conversation", () => ({
  Composer: ({
    modelSelector,
    disabled,
    onSubmit
  }: {
    modelSelector?: React.ReactNode
    disabled?: boolean
    onSubmit?: (content: unknown[]) => Promise<unknown>
  }) => (
    <div data-testid="package-composer" data-disabled={disabled === true ? "yes" : "no"}>
      <div data-testid="selector-slot">{modelSelector}</div>
      <button
        type="button"
        data-testid="send"
        onClick={() => {
          void onSubmit?.([{ type: "text", text: "hello" }])
        }}
      >
        send
      </button>
    </div>
  ),
  setComposerDraft: vi.fn(),
  useComposer: () => ({})
}))
vi.mock("@alwith/module-chat/composer-context", () => ({ usePromptInputAttachments: () => ({ items: [] }) }))
vi.mock("@/features/voice/voice-button", () => ({ VoiceButton: () => null }))
vi.mock("@/features/voice/realtime-voice-button", () => ({ RealtimeVoiceButton: () => null }))
vi.mock("@/core/voice-turn", () => ({ observeVoiceTurn: vi.fn() }))

const { client } = await import("@/lib/client")
const { ChatComposer } = await import("../../composer")

const session = {
  id: "revoked",
  cwd: "/tmp/plain-project",
  state: "idle",
  attached: false,
  readOnly: false,
  restoring: false,
  items: [],
  configOptions: []
} as unknown as Session

const picker = <button type="button" data-testid="surface-picker">model</button>

beforeAll(async () => {
  await initI18n("en")
})
/** Sending is not what this file is about; keep the prompt pending so nothing dispatches. */
let prompt: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  prompt = vi.spyOn(client, "prompt").mockImplementation(() => new Promise(() => {}))
})
afterEach(() => {
  cleanup()
  client.store.setState({ accountModelRecovery: {} })
  controls.toastInfo.mockClear()
  controls.toastError.mockClear()
  vi.restoreAllMocks()
})

test("a revoked account model leaves the input usable and the surface's own picker in place", () => {
  client.store.setState({ accountModelRecovery: { revoked: true } })
  const view = render(<ChatComposer session={session} modelSelector={picker} />)

  // The picker the surface passed is what the composer renders — no replacement control.
  expect(screen.getByTestId("surface-picker")).toBeInTheDocument()
  expect(view.container.querySelector("[data-recovery-model]")).toBeNull()
  // Not a disabled surface: this was the whole complaint.
  expect(screen.getByTestId("package-composer").getAttribute("data-disabled")).toBe("no")
  // Exactly one explanation, one line, no button of its own.
  const notice = screen.getByRole("status")
  expect(notice).toHaveTextContent("Select a model to continue. History remains available.")
  expect(notice.className).toContain("text-xs")
  expect(notice.className).toContain("text-muted-foreground")
  expect(notice.querySelector("button")).toBeNull()
  // The read-only marker and its CSS are gone; nothing pins the textarea any more. The only
  // attribute left is the notice below, and it is named after what it says, not after the lock.
  expect(view.container.querySelector("[data-account-recovery]")).toBeNull()
  expect(view.container.querySelector("[data-model-reselect-notice]")).toBe(notice)
})

test("no notice and no toast when the account model is fine", () => {
  const view = render(<ChatComposer session={session} modelSelector={picker} />)
  expect(view.container.querySelector("[data-model-reselect-notice]")).toBeNull()
  fireEvent.click(screen.getByTestId("send"))
  expect(controls.toastInfo).not.toHaveBeenCalled()
})

test("sending on a revoked model says what to do instead of failing silently", () => {
  client.store.setState({ accountModelRecovery: { revoked: true } })
  render(<ChatComposer session={session} modelSelector={picker} />)

  fireEvent.click(screen.getByTestId("send"))

  // The hint is raised before dispatch, and the send still goes out: the picker is the fix, and the
  // engine's answer is what proves whether the newly picked model works.
  expect(controls.toastInfo).toHaveBeenCalledWith("Select a model to continue. History remains available.")
  expect(prompt).toHaveBeenCalledTimes(1)
})
