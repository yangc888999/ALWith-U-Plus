// 四处模型选择器统一出口的单测契约。
//
// v1.0.2 的 bug：设置窗口拿到的是 live session 的 `chatgpt` 组（Codex 的「推荐模型集」预设，
// 通常只有 Astra / Sol），旧裁决器把它当权威并与「供应商与可用模型」的 enabled shortlist 求
// 交集，于是 Terra / Luna 在 ① 默认会话模型、② 分工默认模型、④ 拉会成员里消失，在
// ③ 聊天输入框里被标「可能不可用」。
//
// 这里把四处的**数据视角**（设置窗口有桥目录、主窗口有 live session、拉会窗口什么都没有）
// 分别喂给同一个 `resolveModelOptions`，断言 signature / groups / options 逐字节一致。

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { beforeEach, expect, test } from "vitest"

import type { CustomModel } from "@/bindings"

import {
  cleanModelLabel,
  isNativeGroupId,
  modelGroupLabel,
  modelIconKind,
  type ModelOptionsSource,
  modelTriggerLabel,
  resolveModelOptions
} from "../model-options"
import type { ProviderSnapshot } from "../providers"

const ASTRA = "gpt-6-astra"
const SOL = "gpt-6.1-sol"
const TERRA = "gpt-6.1-terra"
const LUNA = "gpt-6-luna"

const GPT_IDS: readonly string[] = [ASTRA, SOL, TERRA, LUNA]

function row(apiId: string, label: string, extra: Partial<CustomModel> = {}): CustomModel {
  return {
    api_id: apiId,
    label,
    enabled: true,
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "medium",
    ...extra
  } as CustomModel
}

const FOUR_GPT: CustomModel[] = [
  row(ASTRA, "6 Astra"),
  row(SOL, "6.1 Sol"),
  row(TERRA, "6.1 Terra"),
  row(LUNA, "6 Luna")
]

/** 会话 picker：只列 Astra / Sol，正是 v1.0.2 那个「推荐子集」。 */
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

/** 设置窗口桥目录（同样是推荐子集，且带自己的 effort 元数据）。 */
const bridgeCatalog = {
  name: "ChatGPT",
  sourceKind: "session" as const,
  models: [
    { id: ASTRA, label: "Astra (engine)", efforts: ["minimal", "low"], defaultEffort: "low" },
    { id: SOL, label: "Sol (engine)", efforts: ["minimal", "low"], defaultEffort: "low" }
  ]
}

/**
 * 四处选择器各自的数据视角。它们拿到的引擎目录**故意不同**，用来证明统一出口把引擎目录
 * 挡在裁决之外：只要 shortlist 存在，四处必得同一个结果。
 */
function fourSources(shortlist: CustomModel[]): ModelOptionsSource[] {
  const common = {
    providerSnapshot: null,
    savedOverrides: shortlist,
    tombstones: new Set<string>(),
    fastModes: {} as Record<string, boolean>
  }
  return [
    // ① 设置 → 默认会话模型（有桥目录）
    { ...common, native: bridgeCatalog, selectedId: SOL },
    // ② 设置 → 分工默认模型（同一个 hook，另一次渲染）
    { ...common, native: undefined, selectedId: TERRA },
    // ③ 对话输入框（主窗口持有 live session 的 configOptions）
    { ...common, sessionOptions: sessionOptions([ASTRA, SOL]), selectedId: LUNA },
    // ④ 拉会 → 成员「模型与推理」（既没有桥目录，也没有会话目录）
    { ...common, selectedId: ASTRA }
  ]
}

/** 一个带自定义供应商的快照，用来验证网关模型分组与非 GPT 家族的加速口径。 */
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

test("启用 4 个 GPT 模型 → 四处拿到完全相同的候选集", () => {
  const results = fourSources(FOUR_GPT).map((source) => resolveModelOptions(source))

  expect(new Set(results.map((result) => result.signature)).size).toBe(1)
  for (const result of results) {
    expect(result.options.map((option) => option.id)).toEqual([...GPT_IDS])
    expect(result.groups.map((group) => group.id)).toEqual(["chatgpt"])
    expect(result.groups[0].name).toBe("ChatGPT")
    expect(result.options.every((option) => option.available)).toBe(true)
    expect(result.options.every((option) => option.isNative)).toBe(true)
    expect(result.options.every((option) => option.icon === "chatgpt")).toBe(true)
    expect(result.options.every((option) => option.enabled)).toBe(true)
    // 勾选态是各自的状态，但不会改变候选集。
    expect(result.options.filter((option) => option.selected)).toHaveLength(1)
  }
})

test("会话 picker 只列 Astra / Sol 也裁不掉已启用的 Terra / Luna", () => {
  // 这是 v1.0.2 默认会话模型只有 2 个 GPT 的直接回归：四种引擎目录状态下都必须是 4 个。
  const sources: ModelOptionsSource[] = [
    { ...fourSources(FOUR_GPT)[3], sessionOptions: sessionOptions([ASTRA, SOL]) },
    { ...fourSources(FOUR_GPT)[3], native: bridgeCatalog },
    { ...fourSources(FOUR_GPT)[3], native: null },
    { ...fourSources(FOUR_GPT)[3], native: { name: "ChatGPT", models: [] } }
  ]
  for (const source of sources) {
    expect(resolveModelOptions(source).options.map((option) => option.id)).toEqual([...GPT_IDS])
  }
})

