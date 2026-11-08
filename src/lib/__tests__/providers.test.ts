import { expect, test } from "vitest"

import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  baseUrlLooksLikeEndpoint,
  defaultModelFallback,
  normalizeProviderBaseUrl,
  gatewayModelId,
  nativeCatalogStatus,
  mergeDiscoveredModels,
  parseCustomModels,
  providerGroups,
  PROVIDERS,
  type ProviderSnapshot,
  resolveSessionModel,
  retiredNativeRows,
  servedNativeRows
} from "../providers"

test("every built-in provider is offered, and a new chat starts on the bundled DeepSeek-Flash", () => {
  expect(PROVIDERS.map((provider) => provider.id)).toEqual([
    "openai",
    "deepseek",
    "openrouter",
    "qwen",
    "xai",
    "kimi",
    "zhipu",
    "minimax",
    "hakimi"
  ])
  // The default must be a first-party catalog entry, not a third-party relay that a fresh
  // install has no key for. Fetch by id: Hakimi used to be both last and the default target.
  expect(DEFAULT_PROVIDER_ID).toBe("deepseek")
  expect(DEFAULT_MODEL_ID).toBe("deepseek-flash")
  const deepseek = PROVIDERS.find((provider) => provider.id === DEFAULT_PROVIDER_ID)
  expect(deepseek?.baseUrl).toBe("https://api.deepseek.com/")
  expect(deepseek?.models.map((model) => model.id)).toEqual(["deepseek-flash"])
  const snapshot: ProviderSnapshot = {
    revision: 1,
    appliedRevision: 1,
    status: "applied",
    error: null,
    providers: { deepseek: { configured: true, disabled: false, region: null, base_url: null } },
    customProviders: [],
    builtInModels: {}, managedProviders: []
  }
  expect(resolveSessionModel(null, snapshot)).toBe(gatewayModelId(DEFAULT_PROVIDER_ID, DEFAULT_MODEL_ID))
})

test("Desktop defaults prefer configured providers and leave native defaults to the engine", () => {
  const snapshot: ProviderSnapshot = {
    revision: 1,
    appliedRevision: 1,
    status: "applied",
    error: null,
    providers: {},
    customProviders: [],
    builtInModels: {}, managedProviders: []
  }
  expect(resolveSessionModel(null, snapshot)).toBeNull()
  expect(resolveSessionModel("gateway:removed:model", snapshot)).toBeNull()
  snapshot.customProviders.push({
    id: "custom_private",
    name: "Private",
    baseUrl: "https://gateway.example.test/v1",
    models: [
      { api_id: "model-a", label: "A" },
      { api_id: "model-b", label: "B" }
    ]
  })
  expect(resolveSessionModel(null, snapshot)).toBe(gatewayModelId("custom_private", "model-a"))
  expect(resolveSessionModel("gateway:removed:model", snapshot)).toBe(gatewayModelId("custom_private", "model-a"))
  expect(resolveSessionModel(gatewayModelId("custom_private", "model-b"), snapshot)).toBe(
    gatewayModelId("custom_private", "model-b")
  )
  expect(resolveSessionModel("gpt-6-astra", snapshot)).toBe("gpt-6-astra")
})

test("custom model selections use adapter-compatible IDs without colliding with other saved providers", () => {
  expect(gatewayModelId("custom_a", "deepseek-flash")).toBe("gateway:custom-637573746f6d5f61:deepseek-flash")
  expect(gatewayModelId("custom_a-b", "model")).not.toBe(gatewayModelId("custom_a_b", "model"))
  expect(gatewayModelId("deepseek", "deepseek-flash")).toBe("gateway:deepseek:deepseek-flash")
})

test("Desktop-compatible custom model JSON is normalized for the adapter and model picker", () => {
  expect(
    parseCustomModels(
      '[{"label":" Model A ","api_id":" model-a ","contextWindow":128000,"description":"Fast","reasoningLevels":[" LOW ","high"],"defaultReasoningLevel":"HIGH"}]'
    )
  ).toEqual([
    {
      label: "Model A",
      api_id: "model-a",
      contextWindow: 128000,
      description: "Fast",
      reasoningLevels: ["low", "high"],
      defaultReasoningLevel: "high"
    }
  ])
  expect(() => parseCustomModels('[{"label":"A","api_id":"same"},{"label":"B","api_id":"same"}]')).toThrow(
    "Model IDs must be unique"
  )
})

test("custom model reasoning metadata rejects unknown, duplicate, and mismatched values", () => {
  expect(() => parseCustomModels('[{"label":"A","api_id":"a","reasoningLevels":["low","low"]}]')).toThrow(
    "Duplicate reasoning effort: low"
  )
  expect(() => parseCustomModels('[{"label":"A","api_id":"a","reasoningLevels":["impossible"]}]')).toThrow(
    "Unknown reasoning effort: impossible"
  )
  expect(() =>
    parseCustomModels('[{"label":"A","api_id":"a","reasoningLevels":["low","high"],"defaultReasoningLevel":"medium"}]')
  ).toThrow("defaultReasoningLevel must be one of reasoningLevels")
})

