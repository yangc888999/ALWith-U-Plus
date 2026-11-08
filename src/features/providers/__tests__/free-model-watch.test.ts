import { expect, test, vi } from "vitest"

import {
  checkFreeModels,
  formatNewFreeModels,
  isFreeModelId,
  newFreeModels,
  parseFreeModelIds
} from "../free-model-watch"

/** In-memory stand-in for localStorage so the baseline logic runs without a DOM store. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      data.set(key, value)
    }
  }
}

function catalog(...ids: string[]): string {
  return JSON.stringify({ data: ids.map((id) => ({ id })) })
}

test("only the :free suffix marks a free model, case and whitespace aside", () => {
  expect(isFreeModelId("meta-llama/llama-3.3-70b-instruct:free")).toBe(true)
  expect(isFreeModelId("  Vendor/Model:FREE  ")).toBe(true)
  expect(isFreeModelId("vendor/model")).toBe(false)
  expect(isFreeModelId("vendor/model:free-preview")).toBe(false)
})

test("the catalog parser keeps just free ids, de-duplicates and sorts them", () => {
  const text = catalog("vendor/b:free", "vendor/a:free", "vendor/paid", "vendor/b:free")
  expect(parseFreeModelIds(text)).toEqual(["vendor/a:free", "vendor/b:free"])
  expect(() => parseFreeModelIds("{}")).toThrow(/no data array/)
  expect(() => parseFreeModelIds(catalog("vendor/paid"))).toThrow(/no free models/)
})

test("only ids absent from the previous check are new", () => {
  expect(newFreeModels(["a:free", "b:free"], ["b:free", "c:free"])).toEqual(["c:free"])
  expect(newFreeModels([], ["a:free"])).toEqual(["a:free"])
})

test("the first check establishes a silent baseline, later checks report only additions", async () => {
  const store = memoryStorage()
  const onNew = vi.fn()
  const first = await checkFreeModels({ fetcher: () => Promise.resolve(catalog("a:free", "b:free")), onNew, storage: store })
  expect(first).toEqual([])
  expect(onNew).not.toHaveBeenCalled()
  // The baseline is persisted, not just held in a closure.
  expect(JSON.parse(store.data.get("alwith:free-model-watch/known") ?? "[]")).toEqual(["a:free", "b:free"])

  const second = await checkFreeModels({
    fetcher: () => Promise.resolve(catalog("a:free", "b:free", "c:free")),
    onNew,
    storage: store
  })
  expect(second).toEqual(["c:free"])
  expect(onNew).toHaveBeenCalledWith(["c:free"])
})

test("a malformed baseline re-baselines instead of reporting every model as new", async () => {
  const store = memoryStorage({ "alwith:free-model-watch/known": "{not json" })
  const onNew = vi.fn()
  const fresh = await checkFreeModels({ fetcher: () => Promise.resolve(catalog("a:free")), onNew, storage: store })
  expect(fresh).toEqual([])
  expect(onNew).not.toHaveBeenCalled()
})

test("a failed fetch leaves the previous baseline untouched", async () => {
  const store = memoryStorage({ "alwith:free-model-watch/known": JSON.stringify(["a:free"]) })
  await expect(
    checkFreeModels({ fetcher: () => Promise.resolve("not json"), storage: store })
  ).rejects.toThrow()
  expect(store.data.get("alwith:free-model-watch/known")).toBe(JSON.stringify(["a:free"]))
})

test("notification bodies preview three ids and summarize the rest", () => {
  expect(formatNewFreeModels(["a:free", "b:free"])).toBe("a:free、b:free")
  expect(formatNewFreeModels(["a:free", "b:free", "c:free", "d:free"])).toBe("a:free、b:free、c:free … +1")
})
