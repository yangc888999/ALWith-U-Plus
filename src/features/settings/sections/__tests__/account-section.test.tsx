import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { usePlatformAuth } from "@/features/auth/store"
import { profileOverrides } from "@/features/profile/profile-store"
import { initI18n } from "@/lib/i18n"

import { AccountSection } from "../account-section"

const mocks = vi.hoisted(() => ({ savePreference: vi.fn(async () => {}) }))
vi.mock("@/lib/preferences", () => ({ savePreference: mocks.savePreference }))
vi.mock("@/features/mobile/phone-login-view", () => ({ PhoneLoginView: () => null }))

const user = { user_uuid: "u-1", nickname: "Leo", login_email: "leo@yup.id" }

beforeEach(async () => {
  await initI18n("en")
  act(() => usePlatformAuth.setState({ user, isAuthenticated: true, isLoading: false, _initialized: true }))
  act(() => profileOverrides.setState({ owner: null, nickname: null, avatar: null }))
  mocks.savePreference.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test("the nickname editor saves a local display name over the account one", async () => {
  const view = render(<AccountSection />)
  const input = view.getByRole("textbox", { name: "Nickname" })
  expect(input).toHaveValue("Leo")
  expect(view.getByRole("button", { name: "Save" })).toBeDisabled()

  fireEvent.change(input, { target: { value: "小哥哥" } })
  fireEvent.click(view.getByRole("button", { name: "Save" }))

  await waitFor(() => expect(profileOverrides.getState().nickname).toBe("小哥哥"))
  expect(mocks.savePreference).toHaveBeenCalledWith("profileNickname", "小哥哥")
  // The override is stamped with the account that wrote it.
  expect(mocks.savePreference).toHaveBeenCalledWith("profileOwner", "u-1")
  expect(input).toHaveValue("小哥哥")
})

test("emptying the nickname falls back to the account name instead of saving a blank", async () => {
  act(() => profileOverrides.setState({ owner: "u-1", nickname: "小哥哥" }))
  const view = render(<AccountSection />)
  const input = view.getByRole("textbox", { name: "Nickname" })
  expect(input).toHaveValue("小哥哥")

  fireEvent.change(input, { target: { value: "" } })
  fireEvent.click(view.getByRole("button", { name: "Save" }))

  await waitFor(() => expect(profileOverrides.getState().nickname).toBeNull())
  expect(mocks.savePreference).toHaveBeenCalledWith("profileNickname", null)
  // Back to the account name, not an empty label.
  expect(input).toHaveValue("Leo")
})

test("the avatar can be handed back to the account one", async () => {
  act(() => profileOverrides.setState({ owner: "u-1", avatar: "data:image/jpeg;base64,AAA" }))
  const view = render(<AccountSection />)

  fireEvent.click(view.getByRole("button", { name: "Use account avatar" }))

  await waitFor(() => expect(profileOverrides.getState().avatar).toBeNull())
  expect(mocks.savePreference).toHaveBeenCalledWith("profileAvatar", null)
  // Nothing left to reset, so the link disappears.
  await waitFor(() => expect(view.queryByRole("button", { name: "Use account avatar" })).toBeNull())
})

test("without a custom avatar the reset link stays hidden", () => {
  const view = render(<AccountSection />)

  expect(view.queryByRole("button", { name: "Use account avatar" })).toBeNull()
  // The round avatar and the outlined button are the same affordance, both offered.
  expect(view.getAllByRole("button", { name: "Change avatar" })).toHaveLength(2)
})

test("sign-in state sits above the profile it belongs to", () => {
  const view = render(<AccountSection />)
  const headings = view.getAllByRole("group").map((row) => row.getAttribute("aria-labelledby"))
  // The sign-out row is the page's first group; the profile block follows it.
  const labels = headings.map((id) => (id === null ? "" : (view.container.querySelector(`#${id}`)?.textContent ?? "")))
  expect(labels[0]).toBe("Session")
  expect(labels).toContain("Profile")
})
