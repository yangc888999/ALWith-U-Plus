// QA 独立边界探针 —— v1.0.3 发布关卡。只新增测试代码，不改任何源码。
//
// 目标：核实统一出口 `resolveModelOptions` 在以下边界上仍满足「四处共用同一出口」的铁律：
//   首启 shortlist 未配置 / 用户明确全关（shortlistConfigured 区分）/ 已下架 tombstone /
//   企业模型与普通模型互切 / Effort 档位与加速口径一致性 / 四种引擎目录视角 signature 一致。
//
// 与 model-options.test.ts 的差异：这里不注入 savedOverrides，而是写真实的
// `alwith:native-model-overrides` localStorage 镜像，模拟 ①②④ 经 `useModelOptions()` 取数的
// 真实路径（③ 见 model-options-sentinel.qa.test.tsx）。

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { beforeEach, expect, test } from "vitest"

import type { CustomModel } from "@/bindings"

import {
  cleanModelLabel,
  isNativeGroupId,
  modelIconKind,
  type ModelOptionsSource,
  resolveModelOptions
} from "../model-options"
import type { ProviderSnapshot } from "../providers"

const ASTRA = "gpt-6-astra"
const SOL = "gpt-6.1-sol"
const TERRA = "gpt-6.1-terra"
const LUNA = "gpt-6-luna"
const FOUR = [ASTRA, SOL, TERRA, LUNA] as const
const OVERRIDES_KEY = "alwith:native-model-overrides"

function row(apiId: string, extra: Partial<CustomModel> = {}): CustomModel {
  return {
    api_id: apiId,
    label: apiId,
    enabled: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "medium",
    ...extra
  } as CustomModel
}

/** 设置窗口桥目录 / live session 的「推荐子集」，故意带自己的 effort 元数据。 */
const BRIDGE = {
  name: "ChatGPT",
  sourceKind: "session" as const,
  models: [
    { id: ASTRA, label: "Astra (engine)", efforts: ["minimal", "low"], defaultEffort: "low" },
    { id: SOL, label: "Sol (engine)", efforts: ["minimal", "low"], defaultEffort: "low" }
  ]
}

function sessionOptions(ids: readonly string[]): acp.SessionConfigOption[] {
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

/** 四处各自的引擎目录视角，故意不同：证明统一出口把引擎目录挡在裁决之外。 */
function fourSources(extra: Partial<ModelOptionsSource> = {}): ModelOptionsSource[] {
  const common: ModelOptionsSource = { providerSnapshot: null }
  return [
    { ...common, ...extra, native: BRIDGE, selectedId: SOL }, // ① 设置 → 默认会话模型（有桥目录）
    { ...common, ...extra, native: undefined, selectedId: TERRA }, // ② 分工默认模型
    { ...common, ...extra, sessionOptions: sessionOptions([ASTRA, SOL]), selectedId: LUNA }, // ③ live session
    { ...common, ...extra, selectedId: ASTRA } // ④ 拉会成员，无任何目录
  ]
}

function storeOverrides(rows: CustomModel[]): void {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(rows))
}

/** 一个带自定义供应商的快照，用来验证 GPT ↔ 普通/企业模型互切。 */
function gatewaySnapshot(): ProviderSnapshot {
  return {
    revision: 1,
    appliedRevision: 1,
    status: "applied",
    error: null,
    providers: { deepseek: { configured: true, disabled: false, region: null, base_url: null } },
    builtInModels: {},
    customProviders: [],
    managedProviders: []
  } as unknown as ProviderSnapshot
}

beforeEach(() => {
  localStorage.clear()
})

test("QA-B1 首启 shortlist 未配置：shortlistConfigured=false，引擎目录可作为初始清单", () => {
  const result = resolveModelOptions({ providerSnapshot: null, native: BRIDGE })
  expect(result.shortlistConfigured).toBe(false)
  expect(result.options.map((option) => option.id)).toEqual([ASTRA, SOL])
})

test("QA-B2 用户明确全关：shortlistConfigured=true，四处候选必须为空且一致，不得从引擎目录放回", () => {
  // 「供应商与可用模型」里 4 行全部 enabled:false = 用户明确把模型全关了。
  // model-options.ts 的契约原文：configured=true 时「空列表就是『全部禁用』，任何一处都不得
  // 改用引擎目录把模型放回来」；model-catalog.tsx 亦声明「哪怕全部禁用」也不能让会话推荐子集
  // 决定候选。这里同时给出桥目录（①）、live session（③）两种引擎目录视角。
  storeOverrides(FOUR.map((id) => row(id, { enabled: false })))

  const results = fourSources().map((source) => resolveModelOptions(source))
  for (const result of results) expect(result.shortlistConfigured).toBe(true)
  // ① 有桥目录、③ 有 live session 时，旧的 `hasShortlist` 闸门会把引擎目录的推荐子集放回；
  // ②④ 没有目录则为空。四处各列一份结果，便于一次性看到不一致。
  const idsBySurface = results.map((result) => result.options.map((option) => option.id))
  expect(idsBySurface).toEqual([[], [], [], []])
  expect(new Set(results.map((result) => result.signature)).size).toBe(1)
})