test("禁用 / 新增一个模型，四处同步变化，且新模型不需要任何静态白名单", () => {
  const before = fourSources(FOUR_GPT).map((source) => resolveModelOptions(source))
  expect(before[0].byId(LUNA)).not.toBeNull()

  // 禁用 Luna、新增一个从没在短名表 / 静态清单里出现过的模型。
  const changed = [
    ...FOUR_GPT.map((model) => (model.api_id === LUNA ? { ...model, enabled: false } : model)),
    row("gpt-7-nova", "7 Nova")
  ]
  const after = fourSources(changed).map((source) => resolveModelOptions(source))

  expect(new Set(after.map((result) => result.signature)).size).toBe(1)
  for (const result of after) {
    expect(result.options.map((option) => option.id)).toEqual([ASTRA, SOL, TERRA, "gpt-7-nova"])
    expect(result.byId(LUNA)).toBeNull()
    const nova = result.byId("gpt-7-nova")
    expect(nova?.label).toBe("7 Nova")
    expect(nova?.available).toBe(true)
    expect(nova?.isNative).toBe(true)
    expect(nova?.shortLabel).toBeNull()
  }
  expect(after[0].signature).not.toBe(before[0].signature)
})

test("Effort 档位 / defaultEffort / 加速能力四处完全一致，且来自 shortlist", () => {
  const results = fourSources(FOUR_GPT).map((source) => resolveModelOptions(source))
  for (const result of results) {
    for (const option of result.options) {
      expect(option.efforts).toEqual(["low", "medium", "high"])
      expect(option.defaultEffort).toBe("medium")
      expect(option.effortSupported).toBe(true)
      expect(option.fastCapable).toBe(true)
      expect(option.fastMode).toBe(false)
      expect(result.effortFor(option.id)).toEqual(option.efforts)
      expect(result.isFastCapable(option.id)).toBe(true)
      expect(result.fastModeFor(option.id)).toBe(false)
    }
    // 桥目录里那份不同的 effort 元数据绝不能覆盖 shortlist 的口径。
    expect(result.byId(ASTRA)?.efforts).toEqual(["low", "medium", "high"])
  }
})

test("加速开关与 GPT 家族判定按 groupId / id，而非静态 gpt- 白名单", () => {
  const withFast = resolveModelOptions({
    ...fourSources(FOUR_GPT)[3],
    fastModes: { [TERRA]: true }
  })
  expect(withFast.byId(TERRA)?.fastMode).toBe(true)
  expect(withFast.byId(SOL)?.fastMode).toBe(false)

  const gateway = resolveModelOptions({ providerSnapshot: gatewaySnapshot(), savedOverrides: FOUR_GPT })
  const deepseek = gateway.byId("gateway:deepseek:deepseek-flash")
  expect(deepseek).not.toBeNull()
  expect(deepseek?.isNative).toBe(false)
  expect(deepseek?.fastCapable).toBe(false)
  expect(deepseek?.fastMode).toBe(false)
  expect(gateway.groups.map((group) => group.id)).toEqual(["chatgpt", "deepseek"])
  expect(isNativeGroupId("chatgpt", "gpt-7-nova")).toBe(true)
  expect(isNativeGroupId("deepseek", "gateway:deepseek:flash")).toBe(false)
  expect(modelIconKind("chatgpt", ASTRA)).toBe("chatgpt")
  expect(modelIconKind("deepseek", "gateway:deepseek:flash")).toBe("provider:deepseek")
  expect(modelGroupLabel("chatgpt", "Anything")).toBe("ChatGPT")
})

test("运行时脏 label（星号别名 / 可能不可用 / 未验证）在统一出口被清洗", () => {
  const dirty: CustomModel[] = [
    row(ASTRA, "6 Astra*"),
    row(SOL, "6.1 Sol *"),
    row(TERRA, "6.1 Terra · 可能不可用"),
    row(LUNA, "6 Luna (未验证)")
  ]
  const results = fourSources(dirty).map((source) => resolveModelOptions(source))
  expect(new Set(results.map((result) => result.signature)).size).toBe(1)
  for (const result of results) {
    expect(result.options.map((option) => option.label)).toEqual(["6 Astra", "6.1 Sol", "6.1 Terra", "6 Luna"])
    const rendered = result.options.map((option) => `${option.label}|${option.shortLabel ?? ""}`).join(" ")
    expect(rendered).not.toContain("*")
    expect(rendered).not.toContain("可能不可用")
    expect(rendered).not.toContain("may be unavailable")
    expect(rendered).not.toContain("未验证")
    expect(rendered).not.toContain("unverified")
  }
  expect(cleanModelLabel("  6.1 Sol *  ")).toBe("6.1 Sol")
  expect(cleanModelLabel("Terra · may be unavailable")).toBe("Terra")
  expect(cleanModelLabel("Luna （未验证）")).toBe("Luna")
  expect(cleanModelLabel("**")).toBe("**")
})

test("tombstone 是唯一负证据：只标不可用，不删行、不加任何提示", () => {
  const result = resolveModelOptions({
    ...fourSources(FOUR_GPT)[3],
    tombstones: new Set<string>([TERRA])
  })
  expect(result.options.map((option) => option.id)).toEqual([...GPT_IDS])
  expect(result.byId(TERRA)?.available).toBe(false)
  expect(result.byId(TERRA)?.label).toBe("6.1 Terra")
  expect(result.byId(SOL)?.available).toBe(true)
})

test("模型短名与触发器名由统一出口给出，网关前缀只影响展示", () => {
  const result = fourSources(FOUR_GPT).map((source) => resolveModelOptions(source))[0]
  expect(modelTriggerLabel(result.byId(SOL)!)).toBe("6.1-Sol")
  expect(modelTriggerLabel({ label: "gateway:deepseek:deepseek-flash", shortLabel: null })).toBe("deepseek-flash")
  expect(modelTriggerLabel({ label: "6.1 Terra * ", shortLabel: null })).toBe("6.1 Terra")
})
