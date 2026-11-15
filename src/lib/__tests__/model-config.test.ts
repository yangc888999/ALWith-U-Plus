// The one read-only answer every surface asks: which models does this app offer, and what may be
// said about them?
//
// v1.0.2 的 bug：把 live session picker（Codex 的「推荐模型集」预设，是推荐子集而非全量目录）
// 判为权威，与「供应商与可用模型」的 enabled shortlist 求交集，于是 6.1 Terra / 6 Luna 从
// 默认会话模型 / 分工默认模型 / 拉会成员里消失。v1.0.3 的契约只有一条：
//
//   * 只要 shortlist 非空，它就是**完整候选集**；任何引擎目录都不得裁掉一行；
//   * `unverifiedIds` / `withdrawnIds` 恒为空；只有 provider 明确拒绝（tombstone）才表达负证据；
//   * shortlist 为空（首启）时，引擎目录只作为初始清单。

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { beforeEach, expect, test } from "vitest"

import { resolveModelConfig, sessionModelEntries, sessionModelGroups } from "../model-config"
import { type CustomModel, gatewayModelId, type ProviderSnapshot } from "../providers"

const SOL = "gpt-6.1-sol"
const TERRA = "gpt-6.1-terra"
const ASTRA = "gpt-6-astra"

function saved(apiId: string, extra: Partial<CustomModel> = {}): CustomModel {
  return { api_id: apiId, label: "", enabled: true, ...extra } as CustomModel
}

function choice(value: string, name: string, efforts: string[] = [], defaultEffort = "") {
  return {
    value,
    name,
    _meta: { alwith: { supportedReasoningEfforts: efforts, defaultReasoningEffort: defaultEffort } }
  }
}

/** A live session's picker: the integrated group first, then whatever else the engine routes. */
function sessionOptions(
  models: Array<{ id: string; label?: string; efforts?: string[]; defaultEffort?: string }> = [],
  options: { withModelSelect?: boolean } = {}
): acp.SessionConfigOption[] {
  if (options.withModelSelect === false) return []
  return [
    {
      configId: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: models[0]?.id ?? "",
      options: [
        {
          groupId: "chatgpt",
          name: "ChatGPT",
          options: models.map((model) =>
            choice(model.id, model.label ?? model.id, model.efforts ?? [], model.defaultEffort ?? "")
          )
        }
      ]
    } as unknown as acp.SessionConfigOption
  ]
}

/** A session that published a model select but no integrated group at all. */
function gatewayOnlySession(): acp.SessionConfigOption[] {
  return [
    {
      configId: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: "deepseek/flash",
      options: [{ groupId: "deepseek", name: "DeepSeek", options: [choice("deepseek/flash", "Flash")] }]
    } as unknown as acp.SessionConfigOption
  ]
}

function catalog(ids: string[], sourceKind?: "session" | "bundled") {
  return {
    ...(sourceKind === undefined ? {} : { sourceKind }),
    name: "ChatGPT",
    models: ids.map((id) => ({ id, label: id.toUpperCase() }))
  }
}

function snapshotWith(customModels: CustomModel[]): ProviderSnapshot {
  return {
    revision: 1,
    appliedRevision: 1,
    status: "applied",
    error: null,
    providers: {},
    builtInModels: {},
    customProviders: [{ id: "custom_vendor", name: "Vendor", models: customModels }],
    managedProviders: []
  } as unknown as ProviderSnapshot
}

beforeEach(() => {
  localStorage.clear()
})

// ── ready (authoritative) ────────────────────────────────────────────────────

test("a live session's recommended subset never removes an enabled model", () => {
  const result = resolveModelConfig({
    providerSnapshot: null,
    // The engine's picker lists only Sol + Astra; Terra is enabled in 可用模型 but absent here.
    sessionOptions: sessionOptions([{ id: SOL }, { id: ASTRA }]),
    savedOverrides: [saved(SOL), saved(TERRA)],
    tombstones: new Set<string>()
  })

  expect(result.authoritative).toBe(true)
  expect(result.status).toBe("ready")
  // v1.0.3 根因修复：会话 picker 只是推荐子集，不能拿它裁掉已启用的 Terra。
  expect(result.entries.map((entry) => entry.id)).toEqual([SOL, TERRA])
  expect(result.entries[0]?.status).toBe("available")
  expect(result.entries[0]?.sourceKind).toBe("session")
  // 不再有「未验证 / 可能不可用」这类基于推荐子集的判断。
  expect(result.unverifiedIds).toEqual([])
  expect(result.withdrawnIds).toEqual([])
})

