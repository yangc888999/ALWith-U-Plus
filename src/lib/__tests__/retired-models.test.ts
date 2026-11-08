import { expect, test } from "vitest"

import { isModelRetired, retireModel, reviveModel } from "@/lib/retired-models"

const STORAGE_KEY = "alwith:retired-models"

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
