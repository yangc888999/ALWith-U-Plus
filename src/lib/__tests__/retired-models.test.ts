import { beforeEach, expect, test } from "vitest"

import { isModelRetired, retireModel, reviveCatalogModels, reviveModel } from "@/lib/retired-models"

const STORAGE_KEY = "alwith:retired-models"

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY)
})

test("a refused model stays retired until the provider is believed again", () => {
  expect(isModelRetired("gpt-6.1-terra")).toBe(false)
  retireModel("gpt-6.1-terra")
  expect(isModelRetired("gpt-6.1-terra")).toBe(true)
  // A successful write proves the provider serves it again.
  reviveModel("gpt-6.1-terra")
  expect(isModelRetired("gpt-6.1-terra")).toBe(false)
})

test("the tombstone survives a reload and ages out on its own", () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      "gpt-6.1-terra": Date.now(),
      "gpt-5.5": Date.now() - 8 * 24 * 60 * 60 * 1000
    })
  )
  expect(isModelRetired("gpt-6.1-terra")).toBe(true)
  // Older than a week: the list may have been restored since, so try it again.
  expect(isModelRetired("gpt-5.5")).toBe(false)
})

test("a corrupt store disables nothing but the memory of the refusal", () => {
  window.localStorage.setItem(STORAGE_KEY, "{not json")
  expect(isModelRetired("gpt-6.1-terra")).toBe(false)
  retireModel("gpt-6.1-terra")
  expect(isModelRetired("gpt-6.1-terra")).toBe(true)
})

test("an empty id is never written", () => {
  retireModel("   ")
  expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
})

test("an engine catalog refresh revives only the ids it actually lists", () => {
  // A provider that withdrew two ids for an hour puts one back. The catalog — not this saved
  // list — decides, and the other tombstone must stay until it is listed again.
  retireModel("gpt-6.1-terra")
  retireModel("gpt-5.5")
  reviveCatalogModels(["gpt-6.1-sol", "gpt-6.1-terra"])
  expect(isModelRetired("gpt-6.1-terra")).toBe(false)
  expect(isModelRetired("gpt-5.5")).toBe(true)
  expect(isModelRetired("gpt-6.1-sol")).toBe(false)
})

test("a repeated refusal refreshes the timestamp instead of leaving it stale", () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "gpt-6.1-terra": Date.now() - 20 * 60_000 }))
  retireModel("gpt-6.1-terra")
  const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, number>
  expect(Date.now() - stored["gpt-6.1-terra"]).toBeLessThan(2_000)
})
