import { beforeEach, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  snapshot: null as unknown,
  groups: [] as Array<{ id: string; name: string; models: Array<{ id: string; label: string }> }>
}))
beforeEach(() => {
  state.snapshot = null
  state.groups = [
    { id: "litellm", name: "Renamed account", models: [{ id: "DS4.1", label: "Different label" }] },
    { id: "finture-enterprise", name: "Enterprise", models: [{ id: "internal", label: "Internal" }] }
  ]
})
vi.mock("@/lib/providers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/providers")>(),
  getProviderSnapshot: () => state.snapshot,
  providerGroups: () => state.groups,
  displayModelLabel: () => null
}))
const { presentModelCatalog } = await import("../model-catalog")
const { gatewayModelId } = await import("@/lib/providers")

const enterpriseId = "custom_alwith_enterprise_8e1b3c7a"
// Independent fixture for the adapter's custom-hex(public ID) session group identity.
const runtimeId = "custom-637573746f6d5f616c776974685f656e74657270726973655f3865316233633761"
const firstApiId = `gateway:${runtimeId}:DeepSeek-Flash`
const secondApiId = `gateway:${runtimeId}:DeepSeek-Pro`

function enterpriseSnapshot() {
  state.snapshot = {}
  state.groups = [{
    id: enterpriseId,
    name: "Enterprise",
    models: [
      { id: "DeepSeek-Flash", label: "Flash renamed" },
      { id: "DeepSeek-Pro", label: "Pro renamed" }
    ]
  }]
}

test("filters LiteLLM identity after snapshot augmentation, not matching labels or model names", () => {
  state.snapshot = {}
  const groups = presentModelCatalog([
    { id: "litellm", name: "Enterprise-looking name", models: [{ api_id: "DS4.1", label: "Internal" }] },
    { id: "legacy", name: "Old session", models: [
      { api_id: "gateway:litellm:DS4.1", label: "Stale account" },
      { api_id: "gateway:other:DS4.1", label: "LITELLM DS4.1" }
    ] },
    { id: "finture-enterprise", name: "Enterprise", models: [{ api_id: "gateway:finture-enterprise:internal", label: "Internal" }] }
  ])
  expect(groups.some((group) => group.id === "litellm")).toBe(false)
  expect(groups.flatMap((group) => group.models).some((model) => model.api_id.startsWith("gateway:litellm:"))).toBe(false)
  expect(groups.find((group) => group.id === "legacy")?.models.map((model) => model.api_id)).toEqual(["gateway:other:DS4.1"])
  expect(groups.find((group) => group.id === "finture-enterprise")?.models.map((model) => model.api_id)).toEqual(["gateway:finture-enterprise:internal"])
})

test.each([runtimeId, enterpriseId])("merges enterprise snapshot into existing %s group without changing its ID", (id) => {
  enterpriseSnapshot()
  expect(gatewayModelId(enterpriseId, "DeepSeek-Flash")).toBe(firstApiId)
  const input = [{ id, name: "Enterprise", models: [
    { api_id: firstApiId, label: "Stale Flash", shortLabel: "Compact Flash" }
  ] }]
  const result = presentModelCatalog(input)
  expect(result.map((group) => group.id)).toEqual([id])
  expect(result[0].models.map(({ api_id, label }) => ({ api_id, label }))).toEqual([
    { api_id: firstApiId, label: "Flash renamed" },
    { api_id: secondApiId, label: "Pro renamed" }
  ])
  expect(result[0].models[0].shortLabel).toBe("Compact Flash")
  expect(input[0].models).toEqual([
    { api_id: firstApiId, label: "Stale Flash", shortLabel: "Compact Flash" }
  ])
})