test("with no saved shortlist the authoritative catalog is the list", () => {
  const result = resolveModelConfig({
    providerSnapshot: null,
    sessionOptions: sessionOptions([{ id: SOL, label: "6.1 Sol", efforts: ["low"], defaultEffort: "low" }]),
    savedOverrides: [],
    tombstones: new Set<string>()
  })

  expect(result.authoritative).toBe(true)
  expect(result.withdrawnIds).toEqual([])
  expect(result.entries).toHaveLength(1)
  expect(result.byId(SOL)).toMatchObject({
    label: "6.1 Sol",
    efforts: ["low"],
    defaultEffort: "low",
    status: "available"
  })
})

test("a session without the integrated group keeps the enabled GPT rows too", () => {
  const result = resolveModelConfig({
    providerSnapshot: null,
    sessionOptions: gatewayOnlySession(),
    savedOverrides: [saved(SOL), saved(TERRA)],
    tombstones: new Set<string>()
  })

  expect(result.status).toBe("unavailable")
  expect(result.authoritative).toBe(false)
  expect(result.withdrawnIds).toEqual([])
  // 引擎这个会话没有发布 ChatGPT 组，只说明「它对 GPT 无话可说」，不能让 可用模型 里的行消失。
  expect(result.entries.some((entry) => entry.id === SOL)).toBe(true)
  expect(result.entries.some((entry) => entry.id === TERRA)).toBe(true)
  expect(result.entries.some((entry) => entry.id === "deepseek/flash")).toBe(true)
})

// ── partial (bundled fallback) ───────────────────────────────────────────────

test("a bundled catalog is partial: it hides nothing and withdraws nothing", () => {
  const result = resolveModelConfig({
    providerSnapshot: null,
    native: catalog([SOL], "bundled"),
    savedOverrides: [saved(SOL, { label: "Sol (mine)" }), saved(TERRA, { label: "Terra (mine)" })],
    tombstones: new Set<string>()
  })

  expect(result.status).toBe("partial")
  expect(result.authoritative).toBe(false)
  expect(result.entries.map((entry) => entry.id)).toEqual([SOL, TERRA])
  // The user's label still wins over the catalog's.
  expect(result.entries[0]?.label).toBe("Sol (mine)")
  // The bundled list is built into the app; a row missing from it was not withdrawn.
  expect(result.withdrawnIds).toEqual([])
  // Every verdict is withheld, including for the row the bundled list does carry.
  expect(result.entries.every((entry) => entry.status === "unknown")).toBe(true)
  expect(result.retiredIds).toEqual([])
})

test("a bundled catalog with no saved shortlist still reports the rows as unknown", () => {
  const result = resolveModelConfig({
    providerSnapshot: null,
    native: catalog([SOL, ASTRA], "bundled"),
    savedOverrides: [],
    tombstones: new Set<string>()
  })

  expect(result.status).toBe("partial")
  expect(result.entries.map((entry) => entry.id)).toEqual([SOL, ASTRA])
  expect(result.entries.every((entry) => entry.status === "unknown")).toBe(true)
  expect(result.withdrawnIds).toEqual([])
})

// ── pending ─────────────────────────────────────────────────────────────────

test("a catalog that has not arrived yet keeps the shortlist and claims nothing", () => {
  const result = resolveModelConfig({
    providerSnapshot: null,
    native: undefined,
    savedOverrides: [saved(SOL), saved(TERRA, { label: "Terra (mine)" })],
    tombstones: new Set<string>()
  })

  expect(result.status).toBe("pending")
  expect(result.authoritative).toBe(false)
  expect(result.entries.map((entry) => entry.id)).toEqual([SOL, TERRA])
  expect(result.entries[1]?.label).toBe("Terra (mine)")
  expect(result.entries.every((entry) => entry.status === "unknown")).toBe(true)
  expect(result.withdrawnIds).toEqual([])
})

test("a pending catalog with no saved shortlist offers nothing", () => {
  const result = resolveModelConfig({
    providerSnapshot: null,
    native: undefined,
    savedOverrides: [],
    tombstones: new Set<string>()
  })

  expect(result.status).toBe("pending")
  expect(result.entries).toEqual([])
  expect(result.withdrawnIds).toEqual([])
})

// ── unavailable ─────────────────────────────────────────────────────────────

test("an engine that answered nothing cannot hide the enabled shortlist", () => {
  for (const native of [null, catalog([])]) {
    const result = resolveModelConfig({
      providerSnapshot: null,
      native,
      savedOverrides: [saved(SOL), saved(TERRA)],
      tombstones: new Set<string>()
    })

    expect(result.status).toBe("unavailable")
    // list_models 超时 / 引擎没发布目录，不等于用户启用的模型下架了。
    expect(result.entries.map((entry) => entry.id)).toEqual([SOL, TERRA])
    expect(result.withdrawnIds).toEqual([])
  }
})

