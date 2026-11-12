import type { EventCallback } from "@tauri-apps/api/event"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const host = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  listeners: new Map<string, Set<EventCallback<unknown>>>(),
  request: vi.fn(),
  bind: vi.fn(),
  refresh: vi.fn(),
  clear: vi.fn(),
  errors: vi.fn(),
  enterpriseBind: vi.fn(),
  enterpriseRefresh: vi.fn(),
  enterpriseClear: vi.fn()
}))
vi.mock("@/lib/store", () => ({
  openStore: () => ({
    get: async (key: string) => host.values.get(key),
    set: async (key: string, value: unknown) => {
      host.values.set(key, value)
    },
    delete: async (key: string) => {
      host.values.delete(key)
    }
  })
}))
vi.mock("../http", () => ({
  createAuthTransport: () => ({
    request: host.request,
    authenticated: async (action: (token: string) => Promise<void>) => action("test-access"),
    invalidate: async () => {}
  }),
  readAuthGeneration: () => 0,
  bumpAuthGeneration: vi.fn()
}))
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }))
vi.mock("@tauri-apps/plugin-os", () => ({ arch: () => "aarch64", platform: () => "macos" }))
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }))
vi.mock("@tauri-apps/api/event", () => {
  const emit = async (name: string, payload: unknown) => {
    for (const handler of host.listeners.get(name) ?? []) handler({ event: name, id: 0, payload })
  }
  return {
    emit,
    emitTo: async (_target: unknown, name: string, payload: unknown) => emit(name, payload),
    listen: async (name: string, handler: EventCallback<unknown>) => {
      const handlers = host.listeners.get(name) ?? new Set()
      handlers.add(handler)
      host.listeners.set(name, handlers)
      return () => {
        handlers.delete(handler)
      }
    }
  }
})
vi.mock("@/bindings", () => ({
  commands: {
    providersAccountBind: host.bind,
    providersRefreshManaged: host.refresh,
    providersClearManaged: host.clear,
    enterpriseBind: host.enterpriseBind,
    enterpriseRefresh: host.enterpriseRefresh,
    enterpriseClear: host.enterpriseClear
  }
}))
vi.mock("sonner", () => ({ toast: { error: host.errors } }))
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }))

const cached = { user_uuid: "account-a", nickname: "Account A", login_email: "a@example.test" }
const profile = { uuid: cached.user_uuid, nickname: cached.nickname, login_email: cached.login_email }

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv("DEV", false)
  host.values.clear()
  host.listeners.clear()
  host.values.set("access_token", "test-access")
  host.values.set("refresh_token", "test-refresh")
  host.values.set("user", cached)
  host.request.mockReset().mockResolvedValue(profile)
  host.bind.mockResolvedValue(1)
  host.refresh.mockResolvedValue(undefined)
  host.clear.mockResolvedValue(undefined)
  host.enterpriseBind.mockResolvedValue(8)
  host.enterpriseRefresh.mockResolvedValue(null)
  host.enterpriseClear.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function restore() {
  const auth = await import("../store")
  expect(auth.API_BASE_URL).toBe("https://api.alwith.ai/service")
  await auth.initPlatformAuth()
  await vi.waitFor(() => expect(auth.usePlatformAuth.getState().isLoading).toBe(false))
  expect(auth.usePlatformAuth.getState().user?.user_uuid).toBe(cached.user_uuid)
  return auth
}

test("model refresh retries profile validation after cached login survives a startup failure", async () => {
  host.request.mockRejectedValueOnce(new Error("startup offline"))
  const auth = await restore()
  expect(host.bind).not.toHaveBeenCalled()
  await expect(auth.requestAccountProviderRefresh()).resolves.toBeUndefined()
  expect(host.request).toHaveBeenCalledTimes(2)
  const account = { apiBaseUrl: auth.API_BASE_URL, userUuid: cached.user_uuid }
  expect(host.bind).toHaveBeenCalledWith({ account })
  expect(host.enterpriseBind).toHaveBeenCalledWith({ account })
  expect(host.refresh).toHaveBeenCalledWith({ generation: 1, accessToken: "test-access" })
  expect(host.enterpriseRefresh).toHaveBeenCalledWith({
    account,
    generation: 8,
    accessToken: "test-access"
  })
})

test("a failed validation reports its actual error and a later refresh retries it", async () => {
  host.request
    .mockRejectedValueOnce(new Error("startup offline"))
    .mockRejectedValueOnce(new Error("profile unavailable"))
  const auth = await restore()
  await expect(auth.requestAccountProviderRefresh()).rejects.toThrow("profile unavailable")
  expect(host.bind).not.toHaveBeenCalled()
  expect(host.enterpriseBind).not.toHaveBeenCalled()
  expect(host.refresh).not.toHaveBeenCalled()
  expect(host.enterpriseRefresh).not.toHaveBeenCalled()
  await expect(auth.requestAccountProviderRefresh()).resolves.toBeUndefined()
  expect(host.request).toHaveBeenCalledTimes(3)
  expect(host.refresh).toHaveBeenCalledOnce()
})

test("a successfully restored profile does not need another validation before model refresh", async () => {
  const auth = await restore()
  await vi.waitFor(() => expect(host.refresh).toHaveBeenCalledOnce())
  await auth.requestAccountProviderRefresh()
  expect(host.request).toHaveBeenCalledTimes(1)
  expect(host.refresh).toHaveBeenCalledTimes(2)
})

test("background provider refresh warns without a toast while explicit refresh still rejects", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  host.refresh
    .mockRejectedValueOnce(new Error("provider unavailable"))
    .mockRejectedValueOnce(new Error("provider unavailable"))
  const auth = await restore()
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith("[auth] managed provider refresh failed:", "provider unavailable")
  )
  expect(host.errors).not.toHaveBeenCalled()
  await expect(auth.requestAccountProviderRefresh()).rejects.toThrow("provider unavailable")
  expect(warn).toHaveBeenCalledOnce()
  expect(host.errors).not.toHaveBeenCalled()
  await expect(auth.requestAccountProviderRefresh()).resolves.toBeUndefined()
  expect(host.request).toHaveBeenCalledTimes(1)
  expect(host.refresh).toHaveBeenCalledTimes(3)
})

test("validation cannot bind a profile belonging to a different cached account", async () => {
  host.request
    .mockRejectedValueOnce(new Error("startup offline"))
    .mockResolvedValueOnce({ ...profile, uuid: "other-account" })
  const auth = await restore()
  await expect(auth.requestAccountProviderRefresh()).rejects.toThrow("account changed")
  expect(host.bind).not.toHaveBeenCalled()
  expect(host.enterpriseBind).not.toHaveBeenCalled()
  expect(host.refresh).not.toHaveBeenCalled()
  expect(host.enterpriseRefresh).not.toHaveBeenCalled()
  expect(auth.usePlatformAuth.getState().user?.user_uuid).toBe(cached.user_uuid)
  await auth.requestAccountProviderRefresh()
  expect(host.bind).toHaveBeenCalledOnce()
})
