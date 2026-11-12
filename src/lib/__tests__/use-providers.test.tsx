import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import type { ProviderSnapshot } from "../providers"

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  catalog: vi.fn(),
  save: vi.fn(),
  listen: vi.fn()
}))
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }))
vi.mock("@/bindings", () => ({
  commands: { providersRead: mocks.read, enterpriseCatalog: mocks.catalog, providersSave: mocks.save },
  events: {
    "providers:changed": {
      name: "providers:changed",
      listen: (callback: unknown) => mocks.listen("providers:changed", callback)
    }
  }
}))

const enterprise = {
  id: "custom_alwith_enterprise_account",
  name: "Company",
  baseUrl: "https://issued-gateway.test",
  models: [{ api_id: "issued/model", label: "Issued" }]
}
function snapshot(revision: number, status: ProviderSnapshot["status"] = "applied"): ProviderSnapshot {
  return {
    revision,
    appliedRevision: status === "applied" ? revision : null,
    providers: {},
    customProviders: [],
    builtInModels: {},
    managedProviders: [],
    status,
    error: null
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const receivers = new Map<string, Set<(event: { payload: ProviderSnapshot }) => void>>()
function emit(name: string, value = snapshot(2)) {
  for (const callback of receivers.get(name) ?? []) callback({ payload: value })
}
let providers: typeof import("../providers")
let useProviders: typeof import("../use-providers")["useProviders"]

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  receivers.clear()
  mocks.read.mockResolvedValue(snapshot(2))
  mocks.catalog.mockResolvedValue(enterprise)
  mocks.listen.mockImplementation(async (name: string, callback: (event: { payload: ProviderSnapshot }) => void) => {
    const callbacks = receivers.get(name) ?? new Set()
    receivers.set(name, callbacks)
    callbacks.add(callback)
    return () => callbacks.delete(callback)
  })
  providers = await import("../providers")
  useProviders = (await import("../use-providers")).useProviders
})
afterEach(() => vi.restoreAllMocks())

for (const revision of [2, 3]) {
  test(`provider event revision ${revision} preserves enterprise models in hook, cache and resolver`, async () => {
    const view = renderHook(useProviders)
    await act(async () => {})
    await act(async () => emit("providers:changed", snapshot(revision, "pending")))
    const current = view.result.current!
    expect(current.revision).toBe(revision)
    expect(current.status).toBe("pending")
    expect(current.managedProviders).toEqual([enterprise])
    expect(providers.getProviderSnapshot()).toBe(current)
    const id = providers.gatewayModelId(enterprise.id, "issued/model")
    expect(providers.resolveSessionModel(id, providers.getProviderSnapshot()!)).toBe(id)
    view.unmount()
  })
}

for (const [eventRevision, readRevision, expectedRevision] of [[3, 2, 3], [1, 2, 2], [2, 2, 2]]) {
  test(`read ${readRevision} racing event ${eventRevision} preserves revision ${expectedRevision}`, async () => {
    const read = deferred<ProviderSnapshot>()
    mocks.read.mockReturnValueOnce(read.promise)
    const view = renderHook(useProviders)
    await act(async () => {})
    await act(async () => emit("providers:changed", snapshot(eventRevision!, "pending")))
    await act(async () => read.resolve(snapshot(readRevision!)))
    expect(view.result.current?.revision).toBe(expectedRevision)
    if (eventRevision === readRevision) expect(view.result.current?.status).toBe("pending")
    expect(view.result.current?.managedProviders).toEqual([enterprise])
    await act(async () => emit("providers:changed", snapshot(0)))
    expect(view.result.current?.revision).toBe(expectedRevision)
    expect(providers.getProviderSnapshot()).toBe(view.result.current)
    view.unmount()
  })
}