test("an empty catalog with no saved shortlist has nothing to say", () => {
  const result = resolveModelConfig({
    providerSnapshot: null,
    native: null,
    savedOverrides: [],
    tombstones: new Set<string>()
  })

  expect(result.status).toBe("unavailable")
  expect(result.entries).toEqual([])
  expect(result.authoritative).toBe(false)
  expect(result.withdrawnIds).toEqual([])
  expect(result.byId(SOL)).toBeNull()
  expect(result.effortFor(SOL)).toEqual([])
  expect(result.fastModeFor(SOL)).toBe(false)
  expect(result.contextWindowFor(SOL)).toBeNull()
})

// ── tombstones vs withdrawals ───────────────────────────────────────────────

test("a tombstone is a refusal, not a withdrawal — and never hides a row", () => {
  const result = resolveModelConfig({
    providerSnapshot: null,
    sessionOptions: sessionOptions([{ id: SOL }, { id: ASTRA }]),
    savedOverrides: [saved(SOL), saved(TERRA)],
    tombstones: new Set<string>([SOL])
  })

  // provider 明确拒绝过 Sol：它仍在候选集里，只是不可用（唯一的负证据）。
  expect(result.byId(SOL)?.status).toBe("unsupported")
  expect(result.byId(SOL)?.retired).toBe(true)
  expect(result.retiredIds).toEqual([SOL])
  // Terra 不在推荐子集里，但已启用，所以照样在候选集里，且没有任何「未验证」标记。
  expect(result.byId(TERRA)).not.toBeNull()
  expect(result.entries.map((entry) => entry.id)).toEqual([SOL, TERRA])
  expect(result.unverifiedIds).toEqual([])
  expect(result.withdrawnIds).toEqual([])
  expect(result.retiredIds).not.toContain(TERRA)
})

test("a tombstone alone never becomes a 已下架 verdict", () => {
  // Terra is tombstoned but the catalog still lists it.
  const result = resolveModelConfig({
    providerSnapshot: null,
    sessionOptions: sessionOptions([{ id: TERRA }]),
    savedOverrides: [saved(TERRA)],
    tombstones: new Set<string>([TERRA])
  })

  expect(result.withdrawnIds).toEqual([])
  expect(result.byId(TERRA)?.retired).toBe(true)
})

// ── gateway rows ────────────────────────────────────────────────────────────

test("gateway rows come from the provider snapshot, with the context window only a saved row carries", () => {
  const result = resolveModelConfig({
    providerSnapshot: snapshotWith([
      saved("vendor-large", { label: "Large", contextWindow: 128_000, reasoningLevels: ["low", "high"] }),
      saved("vendor-small", { label: "Small" })
    ]),
    native: catalog([SOL], "session"),
    savedOverrides: [saved(SOL)],
    tombstones: new Set<string>()
  })

  // A custom provider's runtime id is hex-encoded by the adapter; derive it the way the app does.
  const large = gatewayModelId("custom_vendor", "vendor-large")
  expect(result.contextWindowFor(large)).toBe(128_000)
  expect(result.effortFor(large)).toEqual(["low", "high"])
  // The engine's own catalog never carries a context window, so nothing is invented for it.
  expect(result.contextWindowFor(SOL)).toBeNull()
  expect(result.contextWindowFor(gatewayModelId("custom_vendor", "vendor-small"))).toBeNull()
})

// ── helpers the shims are built on ──────────────────────────────────────────

test("the session parser keeps the integrated group first and the effort ladder it published", () => {
  const groups = sessionModelGroups([
    {
      configId: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: "deepseek/flash",
      options: [
        { groupId: "deepseek", name: "DeepSeek", options: [choice("deepseek/flash", "Flash")] },
        {
          groupId: "chatgpt",
          name: "ChatGPT",
          options: [choice(SOL, "6.1 Sol", ["low", "medium"], "medium")]
        }
      ]
    } as unknown as acp.SessionConfigOption
  ])

  expect(groups.map((group) => group.id)).toEqual(["chatgpt", "deepseek"])
  const sol = groups[0]?.models[0]
  expect(sol).toMatchObject({ id: SOL, label: "6.1 Sol", efforts: ["low", "medium"], defaultEffort: "medium" })
})

test("a flat (ungrouped) model select is not mistaken for the integrated group", () => {
  // The adapter always publishes groups; a flat select would have no group identity, so it must
  // not be read as 「the engine published ChatGPT and nothing else」.
  const flat = [
    {
      configId: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: "a",
      options: [{ value: "a", name: "A" }]
    } as unknown as acp.SessionConfigOption
  ]

  expect(sessionModelGroups(flat)).toEqual([])
  expect(sessionModelEntries(flat)).toEqual([])
})

test("resolving a config is read-only: nothing is written back to storage", () => {
  resolveModelConfig({
    providerSnapshot: null,
    native: catalog([SOL], "bundled"),
    savedOverrides: [saved(SOL), saved(TERRA)],
    tombstones: new Set<string>()
  })

  expect(localStorage.length).toBe(0)
})
