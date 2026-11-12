import { afterEach, expect, test, vi } from "vitest"

afterEach(() => vi.restoreAllMocks())

import {
  acknowledgeFreeModels,
  getCachedFreeModels,
  getPendingNewFreeModelIds,
  startFreeModelWatch,
  subscribeFreeModels,
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

test("snapshots keep their identity between reads, so React's store subscription cannot loop", async () => {
  const store = memoryStorage()
  // No cache yet: the empty snapshots must still be the same objects on every read.
  expect(getCachedFreeModels(store)).toBe(getCachedFreeModels(store))
  expect(getPendingNewFreeModelIds(store)).toBe(getPendingNewFreeModelIds(store))

  await checkFreeModels({ fetcher: () => Promise.resolve(catalog("a:free", "b:free")), storage: store })
  const rows = getCachedFreeModels(store)
  expect(rows.map((row) => row.id)).toEqual(["a:free", "b:free"])
  // Unchanged storage must hand back the very same parsed array, not an equal copy.
  expect(getCachedFreeModels(store)).toBe(rows)
  expect(getPendingNewFreeModelIds(store)).toBe(getPendingNewFreeModelIds(store))

  // A write is what replaces the snapshot.
  await checkFreeModels({
    fetcher: () => Promise.resolve(catalog("a:free", "b:free", "c:free")),
    now: () => new Date(2099, 0, 2),
    storage: store
  })
  expect(getCachedFreeModels(store)).not.toBe(rows)
  expect(getPendingNewFreeModelIds(store)).toEqual(["c:free"])
})

test("the first check establishes a silent baseline, later checks report only additions", async () => {
  const store = memoryStorage()
  const onNew = vi.fn()
  const first = await checkFreeModels({ fetcher: () => Promise.resolve(catalog("a:free", "b:free")), onNew, storage: store })
  expect(first).toEqual([])
  expect(onNew).not.toHaveBeenCalled()
  // The baseline is persisted, not just held in a closure.
  expect(getCachedFreeModels(store).map((row) => row.id)).toEqual(["a:free", "b:free"])

  const second = await checkFreeModels({
    fetcher: () => Promise.resolve(catalog("a:free", "b:free", "c:free")),
    now: () => new Date(2099, 0, 2),
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

test("explicit valid zero prices qualify, but absent and coercible prices do not", () => {
  const data = [
    { id: "zero", name: "Zero", pricing: { prompt: "0.00", completion: 0 } },
    ...[undefined, null, "", false, "no", -1, "-0", "1"].map((price, index) => ({
      id: `invalid-${index}`, pricing: { prompt: price, completion: "0" }
    })),
    { id: "partial", pricing: { prompt: "0" } },
    { id: "extra-cost", pricing: { prompt: "0", completion: "0", request: "1" } }
  ]
  expect(parseFreeModelIds(JSON.stringify({ data }))).toEqual(["zero"])
})

test("same date and concurrent checks deduplicate; failures can retry", async () => {
  const storage = memoryStorage()
  const now = () => new Date(2026, 10, 12)
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(catalog("a:free"))
  await expect(checkFreeModels({ storage, now, fetcher })).rejects.toThrow("offline")
  await Promise.all([checkFreeModels({ storage, now, fetcher }), checkFreeModels({ storage, now, fetcher })])
  await checkFreeModels({ storage, now, fetcher })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

test("migrates known history, preserves metadata and pending until displayed, and never reflags reappearances", async () => {
  const storage = memoryStorage({ "alwith:free-model-watch/known": JSON.stringify(["a:free"]) })
  const onNew = vi.fn()
  const update = (day: number, ids: string[]) => checkFreeModels({
    storage, onNew, now: () => new Date(2026, 10, day),
    fetcher: async () => JSON.stringify({ data: ids.map((id) => ({ id, name: id, context_length: 8192 })) })
  })
  expect(await update(12, ["a:free", "b:free"])).toEqual(["b:free"])
  expect(getCachedFreeModels(storage)[1]).toMatchObject({ name: "b:free", context_length: 8192 })
  const listener = vi.fn()
  const stop = subscribeFreeModels(listener)
  acknowledgeFreeModels(["a:free"], storage)
  expect(getPendingNewFreeModelIds(storage)).toEqual(["b:free"])
  acknowledgeFreeModels(["b:free"], storage)
  expect(getPendingNewFreeModelIds(storage)).toEqual([])
  expect(listener).toHaveBeenCalledOnce()
  await update(13, ["a:free"])
  expect(await update(14, ["a:free", "b:free"])).toEqual([])
  stop()
})

test("startup fetch is independent of notification preference and scheduler has no timer", async () => {
  localStorage.clear()
  const { commands } = await import("@/bindings")
  const fetcher = vi.spyOn(commands, "fetchText").mockResolvedValue(catalog("a:free"))
  const timer = vi.spyOn(globalThis, "setTimeout")
  const stop = startFreeModelWatch()
  await vi.waitFor(() => expect(getCachedFreeModels()).toHaveLength(1))
  const timerCalls = timer.mock.calls.length
  window.dispatchEvent(new Event("focus"))
  await Promise.resolve()
  expect(fetcher).toHaveBeenCalledOnce()
  expect(timer.mock.calls.length).toBe(timerCalls)
  stop()
  localStorage.clear()
})

test("notification bodies preview three ids and summarize the rest", () => {
  expect(formatNewFreeModels(["a:free", "b:free"])).toBe("a:free、b:free")
  expect(formatNewFreeModels(["a:free", "b:free", "c:free", "d:free"])).toBe("a:free、b:free、c:free … +1")
})