test("configured custom providers become independent model groups", () => {
  const snapshot: ProviderSnapshot = {
    revision: 1,
    appliedRevision: 1,
    status: "applied",
    error: null,
    providers: {},
    builtInModels: {}, managedProviders: [],
    customProviders: [
      {
        id: "custom_private",
        name: "Private gateway",
        baseUrl: "https://gateway.example.test/v1",
        models: [{ label: "Model A", api_id: "model-a" }]
      }
    ]
  }
  expect(providerGroups(snapshot)).toEqual([
    {
      id: "custom_private",
      name: "Private gateway",
      models: [{ id: "model-a", label: "Model A" }]
    }
  ])
})

test("a configured built-in surfaces in the model picker", () => {
  const snapshot: ProviderSnapshot = {
    revision: 1,
    appliedRevision: 1,
    status: "applied",
    error: null,
    providers: { deepseek: { configured: true, disabled: false, region: null, base_url: null } },
    customProviders: [],
    builtInModels: {}, managedProviders: []
  }
  expect(providerGroups(snapshot).map((group) => group.id)).toEqual(["deepseek"])
  // With a configured provider and nothing saved, the default lands on that provider's model.
  expect(resolveSessionModel(null, snapshot)).toBe("gateway:deepseek:deepseek-flash")
})

test("an unconfigured built-in never surfaces in the model picker", () => {
  const snapshot: ProviderSnapshot = {
    revision: 1,
    appliedRevision: 1,
    status: "applied",
    error: null,
    providers: {},
    customProviders: [],
    builtInModels: {}, managedProviders: []
  }
  expect(providerGroups(snapshot)).toEqual([])
  expect(resolveSessionModel(null, snapshot)).toBeNull()
})

test("discovered models fill empty metadata without overwriting existing edits", () => {
  const merged = mergeDiscoveredModels(
    [
      {
        label: "My Claude",
        api_id: "claude-opus-5-5",
        contextWindow: 200_000,
        reasoningLevels: ["low", "high"]
      },
      { label: "Local model", api_id: "local-model" }
    ],
    [
      {
        label: "Claude Opus 5.5",
        api_id: "claude-opus-5-5",
        contextWindow: 1_000_000,
        description: "Flagship Claude",
        reasoningLevels: ["low", "medium", "high", "max"],
        defaultReasoningLevel: "max"
      },
      {
        label: "Gemini 3.8 Flash",
        api_id: "gemini-3.8-flash",
        contextWindow: 1_000_000,
        reasoningLevels: ["low", "medium", "high"],
        defaultReasoningLevel: "medium"
      }
    ]
  )
  expect(merged).toEqual({
    added: 1,
    updated: 1,
    models: [
      {
        label: "My Claude",
        api_id: "claude-opus-5-5",
        contextWindow: 200_000,
        description: "Flagship Claude",
        reasoningLevels: ["low", "high"]
      },
      { label: "Local model", api_id: "local-model" },
      {
        label: "Gemini 3.8 Flash",
        api_id: "gemini-3.8-flash",
        contextWindow: 1_000_000,
        reasoningLevels: ["low", "medium", "high"],
        defaultReasoningLevel: "medium"
      }
    ]
  })
})

test("discovered effort metadata is added when a model has no effort yet", () => {
  const merged = mergeDiscoveredModels(
    [{ label: "Claude", api_id: "claude-opus-5-5" }],
    [
      {
        label: "Claude Opus 5.5",
        api_id: "claude-opus-5-5",
        reasoningLevels: ["low", "medium", "high", "max"],
        defaultReasoningLevel: "medium"
      }
    ]
  )
  expect(merged.updated).toBe(1)
  expect(merged.models[0]).toEqual({
    label: "Claude",
    api_id: "claude-opus-5-5",
    reasoningLevels: ["low", "medium", "high", "max"],
    defaultReasoningLevel: "medium"
  })
})

test("a configured default replaces the built-in fallback only while it still resolves", async () => {
  const store = await import("../default-model")
  const snapshot: ProviderSnapshot = {
    revision: 1,
    appliedRevision: 1,
    status: "applied",
    error: null,
    providers: {
      deepseek: { configured: true, disabled: false, region: null, base_url: null },
      hakimi: { configured: true, disabled: false, region: null, base_url: null }
    },
    customProviders: [],
    builtInModels: {}, managedProviders: []
  }
  const configured = gatewayModelId("hakimi", "claude-sonnet-5-5")

  // No default configured: the built-in fallback applies.
  expect(defaultModelFallback(snapshot)).toBeNull()
  expect(resolveSessionModel(null, snapshot)).toBe(gatewayModelId(DEFAULT_PROVIDER_ID, DEFAULT_MODEL_ID))

  // A gateway default of a configured provider wins.
  store.setDefaultModelChoice({ model: configured, effort: "high" })
  expect(defaultModelFallback(snapshot)).toBe(configured)

  // Its provider's key was removed: the stale default steps aside for the built-in fallback.
  snapshot.providers = {}
  expect(defaultModelFallback(snapshot)).toBeNull()

  // A native default passes through for the agent to validate.
  store.setDefaultModelChoice({ model: "gpt-6.1-sol", effort: null })
  expect(defaultModelFallback(snapshot)).toBe("gpt-6.1-sol")
  store.setDefaultModelChoice(null)
})