test("QA-B3 启用 4 个 GPT：四种引擎目录视角下 signature 逐字节一致", () => {
  storeOverrides(FOUR.map((id) => row(id)))
  const results = fourSources().map((source) => resolveModelOptions(source))
  expect(new Set(results.map((result) => result.signature)).size).toBe(1)
  for (const result of results) {
    expect(result.options.map((option) => option.id)).toEqual([...FOUR])
    expect(result.options.every((option) => option.available)).toBe(true)
    expect(result.options.every((option) => option.efforts.join(",") === "low,medium,high")).toBe(true)
  }
})

test("QA-B4 已下架 tombstone：只标 unavailable、不删行、不加任何提示，四处一致", () => {
  storeOverrides(FOUR.map((id) => row(id)))
  const results = fourSources({ tombstones: new Set<string>([TERRA]), fastModes: {} }).map((source) =>
    resolveModelOptions(source)
  )
  expect(new Set(results.map((result) => result.signature)).size).toBe(1)
  for (const result of results) {
    expect(result.options.map((option) => option.id)).toEqual([...FOUR])
    expect(result.byId(TERRA)?.available).toBe(false)
    expect(result.byId(ASTRA)?.available).toBe(true)
    expect(result.byId(TERRA)?.label).toBe(TERRA)
    expect(result.options.every((option) => !cleanModelLabel(option.label).includes("可能不可用"))).toBe(true)
  }
})

test("QA-B5 企业模型与普通模型互切：候选集稳定，图标/加速口径按 groupId 与 id 判定", () => {
  // ChatGPT / 企业 / 普通供应商三类图标与 GPT 家族判定，全部来自统一出口的纯函数。
  expect(modelIconKind("chatgpt", ASTRA)).toBe("chatgpt")
  expect(modelIconKind("finture-enterprise", "gateway:finture-enterprise:x")).toBe("enterprise")
  expect(modelIconKind("custom_alwith_enterprise_a", "gateway:custom_alwith_enterprise_a:x")).toBe("enterprise")
  expect(modelIconKind("deepseek", "gateway:deepseek:flash")).toBe("provider:deepseek")
  expect(isNativeGroupId("chatgpt", "gpt-7-nova")).toBe(true)
  expect(isNativeGroupId("finture-enterprise", "gateway:finture-enterprise:x")).toBe(false)

  const base: ModelOptionsSource = {
    providerSnapshot: gatewaySnapshot(),
    savedOverrides: FOUR.map((id) => row(id)),
    tombstones: new Set<string>(),
    fastModes: { [ASTRA]: true }
  }
  const result = resolveModelOptions(base)
  expect(result.groups.map((group) => group.id)).toEqual(["chatgpt", "deepseek"])
  const gatewayId = result.options.find((option) => !option.isNative)?.id
  expect(gatewayId).toBeDefined()
  expect(result.byId(gatewayId ?? "")?.fastCapable).toBe(false)
  expect(result.byId(gatewayId ?? "")?.fastMode).toBe(false)
  expect(result.byId(gatewayId ?? "")?.icon).toBe("provider:deepseek")
  expect(result.byId(ASTRA)?.fastCapable).toBe(true)
  expect(result.byId(ASTRA)?.fastMode).toBe(true)

  // 从 GPT 切到网关模型再切回：selectedId 只影响勾选态，绝不能改变候选集。
  const asGpt = resolveModelOptions({ ...base, selectedId: ASTRA })
  const asGateway = resolveModelOptions({ ...base, selectedId: gatewayId ?? "" })
  expect(asGpt.signature).toBe(asGateway.signature)
  expect(asGpt.byId(ASTRA)?.selected).toBe(true)
  expect(asGateway.byId(ASTRA)?.selected).toBe(false)
  expect(asGateway.byId(gatewayId ?? "")?.selected).toBe(true)
})

test("QA-B6 Effort 档位与加速口径四处一致，且不受引擎目录的 effort 元数据污染", () => {
  // shortlist 里一个模型自定义档位、一个模型没有档位；桥目录的 minimal/low 不得覆盖。
  const shortlist = [
    row(ASTRA, { reasoningLevels: ["low", "high"], defaultReasoningLevel: "high" }),
    row(SOL, { reasoningLevels: [], defaultReasoningLevel: null })
  ]
  storeOverrides(shortlist)
  const results = fourSources({ tombstones: new Set<string>(), fastModes: { [ASTRA]: true, [SOL]: true } }).map(
    (source) => resolveModelOptions(source)
  )
  expect(new Set(results.map((result) => result.signature)).size).toBe(1)
  for (const result of results) {
    expect(result.byId(ASTRA)?.efforts).toEqual(["low", "high"])
    expect(result.byId(ASTRA)?.defaultEffort).toBe("high")
    expect(result.byId(ASTRA)?.fastMode).toBe(true)
    expect(result.byId(SOL)?.efforts).toEqual([])
    expect(result.byId(SOL)?.effortSupported).toBe(false)
    expect(result.byId(SOL)?.fastMode).toBe(true)
    expect(result.effortFor(ASTRA)).toEqual(result.byId(ASTRA)?.efforts)
    expect(result.isFastCapable(ASTRA)).toBe(true)
  }
})
