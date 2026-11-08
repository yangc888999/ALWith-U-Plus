import { beforeEach, expect, test, vi } from "vitest"

const STORAGE_KEY = "alwith:default-model"

beforeEach(() => localStorage.clear())

test("keeps the configured default model and effort across a relaunch", async () => {
  let store = await import("../default-model")
  store.setDefaultModelChoice({ model: "gateway:hakimi:claude-opus-5-5", effort: "high" })

  vi.resetModules()
  store = await import("../default-model")

  expect(store.defaultModelChoice()).toEqual({ model: "gateway:hakimi:claude-opus-5-5", effort: "high" })
  expect(store.defaultModelSnapshot()).toEqual({ model: "gateway:hakimi:claude-opus-5-5", effort: "high" })
})

test("clearing restores the built-in default and notifies subscribers", async () => {
  const store = await import("../default-model")
  const seen: unknown[] = []
  const stop = store.subscribeDefaultModel(() => seen.push(store.defaultModelChoice()))

  store.setDefaultModelChoice({ model: "gpt-6.1-sol", effort: null })
  expect(store.defaultModelChoice()).toEqual({ model: "gpt-6.1-sol", effort: null })
  store.setDefaultModelChoice(null)
  expect(store.defaultModelChoice()).toBeNull()
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull()

  store.setDefaultModelChoice({ model: "gpt-6-sol", effort: "low" })
  store.setDefaultModelChoice({ model: "gpt-6-sol", effort: "low" })
  // One notification per stored change.
  expect(seen).toEqual([
    { model: "gpt-6.1-sol", effort: null },
    null,
    { model: "gpt-6-sol", effort: "low" }
  ])
  stop()
})

test("does not revive malformed stored choices", async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ model: 42, effort: "high" }))

  vi.resetModules()
  const store = await import("../default-model")

  expect(store.defaultModelChoice()).toBeNull()
})

test("rejects an invalid configuration instead of storing it", async () => {
  const store = await import("../default-model")
  expect(() => store.setDefaultModelChoice({ model: 7 as unknown as string, effort: null })).toThrow(
    "Invalid default model configuration"
  )
  expect(store.defaultModelChoice()).toBeNull()
})