test("logout at the same revision wins over a pending enterprise projection", async () => {
  const view = renderHook(useProviders)
  await act(async () => {})
  const oldCatalog = deferred<typeof enterprise>()
  mocks.catalog.mockReturnValueOnce(oldCatalog.promise)
  await act(async () => emit("providers:changed"))
  mocks.catalog.mockResolvedValue(null)
  await act(async () => emit("enterprise:models-changed"))
  const revoked = view.result.current
  expect(revoked?.revision).toBe(2)
  expect(revoked?.managedProviders).toEqual([])
  await act(async () => oldCatalog.resolve(enterprise))
  expect(view.result.current).toBe(revoked)
  expect(providers.getProviderSnapshot()).toBe(revoked)
  expect(() => providers.resolveSessionModel(
    providers.gatewayModelId(enterprise.id, "issued/model"), revoked!
  )).toThrow("unavailable")
  view.unmount()
})

test("a late higher-revision read uses the revoked catalog rather than restoring enterprise models", async () => {
  const read = deferred<ProviderSnapshot>()
  mocks.read.mockReturnValueOnce(read.promise)
  const view = renderHook(useProviders)
  await act(async () => {})
  mocks.catalog.mockResolvedValue(null)
  await act(async () => emit("enterprise:models-changed"))
  await act(async () => read.resolve(snapshot(3)))
  expect(view.result.current?.revision).toBe(3)
  expect(view.result.current?.managedProviders).toEqual([])
  expect(providers.getProviderSnapshot()).toBe(view.result.current)
  view.unmount()
})

test("direct reads publish the same projected snapshot to cache and subscribers", async () => {
  const view = renderHook(useProviders)
  await act(async () => {})
  mocks.read.mockResolvedValue(snapshot(3))
  let loaded!: ProviderSnapshot
  await act(async () => { loaded = await providers.loadProviders() })
  expect(loaded.managedProviders).toEqual([enterprise])
  expect(providers.getProviderSnapshot()).toBe(loaded)
  expect(view.result.current).toBe(loaded)
  view.unmount()
})

test("out-of-order projections cannot replace a newer event or notify subscribers", async () => {
  const first = renderHook(useProviders)
  const second = renderHook(useProviders)
  await act(async () => {})
  const slow = deferred<typeof enterprise>()
  mocks.catalog.mockReturnValueOnce(slow.promise)
  await act(async () => emit("providers:changed", snapshot(3)))
  await act(async () => emit("providers:changed", snapshot(4)))
  const accepted = providers.getProviderSnapshot()
  await act(async () => slow.resolve({ ...enterprise, name: "Stale" }))
  expect(first.result.current).toBe(accepted)
  expect(second.result.current).toBe(accepted)
  expect(accepted?.revision).toBe(4)
  expect(accepted?.managedProviders).toEqual([enterprise])
  first.unmount()
  second.unmount()
})

for (const phase of ["read", "projection"] as const) {
  test(`unmount rejects pending ${phase} completion without repopulating cache`, async () => {
    const read = deferred<ProviderSnapshot>()
    const catalog = deferred<typeof enterprise>()
    if (phase === "read") mocks.read.mockReturnValueOnce(read.promise)
    else mocks.catalog.mockReturnValueOnce(catalog.promise)
    const view = renderHook(useProviders)
    await act(async () => {})
    view.unmount()
    await act(async () => {
      read.resolve(snapshot(9))
      catalog.resolve(enterprise)
    })
    expect(providers.getProviderSnapshot()).toBeNull()
  })
}

test("a save begun before logout returns the accepted revoked snapshot", async () => {
  const view = renderHook(useProviders)
  await act(async () => {})
  const saved = deferred<ProviderSnapshot>()
  mocks.save.mockReturnValueOnce(saved.promise)
  const result = providers.saveProviderKey(2, "qwen", null)
  mocks.catalog.mockResolvedValue(null)
  await act(async () => emit("enterprise:models-changed"))
  await act(async () => saved.resolve(snapshot(2)))
  expect(await result).toBe(providers.getProviderSnapshot())
  expect((await result).managedProviders).toEqual([])
  view.unmount()
})
