import { defaultPreferences } from "@alwith/module-voice"
import type { VoiceSettingsSlots } from "@alwith/module-voice/react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { settingsFixture } from "@/lib/__tests__/settings-fixture"
import { type SettingsSnapshot, settingsStore } from "@/lib/settings-store"
import { mockOf } from "@/test/mock-of"

import { VoiceSection } from "../voice-section"

const { openExternal, reportError, reportInfo } = vi.hoisted(() => ({
  openExternal: vi.fn(async () => {}),
  reportError: vi.fn(),
  // `toast.info` is a real call site (`voice.enableNeedsKey`). Leaving it out of the mock made
  // every info path throw "toast.info is not a function" into the component's catch, so a broken
  // branch still looked green.
  reportInfo: vi.fn()
}))
vi.mock("sonner", () => ({ toast: { error: reportError, success: vi.fn(), info: reportInfo } }))
vi.mock("@/lib/open", () => ({ openExternal }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/features/voice/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/voice/settings")>()),
  loadVoiceSettings: vi.fn(),
  saveVoiceSettings: vi.fn(),
  saveVoiceCredential: vi.fn(),
  deleteVoiceCredential: vi.fn(),
  voiceProfiles: vi.fn()
}))
import * as voiceSettings from "@/features/voice/settings"

// Bare `vi.fn()` returns undefined, so `settings.provider` threw a TypeError that the component
// caught and reported — the "retry succeeded" path never actually ran. Give both mocks the shapes
// their signatures promise. `doubao` is the default provider, so the profile map must cover it.
const profiles = { vui: false, doubao: true }
let fixture: ReturnType<typeof settingsFixture>
const changed = (value: boolean): void => fixture.changed({ "voice.enabled": value })

/**
 * Wait until the switch is actually interactive.
 *
 * `toBeEnabled()` is NOT usable here. The switch is a base-ui `<span role="switch">`, which
 * expresses "disabled" as `aria-disabled="true"` and never sets the native `disabled` attribute —
 * and jest-dom's `toBeEnabled()` only inspects native disabled state. It therefore returns true
 * even while the control is logically disabled, so `waitFor(() => expect(toggle).toBeEnabled())`
 * resolves on the very first render, before `useVoiceEnabled` has resolved. A click landing in
 * that window is silently swallowed by base-ui's own `if (disabled) return`, `write` is never
 * called, and the test fails with "Number of calls: 0" — but only when the machine is busy enough
 * to widen the window. That is the real source of this suite's intermittent failure.
 *
 * base-ui removes `aria-disabled` entirely once enabled, so its absence is the readiness signal.
 */