// ── 可用模型 vs 引擎目录：一处判定，三处渲染 ─────────────────────────────────────

const savedSol = { api_id: "gpt-6.1-sol", label: "", reasoningLevels: ["low", "high"] }
const savedTerra = { api_id: "gpt-6.1-terra", label: "Terra (mine)", enabled: true }

test("the shared resolver keeps the user's order and labels, and drops what the engine stopped serving", () => {
  const rows = servedNativeRows([savedSol, savedTerra], [
    { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "medium"], defaultEffort: "medium" }
  ], "ready")

  // One row out: the withdrawn one never reaches a picker.
  expect(rows.map((row) => row.id)).toEqual(["gpt-6.1-sol"])
  // A blank saved label falls back to the catalog; a saved effort ladder wins over the catalog's.
  expect(rows[0]).toMatchObject({
    label: "GPT-6.1-Sol",
    efforts: ["low", "high"],
    defaultEffort: "medium"
  })
})

test("the same rows come back the moment the catalog lists them again", () => {
  const rows = servedNativeRows([savedSol, savedTerra], [
    { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
    { id: "gpt-6.1-terra", label: "GPT-6.1-Terra" }
  ], "ready")

  expect(rows.map((row) => row.id)).toEqual(["gpt-6.1-sol", "gpt-6.1-terra"])
  // The user's own label is kept over the catalog's.
  expect(rows[1].label).toBe("Terra (mine)")
})

test("a surface with no catalog yet hides nothing", () => {
  // A draft before `session/new`, or the settings window before the main one publishes a list.
  expect(servedNativeRows([savedSol, savedTerra], [], "pending").map((row) => row.id)).toEqual([
    "gpt-6.1-sol",
    "gpt-6.1-terra"
  ])
})

test("no saved list means the catalog is the list", () => {
  const rows = servedNativeRows(null, [
    { id: "gpt-6-sol", label: "GPT-6-Sol", efforts: ["low"], defaultEffort: "low" }
  ], "ready")
  expect(rows).toEqual([{ id: "gpt-6-sol", label: "GPT-6-Sol", efforts: ["low"], defaultEffort: "low" }])
})

test("an engine that published no catalog does not resurrect withdrawn models", () => {
  // 2026-11-05: the engine's online list_models timed out 14 times. Treating that like a startup
  // gap put the withdrawn gpt-6.1-terra back into every picker all day.
  expect(nativeCatalogStatus(undefined)).toBe("pending")
  expect(nativeCatalogStatus(null)).toBe("unavailable")
  expect(nativeCatalogStatus([])).toBe("unavailable")
  expect(nativeCatalogStatus([{ id: "gpt-6.1-sol" }])).toBe("ready")

  expect(servedNativeRows([savedSol, savedTerra], [], "pending").map((row) => row.id)).toEqual([
    "gpt-6.1-sol",
    "gpt-6.1-terra"
  ])
  expect(servedNativeRows([savedSol, savedTerra], [], "unavailable")).toEqual([])
  // A real catalog always wins, whatever status the caller passed.
  expect(
    servedNativeRows([savedSol, savedTerra], [{ id: "gpt-6.1-sol" }], "unavailable").map((row) => row.id)
  ).toEqual(["gpt-6.1-sol"])
})

test("the withdrawn ids are reported separately, for the one table that still shows them", () => {
  const catalog = [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }]
  expect(retiredNativeRows([savedSol, savedTerra], catalog)).toEqual(["gpt-6.1-terra"])
  // An empty catalog proves nothing, so nothing is marked withdrawn.
  expect(retiredNativeRows([savedSol, savedTerra], [])).toEqual([])
})

test("a pasted endpoint is normalized back to the Responses API root", () => {
  // The OpenRouter quickstart's base URL is already correct and must survive untouched.
  expect(normalizeProviderBaseUrl("  https://openrouter.ai/api/v1  ")).toBe("https://openrouter.ai/api/v1")
  // This is the URL users paste from a curl example; saving it verbatim produced
  // `/chat/completions/responses` and a 404 on every turn.
  expect(baseUrlLooksLikeEndpoint("https://openrouter.ai/api/v1/chat/completions")).toBe(true)
  expect(normalizeProviderBaseUrl("https://openrouter.ai/api/v1/chat/completions")).toBe(
    "https://openrouter.ai/api/v1"
  )
  expect(normalizeProviderBaseUrl("https://openrouter.ai/api/v1/responses/")).toBe(
    "https://openrouter.ai/api/v1"
  )
  expect(normalizeProviderBaseUrl("https://api.deepseek.com/")).toBe("https://api.deepseek.com")
  expect(baseUrlLooksLikeEndpoint("https://api.deepseek.com/")).toBe(false)
  expect(normalizeProviderBaseUrl("")).toBe("")
})