test.each([[runtimeId, enterpriseId], [enterpriseId, runtimeId]])(
  "coalesces both enterprise aliases, preserving first group %s before %s",
  (firstId, secondId) => {
    enterpriseSnapshot()
    const input = [
      { id: firstId, name: "Enterprise", models: [
        { api_id: firstApiId, label: "Stale first", shortLabel: "First metadata" }
      ] },
      { id: "unrelated", name: "Enterprise", models: [{ api_id: "gateway:unrelated:DeepSeek-Flash", label: "Unrelated" }] },
      { id: secondId, name: "Enterprise", models: [
        { api_id: firstApiId, label: "Stale duplicate", shortLabel: "Second metadata" },
        { api_id: secondApiId, label: "Stale Pro", shortLabel: "Pro metadata" },
        { api_id: `gateway:${runtimeId}:session-only`, label: "Session only", shortLabel: "Keep me" }
      ] }
    ]
    const result = presentModelCatalog(input)
    expect(result.map((group) => group.id)).toEqual([firstId, "unrelated"])
    expect(result[0].models.map(({ api_id, label, shortLabel }) => ({ api_id, label, shortLabel }))).toEqual([
      { api_id: firstApiId, label: "Flash renamed", shortLabel: "First metadata" },
      { api_id: secondApiId, label: "Pro renamed", shortLabel: "Pro metadata" },
      { api_id: `gateway:${runtimeId}:session-only`, label: "Session only", shortLabel: "Keep me" }
    ])
    expect(input.map((group) => group.models.length)).toEqual([1, 1, 3])
    expect(input[0].models[0].label).toBe("Stale first")
    expect(input[2].models[1].label).toBe("Stale Pro")
  }
)

test("different provider IDs with the same name and model name stay separate", () => {
  enterpriseSnapshot()
  const otherId = "custom_alwith_enterprise_other"
  const otherApiId = gatewayModelId(otherId, "DeepSeek-Flash")
  state.groups.push({ id: otherId, name: "Enterprise", models: [{ id: "DeepSeek-Flash", label: "Other Flash" }] })
  const result = presentModelCatalog([
    { id: runtimeId, name: "Enterprise", models: [{ api_id: firstApiId, label: "Stale Flash" }] },
    { id: otherId, name: "Enterprise", models: [{ api_id: otherApiId, label: "Stale other" }] }
  ])
  expect(result.map((group) => group.id)).toEqual([runtimeId, otherId])
  expect(result[0].models.map((model) => model.api_id)).toEqual([firstApiId, secondApiId])
  expect(result[1].models.map(({ api_id, label }) => ({ api_id, label }))).toEqual([
    { api_id: otherApiId, label: "Other Flash" }
  ])
})

test("openrouter session rows the snapshot no longer offers are pruned, enabled ones keep metadata", () => {
  state.snapshot = {}
  state.groups = [{ id: "openrouter", name: "OpenRouter", models: [{ id: "vendor/kept:free", label: "Kept" }] }]
  const kept = gatewayModelId("openrouter", "vendor/kept:free")
  const disabled = gatewayModelId("openrouter", "vendor/disabled:free")
  const result = presentModelCatalog([{ id: "openrouter", name: "OpenRouter", models: [
    { api_id: kept, label: "Stale label", shortLabel: "Compact" },
    { api_id: disabled, label: "Disabled model" }
  ] }])
  expect(result[0].models.map(({ api_id, label, shortLabel }) => ({ api_id, label, shortLabel }))).toEqual([
    { api_id: kept, label: "Kept", shortLabel: "Compact" }
  ])
})

test("an empty openrouter snapshot prunes every openrouter session row", () => {
  state.snapshot = {}
  state.groups = [{ id: "openrouter", name: "OpenRouter", models: [] }]
  const result = presentModelCatalog([{ id: "openrouter", name: "OpenRouter", models: [
    { api_id: gatewayModelId("openrouter", "vendor/a:free"), label: "A" }
  ] }])
  expect(result.find((group) => group.id === "openrouter")?.models ?? []).toEqual([])
})

test("stale session identity remains filtered without a provider snapshot", () => {
  state.snapshot = null
  const input = [{ id: "other", name: "Other", models: [
    { api_id: "gateway:litellm:renamed", label: "Anything" },
    { api_id: "gateway:other:DS4.1", label: "Internal" }
  ] }]
  const result = presentModelCatalog(input)
  expect(result[0].models.map((model) => model.api_id)).toEqual(["gateway:other:DS4.1"])
  expect(input[0].models).toHaveLength(2)
})
