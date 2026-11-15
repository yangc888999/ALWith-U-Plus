import { beforeEach, expect, test, vi } from "vitest"

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(() => Promise.resolve())
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))

beforeEach(() => {
  localStorage.clear()
  invokeMock.mockClear()
  vi.resetModules()
})

function applyElsewhere(value: string | null) {
  if (value === null) localStorage.removeItem("chat.gateway-retry-enabled")
  else localStorage.setItem("chat.gateway-retry-enabled", value)
  window.dispatchEvent(new StorageEvent("storage", { key: "chat.gateway-retry-enabled", newValue: value }))
}

test("importing the module touches nothing: the mirror is primed at boot, not by the import", async () => {
  const mod = await import("../gateway-retry-settings")
  // The regression this guards: the push used to be an import side effect, so it only fired when
  // someone opened 设置 → 供应商. A user who turned the switch off, quit and relaunched got silent
  // retries back — the bridge's AtomicBool resets to true and nothing ever pushed `false` again.
  expect(invokeMock).not.toHaveBeenCalled()
  expect(mod.gatewayRetryEnabled()).toBe(true)
})

test("the boot push sends the stored value, so an off switch survives a restart", async () => {
  localStorage.setItem("chat.gateway-retry-enabled", "false")
  const mod = await import("../gateway-retry-settings")
  mod.startGatewayRetrySync()
  expect(invokeMock).toHaveBeenCalledTimes(1)
  expect(invokeMock).toHaveBeenCalledWith("gateway_retry_set", { enabled: false })
  expect(mod.gatewayRetryEnabled()).toBe(false)
})

test("an empty store still pushes the default, so the mirror never disagrees with the UI", async () => {
  const mod = await import("../gateway-retry-settings")
  mod.startGatewayRetrySync()
  expect(invokeMock).toHaveBeenCalledTimes(1)
  expect(invokeMock).toHaveBeenCalledWith("gateway_retry_set", { enabled: true })
})

test("the boot push is idempotent, so a second caller cannot double-push", async () => {
  const mod = await import("../gateway-retry-settings")
  mod.startGatewayRetrySync()
  mod.startGatewayRetrySync()
  // main.tsx calls it once; the settings page may call it again on mount. One push, one mirror.
  expect(invokeMock).toHaveBeenCalledTimes(1)
})

test("flipping the switch reaches the bridge without a restart", async () => {
  const mod = await import("../gateway-retry-settings")
  mod.setGatewayRetryEnabled(false)
  expect(invokeMock).toHaveBeenLastCalledWith("gateway_retry_set", { enabled: false })
  expect(localStorage.getItem("chat.gateway-retry-enabled")).toBe("false")
  mod.setGatewayRetryEnabled(true)
  expect(invokeMock).toHaveBeenLastCalledWith("gateway_retry_set", { enabled: true })
  expect(localStorage.getItem("chat.gateway-retry-enabled")).toBe("true")
})

test("a change made in the settings window reaches a running chat", async () => {
  const mod = await import("../gateway-retry-settings")
  const seen: boolean[] = []
  mod.subscribeGatewayRetryEnabled(() => seen.push(mod.gatewayRetryEnabled()))
  applyElsewhere("false")
  expect(mod.gatewayRetryEnabled()).toBe(false)
  expect(seen).toEqual([false])
})

test("an unrelated storage event does not republish the switch", async () => {
  const mod = await import("../gateway-retry-settings")
  const listener = vi.fn()
  mod.subscribeGatewayRetryEnabled(listener)
  window.dispatchEvent(new StorageEvent("storage", { key: "chat.something-else", newValue: "1" }))
  expect(listener).not.toHaveBeenCalled()
  expect(mod.gatewayRetryEnabled()).toBe(true)
})

test("a rejected bridge command never breaks boot or the settings UI", async () => {
  invokeMock.mockRejectedValueOnce(new Error("no bridge"))
  const mod = await import("../gateway-retry-settings")
  expect(() => mod.startGatewayRetrySync()).not.toThrow()
  expect(mod.gatewayRetryEnabled()).toBe(true)
  mod.setGatewayRetryEnabled(false)
  expect(mod.gatewayRetryEnabled()).toBe(false)
})