async function ready(toggle: HTMLElement): Promise<void> {
  await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"))
}
beforeEach(() => {
  fixture = settingsFixture()
  mockOf(voiceSettings, "loadVoiceSettings").mockResolvedValue(defaultPreferences())
  mockOf(voiceSettings, "voiceProfiles").mockResolvedValue({ ...profiles })
})
vi.mock("@alwith/module-voice/react", () => ({
  VoiceSettingsForm: ({ slots }: { slots: VoiceSettingsSlots }) => {
    const KeyLink = slots.KeyLink
    if (KeyLink === undefined) throw new Error("missing_key_link_slot")
    return (
      <KeyLink href="https://console.volcengine.com/speech/new/setting/apikeys" target="_blank">
        Get API key
      </KeyLink>
    )
  }
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

test("voice is disabled by default and its topmost switch persists changes", async () => {
  const view = render(<VoiceSection />)
  const toggle = await screen.findByRole("switch", { name: "voice.enabled" })
  await ready(toggle)
  expect(toggle).not.toBeChecked()
  expect(
    toggle.compareDocumentPosition(screen.getByText("voice.shortcut")) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toBeChecked())
  await ready(toggle)
  view.unmount()
  render(<VoiceSection />)
  await ready(screen.getByRole("switch", { name: "voice.enabled" }))
  expect(screen.getByRole("switch", { name: "voice.enabled" })).toBeChecked()
  act(() => changed(false))
  expect(screen.getByRole("switch", { name: "voice.enabled" })).not.toBeChecked()
})

test("a late initial read does not overwrite a newer voice preference", async () => {
  let resolve!: (value: SettingsSnapshot) => void
  mockOf(settingsStore, "read").mockImplementationOnce(
    () =>
      new Promise<SettingsSnapshot>((done) => {
        resolve = done
      })
  )
  render(<VoiceSection />)
  await waitFor(() => expect(mockOf(settingsStore, "read")).toHaveBeenCalled())
  await act(() => {
    return Promise.try(() => {
      changed(false)
      resolve({ revision: 0, values: { "voice.enabled": true }, browserMigrated: true })
    })
  })
  expect(screen.getByRole("switch", { name: "voice.enabled" })).not.toBeChecked()
})

test("a failed preference save reports the error and allows retrying", async () => {
  mockOf(settingsStore, "write").mockRejectedValueOnce(new Error("disk full"))
  render(<VoiceSection />)
  const toggle = screen.getByRole("switch", { name: "voice.enabled" })
  await ready(toggle)
  expect(toggle).not.toBeChecked()
  fireEvent.click(toggle)
  await waitFor(() => expect(reportError).toHaveBeenCalledWith("disk full"))
  // `saving` is cleared in a `finally` on a different microtask chain than the toast, so the
  // switch re-enables a tick after the error is reported. Wait for the observable state.
  await ready(toggle)
  expect(toggle).not.toBeChecked()
  fireEvent.click(toggle)
  // The write spy counts the *call*, but the fixture broadcasts `accept()` one microtask later
  // inside `Promise.try`. Waiting on the call count therefore proves nothing about the UI: the
  // switch is driven by the store subscription, which lands after it. Wait for the switch itself.
  await waitFor(() => expect(toggle).toBeChecked())
  expect(mockOf(settingsStore, "write")).toHaveBeenCalledTimes(2)
  // The retry really succeeded — no second error. Without this the test would pass even if the
  // "success" path threw and got swallowed by the component's catch.
  expect(reportError).toHaveBeenCalledExactlyOnceWith("disk full")
  // A configured profile means no "you still need a key" nag on the successful retry.
  expect(reportInfo).not.toHaveBeenCalled()
})

// The switch turning on without a configured key is the case users hit ("我打开了也不行"), so the
// nag must fire on the transition to true. The retry test above cannot cover it: it asserts the
// happy path where a profile exists.
test("enabling voice without a configured profile warns that a key is still needed", async () => {
  mockOf(voiceSettings, "voiceProfiles").mockResolvedValue({ ...profiles, doubao: false })
  render(<VoiceSection />)
  const toggle = screen.getByRole("switch", { name: "voice.enabled" })
  await ready(toggle)
  fireEvent.click(toggle)
  await waitFor(() => expect(reportInfo).toHaveBeenCalledWith("voice.enableNeedsKey"))
  // The preference still persists: the warning is advice, not a refusal to save.
  await waitFor(() => expect(toggle).toBeChecked())
  expect(reportError).not.toHaveBeenCalled()
})

// Turning it off must not warn — there is no key to configure for a disabled microphone.
test("disabling voice never warns about a missing key", async () => {
  act(() => changed(true))
  mockOf(voiceSettings, "voiceProfiles").mockResolvedValue({ ...profiles, doubao: false })
  render(<VoiceSection />)
  const toggle = screen.getByRole("switch", { name: "voice.enabled" })
  await ready(toggle)
  await waitFor(() => expect(toggle).toBeChecked())
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).not.toBeChecked())
  expect(reportInfo).not.toHaveBeenCalled()
  expect(reportError).not.toHaveBeenCalled()
})

test("key links open once without reaching native plugin document handlers", () => {
  const nativeClick = vi.fn()
  document.body.addEventListener("click", nativeClick)
  try {
    render(<VoiceSection />)
    fireEvent.click(screen.getByRole("link", { name: "Get API key" }))
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://console.volcengine.com/speech/new/setting/apikeys")
    expect(nativeClick).not.toHaveBeenCalled()
  } finally {
    document.body.removeEventListener("click", nativeClick)
  }
})
