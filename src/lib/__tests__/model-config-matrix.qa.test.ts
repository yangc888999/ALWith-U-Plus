// QA probe：v1.0.3 的四处选择器统一契约，覆盖 6 种引擎目录状态 × 有无 shortlist 的矩阵。
//
// v1.0.2 的根因是「把 live session picker（Codex 的『推荐模型集』预设，是推荐子集而非全量
// 目录）当权威」，用它和「供应商与可用模型」的 enabled shortlist 求交集，把 6.1 Terra / 6 Luna
// 从默认会话模型 / 分工默认模型 / 拉会成员里抹掉。v1.0.3 的契约：
//
//   * shortlist 非空 ⇒ 它就是完整候选集，任何引擎目录状态都不得裁掉一行；
//   * `unverifiedIds` / `withdrawnIds` 恒为空 —— 不在推荐子集里不代表不可调用；
//   * 唯一的负证据是 tombstone（provider 明确拒绝过），且它也只标「不可用」，不删行；
//   * shortlist 为空（首启）时引擎目录才作为初始清单；畸形桥载荷读作「没回答」，不是「全下架」。

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { beforeEach, expect, test } from "vitest"

import { type ModelConfigSource, resolveModelConfig } from "../model-config"
import { type CustomModel, gatewayModelId, type ProviderSnapshot } from "../providers"

const SOL = "gpt-6.1-sol"
const TERRA = "gpt-6.1-terra"

function saved(apiId: string, extra: Partial<CustomModel> = {}): CustomModel {
  return { api_id: apiId, label: "", enabled: true, ...extra } as CustomModel
}

function modelSelect(ids: string[]): acp.SessionConfigOption[] {
  return [
    {
      configId: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: ids[0] ?? "",
      options: [
        {
          groupId: "chatgpt",
          name: "ChatGPT",
          options: ids.map((id) => ({ value: id, name: id.toUpperCase() }))
        }
      ]
    } as unknown as acp.SessionConfigOption
  ]
}

function snapshot(): ProviderSnapshot {
  return {
    revision: 1,
    appliedRevision: 1,
    status: "applied",
    error: null,
    providers: {},
    builtInModels: {},
    customProviders: [{ id: "custom_vendor", name: "Vendor", models: [saved("vendor-large", { label: "Large" })] }],
    managedProviders: []
  } as unknown as ProviderSnapshot
}

/** 一个窗口可能持有的全部引擎目录状态。 */
const STATES: Array<{ name: string; config: Partial<ModelConfigSource> }> = [
  { name: "ready/session", config: { sessionOptions: modelSelect([SOL, "gpt-6-astra"]) } },
  {
    name: "ready/published-session",
    config: { native: { sourceKind: "session", name: "ChatGPT", models: [{ id: SOL, label: "Sol" }] } }
  },
  {
    name: "partial/bundled",
    config: { native: { sourceKind: "bundled", name: "ChatGPT", models: [{ id: SOL, label: "Sol" }] } }
  },
  { name: "pending", config: { native: undefined } },
  { name: "unavailable/null", config: { native: null } },
  { name: "unavailable/empty", config: { native: { name: "ChatGPT", models: [] } } }
]

beforeEach(() => {
  localStorage.clear()
})

test("the enabled shortlist survives every catalog state, with no unverified or withdrawn verdict", () => {
  for (const state of STATES) {
    const result = resolveModelConfig({
      providerSnapshot: null,
      savedOverrides: [saved(SOL), saved(TERRA, { label: "6.1 Terra" })],
      tombstones: new Set<string>(),
      ...state.config
    })
    const label = state.name

    // 这就是默认会话模型能选到全部 4 个 GPT 的根因保证。
    expect(
      result.entries.map((entry) => entry.id),
      label
    ).toEqual([SOL, TERRA])
    expect(result.byId(TERRA)?.label, label).toBe("6.1 Terra")
    expect(result.unverifiedIds, label).toEqual([])
    expect(result.withdrawnIds, label).toEqual([])
    expect(
      result.entries.some((entry) => entry.status === "withdrawn"),
      label
    ).toBe(false)
  }
})

test("no catalog state produces a verdict when there is no shortlist yet", () => {
  for (const state of STATES) {
    const result = resolveModelConfig({
      providerSnapshot: null,
      savedOverrides: [],
      tombstones: new Set<string>(),
      ...state.config
    })
    const label = state.name
    expect(result.unverifiedIds, label).toEqual([])
    expect(result.withdrawnIds, label).toEqual([])
    expect(
      result.entries.every((entry) => entry.status !== "withdrawn"),
      label
    ).toBe(true)
  }
})

test("a tombstone never becomes 已下架, in any state — and never hides a row", () => {
  for (const state of STATES) {
    const result = resolveModelConfig({
      providerSnapshot: null,
      savedOverrides: [saved(SOL), saved(TERRA)],
      tombstones: new Set<string>([TERRA]),
      ...state.config
    })
    const label = state.name

    expect(
      result.entries.map((entry) => entry.id),
      label
    ).toEqual([SOL, TERRA])
    expect(result.unverifiedIds, label).toEqual([])
    expect(result.withdrawnIds, label).toEqual([])
    for (const entry of result.entries) {
      if (entry.id === TERRA) expect(entry.retired, label).toBe(true)
      if (entry.id === SOL) expect(entry.retired, label).toBe(false)
    }
  }
})

test("a payload that crossed the bridge without a models array is 'answered nothing'", () => {
  // 桥上序列化后可能缺 `models`。旧实现会读成「所有模型都下架」并清空选择器；现在只是
  // 「引擎没回答」，已启用模型一行都不能少。
  const result = resolveModelConfig({
    providerSnapshot: null,
    native: { name: "ChatGPT" } as unknown as { name: string; models: [] },
    savedOverrides: [saved(SOL), saved(TERRA)],
    tombstones: new Set<string>()
  })
  expect(result.status).toBe("unavailable")
  expect(result.entries.map((entry) => entry.id)).toEqual([SOL, TERRA])
  expect(result.withdrawnIds).toEqual([])
  expect(result.unverifiedIds).toEqual([])
})

test("an unpublished catalog and an empty one are different answers", () => {
  const pending = resolveModelConfig({
    providerSnapshot: null,
    native: undefined,
    savedOverrides: [],
    tombstones: new Set()
  })
  const empty = resolveModelConfig({ providerSnapshot: null, native: null, savedOverrides: [], tombstones: new Set() })
  expect(pending.status).toBe("pending")
  expect(empty.status).toBe("unavailable")
  expect(pending.authoritative).toBe(false)
  expect(empty.authoritative).toBe(false)
})

test("gateway rows are this app's own list: they stay available and are never withdrawn", () => {
  const result = resolveModelConfig({
    providerSnapshot: snapshot(),
    native: { sourceKind: "bundled", name: "ChatGPT", models: [{ id: SOL, label: "Sol" }] },
    savedOverrides: [saved(SOL)],
    tombstones: new Set<string>()
  })
  const gateway = result.byId(gatewayModelId("custom_vendor", "vendor-large"))
  expect(gateway).not.toBeNull()
  expect(gateway?.status).toBe("available")
  expect(gateway?.sourceKind).toBe("session")
  expect(result.withdrawnIds).toEqual([])
  expect(result.unverifiedIds).toEqual([])
})
