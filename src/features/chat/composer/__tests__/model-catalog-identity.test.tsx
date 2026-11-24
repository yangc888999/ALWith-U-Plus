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
  // The picker path filters the legacy litellm alias; the fixture drives the same groups through it.
  pickerProviderGroups: () => state.groups.filter((group) => group.id !== "litellm"),
  displayModelLabel: () => null
}))
const { presentModelCatalog } = await import("../model-catalog")
const { gatewayModelId } = await import("@/lib/providers")
const { setAntigravityModelPreference } = await import("@/features/antigravity/models")

test("hiding a Gemini row changes only the Google group", () => {
  const platform = vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel")
  const preferenceKey = "alwith:antigravity:model-preferences"
  try {
    const input = [
      { id: "chatgpt", name: "ChatGPT", models: [{ api_id: "gpt-6.1-terra", label: "Terra" }] },
      { id: "openrouter", name: "OpenRouter", models: [{ api_id: "gateway:openrouter:qa-model", label: "QA" }] },
      { id: "custom-qa", name: "Custom", models: [{ api_id: "gateway:custom-qa:qa-model", label: "Custom" }] }
    ]
    const groupId = "google-antigravity"
    const before = presentModelCatalog(input)
    setAntigravityModelPreference("gemini-4-neon", { enabled: false })
    const after = presentModelCatalog(input)
    expect(after.filter((group) => group.id !== groupId)).toEqual(before.filter((group) => group.id !== groupId))
    expect(after.find((group) => group.id === groupId)?.models.map((model) => model.api_id)).toEqual(
      before.find((group) => group.id === groupId)?.models.map((model) => model.api_id).filter((id) => !id.endsWith(":gemini-4-neon"))
    )
  } finally {
    localStorage.removeItem(preferenceKey)
    platform.mockRestore()
  }
})

const enterpriseId = "custom_alwith_enterprise_8e1b3c7a"
// Independent fixture for the adapter's custom-hex(public ID) session group identity.
const runtimeId = "custom-637573746f6d5f616c776974685f656e74657270726973655f3865316233633761"
const firstApiId = `gateway:${runtimeId}:DeepSeek-Flash`
const secondApiId = `gateway:${runtimeId}:DeepSeek-Pro`

test("Antigravity appears once on macOS and can be hidden without changing native models", () => {
  const platform = vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel")
  const group = { id: "google-antigravity", name: "Google Antigravity", models: [
    { api_id: "gateway:google-antigravity:gemini-4-neon", label: "Gemini 4 Neon" }
  ] }
  try {
    localStorage.removeItem("alwith:antigravity:enabled")
    const enabled = presentModelCatalog([group, group]).filter((entry) => entry.id === group.id)
    expect(enabled).toHaveLength(1)
    expect(enabled[0]?.models.map(({ api_id }) => api_id)).toContain(group.models[0]?.api_id)
    localStorage.setItem("alwith:antigravity:enabled", "false")
    expect(presentModelCatalog([group])).toEqual(presentModelCatalog([]))
  } finally {
    platform.mockRestore()
    localStorage.removeItem("alwith:antigravity:enabled")
  }
})

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

test("offers the Gemini group only while the Antigravity experiment is enabled", () => {
  const platform = vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel")
  try {
    localStorage.setItem("alwith:antigravity:enabled", "false")
    expect(presentModelCatalog([]).some((group) => group.id === "google-antigravity")).toBe(false)

    localStorage.setItem("alwith:antigravity:enabled", "true")
    const group = presentModelCatalog([]).find((entry) => entry.id === "google-antigravity")
    expect(group?.name).toBe("Google Antigravity")
    expect(group?.models.map((model) => model.api_id)).toEqual([
      "gateway:google-antigravity:gemini-4-argon",
      "gateway:google-antigravity:gemini-4-neon",
      "gateway:google-antigravity:gemini-4-hydrogen",
      "gateway:google-antigravity:gemini-3.8-flash"
    ])
  } finally {
    platform.mockRestore()
    localStorage.removeItem("alwith:antigravity:enabled")
  }
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
