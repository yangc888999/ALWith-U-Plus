import { beforeEach, expect, test, vi } from "vitest"

const STORAGE_KEY = "alwith:session-orchestration"

beforeEach(() => localStorage.clear())

test("restores each session's planner and worker model/effort pair after a relaunch", async () => {
  let store = await import("../session-orchestration")
  store.setOrchestration("session-a", {
    planner: { model: "gpt-6-astra", effort: "high" },
    worker: { model: "gpt-6-sol", effort: "medium" }
  })
  store.setOrchestration("session-b", {
    planner: { model: "gpt-6-terra", effort: null },
    worker: { model: "gpt-6-luna", effort: "low" }
  })

  vi.resetModules()
  store = await import("../session-orchestration")

  expect(store.orchestrationFor("session-a")).toEqual({
    planner: { model: "gpt-6-astra", effort: "high" },
    worker: { model: "gpt-6-sol", effort: "medium" }
  })
  expect(store.orchestrationFor("session-b")).toEqual({
    planner: { model: "gpt-6-terra", effort: null },
    worker: { model: "gpt-6-luna", effort: "low" }
  })
})

test("does not revive malformed role entries or the old flat format", async () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      valid: {
        planner: { model: "gpt-6-astra", effort: "high" },
        worker: { model: "gpt-6-sol", effort: null }
      },
      missingEffort: {
        planner: { model: "gpt-6-astra" },
        worker: { model: "gpt-6-sol", effort: "low" }
      },
      flatLegacy: { planner: "gpt-6-astra", worker: "gpt-6-sol", plannerEffort: "high", workerEffort: "low" }
    })
  )

  vi.resetModules()
  const store = await import("../session-orchestration")

  expect(store.orchestrationFor("valid")).toEqual({
    planner: { model: "gpt-6-astra", effort: "high" },
    worker: { model: "gpt-6-sol", effort: null }
  })
  expect(store.orchestrationFor("missingEffort")).toBeNull()
  expect(store.orchestrationFor("flatLegacy")).toBeNull()
})
