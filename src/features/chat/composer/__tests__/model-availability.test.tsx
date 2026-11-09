import { expect, test, vi } from "vitest"

import type { CustomModel, ProviderSnapshot } from "@/lib/providers"

/**
 * Which saved rows the surfaces start from. `presentModelCatalog` reads this the way the real app
 * does — from 可用模型 — while the test keeps it under its own control.
 */
const saved = vi.hoisted(() => ({ rows: null as CustomModel[] | null }))
vi.mock("@/lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers")>()
  return { ...actual, nativeModelOverrides: () => saved.rows }
})

const { setProviderSnapshot } = await import("@/lib/providers")
const { presentModelCatalog, modelTriggerLabel } = await import("../model-catalog")

function row(apiId: string): CustomModel {
  return { api_id: apiId, label: "" } as CustomModel
}

/** The integrated group as a session hands it over: the engine's own view of what it serves. */
function catalog(ids: string[]): Parameters<typeof presentModelCatalog>[0] {
  return [
    {
      id: "chatgpt",
      name: "ChatGPT",
      models: ids.map((id) => ({ api_id: id, label: id.toUpperCase() })),
    },
  ]
}

function ids(groups: ReturnType<typeof presentModelCatalog>): string[] {
  return groups[0].models.map((model) => model.api_id)
}

test("a saved model the engine no longer serves is not offered at all", () => {
  saved.rows = [row("gpt-6-astra"), row("gpt-6.1-terra")]

  const groups = presentModelCatalog(catalog(["gpt-6-astra"]))

  // Hiding, not greying: nothing in the menu asks the engine again, so a row that cannot run has
  // no reason to be there. The saved row itself is untouched and returns with the next catalog.
  expect(ids(groups)).toEqual(["gpt-6-astra"])
})

test("a model the engine lists again comes back with no other change", () => {
  saved.rows = [row("gpt-6-astra"), row("gpt-6.1-terra")]

  const groups = presentModelCatalog(catalog(["gpt-6-astra", "gpt-6.1-terra"]))

  expect(ids(groups)).toEqual(["gpt-6-astra", "gpt-6.1-terra"])
})

test("a draft whose catalog has not arrived yet hides nothing", () => {
  saved.rows = [row("gpt-6-astra"), row("gpt-6.1-terra")]

  // Before `session/new` the group holds a single nameless placeholder. Reading that as an empty
  // catalog would hide every saved row until the first conversation opens.
  const groups = presentModelCatalog([
    { id: "chatgpt", name: "ChatGPT", models: [{ api_id: "", label: "ChatGPT" }] },
  ])

  expect(ids(groups)).toEqual(["gpt-6-astra", "gpt-6.1-terra"])
})

test("a renamed gateway model replaces the thread's stale catalogue label everywhere", () => {
  saved.rows = null
  // An already-open conversation still carries the label its thread was created with. The saved
  // override is the only place the new name lives, so both the menu row and the trigger must read
  // from it instead of from the thread catalogue or the bundled compact alias.
  setProviderSnapshot({
    revision: 9999,
    appliedRevision: 9999,
    status: "applied",
    error: null,
    providers: { deepseek: { configured: true, disabled: false, region: null, base_url: null } },
    customProviders: [],
    builtInModels: { deepseek: [{ api_id: "deepseek-flash", label: "闪电速答" }] },
    managedProviders: []
  } as unknown as ProviderSnapshot)

  const groups = presentModelCatalog([
    {
      id: "deepseek",
      name: "DeepSeek",
      models: [{ api_id: "gateway:deepseek:deepseek-flash", label: "DeepSeek-Flash" }],
    },
  ])
  const renamed = groups.find((group) => group.id === "deepseek")?.models[0]
  expect(renamed?.label).toBe("闪电速答")
  expect(renamed?.shortLabel).toBe("闪电速答")
  expect(modelTriggerLabel(renamed!)).toBe("闪电速答")
})
