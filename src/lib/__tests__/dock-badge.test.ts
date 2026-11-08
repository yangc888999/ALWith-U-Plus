import { afterEach, beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  setBadgeCount: vi.fn(async (_count?: number) => {}),
  handler: undefined as undefined | ((event: { payload: boolean }) => void)
}))

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setBadgeCount: mocks.setBadgeCount,
    onFocusChanged: (handler: (event: { payload: boolean }) => void) => {
      mocks.handler = handler
      return Promise.resolve(() => {})
    }
  })
}))

async function load() {
  vi.resetModules()
  return await import("../dock-badge")
}

beforeEach(() => {
  mocks.setBadgeCount.mockClear()
  mocks.handler = undefined
  vi.spyOn(document, "hasFocus").mockReturnValue(false)
})

afterEach(() => {
  vi.restoreAllMocks()
})

test("each settle while the app is in the background adds one badge", async () => {
  const { bumpDockBadge } = await load()
  bumpDockBadge()
  expect(mocks.setBadgeCount).toHaveBeenLastCalledWith(1)
  bumpDockBadge()
  expect(mocks.setBadgeCount).toHaveBeenLastCalledWith(2)
})

test("a focused app does not badge, and clearing removes the badge entirely", async () => {
  const { bumpDockBadge, clearDockBadge } = await load()
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
  bumpDockBadge()
  expect(mocks.setBadgeCount).not.toHaveBeenCalled()

  clearDockBadge()
  expect(mocks.setBadgeCount).toHaveBeenLastCalledWith(undefined)
})

test("returning to the window clears the badge through the native focus event", async () => {
  const { bumpDockBadge } = await load()
  bumpDockBadge()
  expect(mocks.setBadgeCount).toHaveBeenLastCalledWith(1)
  mocks.handler?.({ payload: true })
  expect(mocks.setBadgeCount).toHaveBeenLastCalledWith(undefined)
})
