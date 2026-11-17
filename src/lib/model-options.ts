/**
 * ============================================================================
 * 🚫 唯一模型出口 —— 请勿绕过（给后续 AI 的硬性约定）
 * ----------------------------------------------------------------------------
 * ① 默认会话模型、② 分工默认模型（规划/执行）、③ 对话输入框模型下拉、④ 拉会成员模型，
 * 这四处**必须**调用本文件的 `resolveModelOptions()`（设置窗口可用 `useModelOptions()` 薄封装）。
 * 不允许任何 UI 再自建候选清单、白名单、别名表、星号后缀、「可能不可用」判断或私有分组名。
 * 新增/启用/改名一个模型，只在「供应商与可用模型」维护一次，四处自动同步。
 * 改动本文件前先读下面的历史根因（v1.0.2）：四处各取一套数据导致的消失与误标就是这么来的。
 * ============================================================================
 */
/**
 * 四处模型选择器的唯一出口（single source of truth）。
 *
 * 消费方（全部调用 `resolveModelOptions`，或设置窗口的 `useModelOptions()` 薄封装）：
 *   ① 设置 → 默认会话模型            `model-section.tsx`
 *   ② 设置 → 分工默认模型（规划/执行）`model-section.tsx` → `RoleDefaultsRow`
 *   ③ 对话输入框模型下拉             `chat/composer/model-catalog.tsx`
 *   ④ 拉会 → 成员「模型与推理」       `group-section.tsx` → `RoleEditor`
 *
 * 为什么需要它（v1.0.2 的根因）：四处各自取数 ——
 *   * ①②④ 用 `useSettingsNativeModels()`（主窗口发布的 live session `chatgpt` 组）+ 自建分组；
 *   * ③ 用会话 configOptions + `trimNativeGroup` 私有裁剪 + `unverified` 私有判断；
 * 主窗口 `app.tsx` 在有 live session 时发布的是该会话的 `chatgpt` 组，而那是 Codex 的
 * 「推荐模型集」预设（推荐子集，只有 Astra/Sol），不是全量目录。旧裁决器把该子集判为
 * authoritative 并与「供应商与可用模型」维护的 enabled shortlist 求交集，于是 6.1 Terra /
 * 6 Luna 在 ①②④ 里消失、在 ③ 里被标「可能不可用」；④ 还把运行时脏 label（`6.1 Sol *`）
 * 原样渲染成扁平列表。
 *
 * 修复口径（参考上游 `origin/main:src/agent/client.ts` 的 GPT 识别方式）：
 *   * 候选集的**唯一权威**是「供应商与可用模型」里用户维护的 enabled shortlist
 *     （`providerBuiltInModels(snapshot, "openai")`，其 localStorage 镜像是 `nativeModelOverrides()`）
 *     加上 `pickerProviderGroups(snapshot)` 的各供应商模型（含企业内部模型）。
 *   * 引擎目录（session / bundled / published）只用于**补充能力元数据**（effort 档位、
 *     defaultEffort、contextWindow），绝不用于裁剪候选集或判定「可用性」；且只要 shortlist
 *     非空就完全不参与裁决，保证四个窗口拿到的结果逐字节一致。
 *   * GPT 家族按 `groupId === NATIVE_MODEL_GROUP.id`（"chatgpt"）或 `!id.startsWith("gateway:")`
 *     判定，不做静态 `gpt-` 白名单；加速能力属 GPT 家族，Effort 来自 shortlist。
 *   * 名称、分组、图标、排序、可用性、勾选态全部在此标准化；任何一处 UI 不再自建清单、
 *     白名单、别名、星号后缀或「可能不可用」提示。新增/启用一个模型只需在「供应商与可用
 *     模型」维护一次，四处自动同步。
 *
 * 纯函数优先：`savedOverrides` / `tombstones` / `fastModes` 均可注入以便单测；不注入时才读
 * 本地存储。`resolveModelConfig` 是底层只读裁决器（根因修复后 shortlist 即全量），本模块在
 * 其上补齐展示契约，避免重复实现候选集规则。
 */

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"

import { NATIVE_MODEL_GROUP } from "@/agent/native-models"
import type { CustomModel } from "@/bindings"
import { ENTERPRISE_PROVIDER_PREFIX, isEnterpriseModel } from "@/features/auth/enterprise-providers"
import { companyModelLabel } from "@/lib/company-display-name"
import {
  type ModelCatalogStatus,
  type ModelConfigEntry,
  type NativeCatalog,
  resolveModelConfig
} from "@/lib/model-config"
import { modelFastModeFor } from "@/lib/model-fast-mode"
import {
  displayModelLabel,
  isAccountModel,
  nativeModelOverrides,
  providerBuiltInModels,
  type ProviderSnapshot
} from "@/lib/providers"

import presentation from "./model-presentation.json"

/** 引擎目录视图（设置窗口桥 / 会话目录共用）：只用于补能力元数据或首启清单。 */
export type ModelOptionsNative = NativeCatalog

/** 统一出口的入参。四处传同一份 source 就得到完全相同的候选集。 */
export interface ModelOptionsSource {
  providerSnapshot: ProviderSnapshot | null
  /** 引擎目录（可选）：shortlist 非空时不参与裁决；仅在首启用作初始清单。 */
  native?: ModelOptionsNative | null
  /** 会话 configOptions（可选）：同上。 */
  sessionOptions?: readonly acp.SessionConfigOption[] | null
  /** 覆盖「供应商与可用模型」shortlist（单测注入）。 */
  savedOverrides?: CustomModel[] | null
  /** 覆盖 tombstone 集合（单测注入）。 */
  tombstones?: ReadonlySet<string>
  /** 覆盖 fast mode 快照（单测注入）。 */
  fastModes?: Readonly<Record<string, boolean>>
  /** 当前选中模型 id，产出勾选态。 */
  selectedId?: string | null
}

/** 图标类别：由共用 `ModelOptionIcon` 统一渲染，四处一致。 */
export type ModelIconKind = "chatgpt" | "enterprise" | "account" | `provider:${string}`

/** 一个标准化候选模型。 */
export interface ModelOption {
  /** 模型 ID（接口调用名）：GPT 原生 slug，网关为 `gateway:<provider>:<model>`。 */
  id: string
  /** 统一显示名（已清洗星号别名 / 「可能不可用」提示）。 */
  label: string
  /** 触发器紧凑名（可选，来自统一 presentation 表，已清洗）。 */
  shortLabel: string | null
  groupId: string
  groupName: string
  /** 「供应商与可用模型」里的启用开关。进入出口的都已是 enabled 行。 */
  enabled: boolean
  /** 可选项：只排除 provider 明确拒绝过的 tombstone（正证据），无「可能不可用」猜测。 */
  available: boolean
  /** Effort 档位。 */
  efforts: readonly string[]
  defaultEffort: string | null
  /** 是否支持 Effort 选择。 */
  effortSupported: boolean
  /** GPT 家族才支持加速（上游口径）。 */
  fastCapable: boolean
  fastMode: boolean
  contextWindow: number | null
  icon: ModelIconKind
  /** 稳定排序序号。 */
  order: number
  selected: boolean
  /** 是否 GPT 家族（按 groupId / id 判定，非静态白名单）。 */
  isNative: boolean
}

/** 供应商分组。 */
export interface ModelOptionGroup {
  id: string
  name: string
  icon: ModelIconKind
  order: number
  options: ModelOption[]
}

/** 统一出口的结果。 */
export interface ModelOptionsResult {
  status: ModelCatalogStatus
  /**
   * 「供应商与可用模型」是否已建立（哪怕当前一行都没有）。
   * `false` = 首启，调用方可用引擎目录做初始清单；`true` 时用户已明确维护过，
   * 空列表就是「全部禁用」，任何一处都不得改用引擎目录把模型放回来。
   */
  shortlistConfigured: boolean
  groups: readonly ModelOptionGroup[]
  options: readonly ModelOption[]
  byId(id: string): ModelOption | null
  effortFor(id: string): readonly string[]
  fastModeFor(id: string): boolean
  isFastCapable(id: string): boolean
  /** 稳定序列化，供单测断言「四处拿到完全相同的候选集」。 */
  signature: string
}

/**
 * 唯一的紧凑短名表。它只影响触发器上的文案，**从不参与候选集裁决**：表里查不到的模型
 * （例如用户新启用的 6.1 Terra）直接显示完整显示名。四处不再各带一份别名表。
 */
const presentationTable: Record<string, { shortLabel?: string } | undefined> = (() => {
  const table: Record<string, { shortLabel?: string }> = {}
  for (const [key, value] of Object.entries(presentation)) {
    table[key] = value
    // 设置里存的是裸 id（`deepseek-flash`），而短名表按 `gateway:<provider>:<id>` 登记。
    // 只查全键会让裸 id 落回服务端给的短名（用户看到的是「Flash」这种没头没尾的词），
    // 所以同时登记去掉网关前缀的裸 id；全键优先，冲突时以显式全键为准。
    const bare = /^gateway:[^:]+:(.+)$/.exec(key)?.[1]
    if (bare !== undefined && table[bare] === undefined) table[bare] = value
  }
  return table
})()

/** 尾部脏别名：星号后缀、`· 可能不可用` / `may be unavailable`、`（未验证）`。 */
const DIRTY_LABEL_PATTERNS: readonly RegExp[] = [
  /\s*[·•・]\s*(?:可能不可用|may be unavailable)\s*$/i,
  /\s*[（(]\s*(?:未验证|unverified)\s*[)）]\s*$/i,
  /\s*[＊*]+\s*$/
]

/**
 * 清洗一处显示名：去掉历史脏数据里的星号别名与「可能不可用」提示。
 * 只作用于展示，不改写持久化数据；名字被清空时保留原串，避免空白选项。
 */
export function cleanModelLabel(raw: string): string {
  let label = raw.trim()
  for (const pattern of DIRTY_LABEL_PATTERNS) label = label.replace(pattern, "").trim()
  return label.length > 0 ? label : raw.trim()
}

/** 上游口径：GPT 家族按 groupId 或 id 判定，不用静态 `gpt-` 白名单。 */
export function isNativeGroupId(groupId: string, id: string): boolean {
  return groupId === NATIVE_MODEL_GROUP.id || !id.startsWith("gateway:")
}

function isEnterpriseGroupId(groupId: string): boolean {
  return groupId === "finture-enterprise" || groupId.startsWith(ENTERPRISE_PROVIDER_PREFIX)
}

/** 图标类别：四处共用同一判定，避免各自认供应商。 */
export function modelIconKind(groupId: string, id: string): ModelIconKind {
  if (groupId === NATIVE_MODEL_GROUP.id) return "chatgpt"
  if (isEnterpriseGroupId(groupId) || isEnterpriseModel(id)) return "enterprise"
  if (groupId === "litellm" || isAccountModel(id)) return "account"
  return `provider:${groupId}`
}

/** 分组显示名：ChatGPT 统一为「ChatGPT」，企业组统一用改名，其余保持供应商名。 */
export function modelGroupLabel(groupId: string, fallback: string): string {
  if (groupId === NATIVE_MODEL_GROUP.id) return NATIVE_MODEL_GROUP.name
  if (isEnterpriseGroupId(groupId)) return companyModelLabel(fallback)
  return fallback
}

/** 「供应商与可用模型」的 enabled shortlist 是唯一候选权威。 */
function pickShortlist(source: ModelOptionsSource): CustomModel[] {
  // undefined = 没注入（读真实数据）；null / [] 都是一次明确的「shortlist 为空」注入。
  if (source.savedOverrides !== undefined) return source.savedOverrides ?? []
  const snapshot = source.providerSnapshot
  if (snapshot !== null) {
    const builtIn = providerBuiltInModels(snapshot, "openai")
    if (builtIn.length > 0) return builtIn
  }
  return nativeModelOverrides() ?? []
}

/**
 * 触发器紧凑名：四处共用同一张（且唯一一张）短名表，已清洗星号别名与「可能不可用」。
 * 返回 null 表示没有紧凑名，调用方直接用完整显示名。
 */
export function modelShortLabel(id: string, label: string): string | null {
  const preset = presentationTable[id]?.shortLabel
  if (preset === undefined || preset.trim() === "") return null
  const cleaned = cleanModelLabel(preset)
  return cleaned === label ? null : cleaned
}

function toOption(
  entry: ModelConfigEntry,
  index: number,
  selectedId: string | null,
  fastModes: Readonly<Record<string, boolean>> | null
): ModelOption {
  const isNative = isNativeGroupId(entry.groupId, entry.id)
  const groupName = modelGroupLabel(entry.groupId, entry.groupName)
  // 用户在「供应商与可用模型」里改的名优先于会话/引擎目录里的旧名；历史脏 label 在此清洗。
  // `renamed !== null` 表示用户显式命名过该模型 —— 此时紧凑短名表必须让位，否则一次改名
  // 看起来永远没生效（旧版就踩过这个坑）。没有显式命名时才用统一短名表。
  // `displayModelLabel(id)` 对网关模型返回的是**供应商目录里的 label**（DeepSeek 这条就叫
  // "Flash"），并不代表用户改过名。旧写法把它当成「显式命名」，于是紧凑短名表永远让位，
  // 触发器上只剩供应商给的裸词。只有和目录 label 不同才算用户命名，短名表才该退出。
  const catalogLabel = cleanModelLabel(displayModelLabel(entry.id, entry.label) ?? entry.label)
  const explicit = displayModelLabel(entry.id)
  const renamed = explicit !== null && cleanModelLabel(explicit) !== catalogLabel ? explicit : null
  const label = cleanModelLabel(renamed ?? catalogLabel)
  const shortLabel = renamed !== null ? label : modelShortLabel(entry.id, label)
  const fastMode = fastModes === null ? modelFastModeFor(entry.id) : fastModes[entry.id] === true
  return {
    id: entry.id,
    label,
    shortLabel,
    groupId: entry.groupId,
    groupName,
    enabled: true,
    // 只排除 provider 明确拒绝过的 tombstone；不再有「可能不可用 / 未验证」猜测。
    available: !entry.retired,
    efforts: entry.efforts,
    defaultEffort: entry.defaultEffort,
    effortSupported: entry.efforts.length > 0,
    fastCapable: isNative,
    fastMode: isNative && fastMode,
    contextWindow: entry.contextWindow,
    icon: modelIconKind(entry.groupId, entry.id),
    order: index,
    selected: entry.id === selectedId,
    isNative
  }
}

function signatureOf(groups: readonly ModelOptionGroup[]): string {
  return groups
    .map((group) => {
      const rows = group.options
        .map((option) =>
          [
            option.id,
            option.label,
            option.shortLabel ?? "",
            option.enabled,
            option.available,
            option.efforts.join(","),
            option.defaultEffort ?? "",
            option.fastCapable,
            option.fastMode,
            option.contextWindow ?? "",
            option.icon,
            option.isNative
          ].join("|")
        )
        .join(";")
      return `${group.id}:${group.name}:${group.icon}[${rows}]`
    })
    .join("||")
}


/**
 * 引擎实际提供的原生模型 id 集合。
 *
 * 为什么需要它（2026-11-17 实证）：引擎二进制（codex-acp-v2 0.7.39）里的 GPT 只有
 * `gpt-6.1-sol` / `gpt-6-luna` / `gpt-6-astra` / `gpt-6-pro`，**没有 `gpt-6.1-terra`**；
 * 而「可用模型」shortlist 里仍可能留着 terra（旧版本写入或手动添加）。于是选择器把它画出来、
 * 用户选得中、写下去引擎静默忽略——实际跑的是上一次的模型，界面上却显示 Terra。
 *
 * 规则：shortlist 只决定**顺序与开关**，不能凭空扩充引擎并不提供的模型。引擎目录已知时，
 * 原生组取两者交集；引擎目录为空（首启、或该窗口没有 live session）时不裁剪，保留原 shortlist，
 * 避免「某个窗口拿不到目录就把列表清空」。
 */
function engineNativeIds(source: ModelOptionsSource): Set<string> | null {
  const ids = new Set<string>()
  for (const entry of nativeModelCatalogSafe(source)) {
    if (entry.id !== "" && !entry.id.startsWith("gateway:")) ids.add(entry.id)
  }
  return ids.size === 0 ? null : ids
}

function nativeModelCatalogSafe(source: ModelOptionsSource): Array<{ id: string }> {
  const native = source.native
  if (Array.isArray(native)) return native.filter((entry) => typeof entry?.id === "string")
  return []
}

/**
 * 四处模型选择器的唯一入口。
 *
 * 传入同一份 `ModelOptionsSource`，必得完全相同的 `groups` / `options` / `signature`。
 * 底层复用 `resolveModelConfig`（根因修复后 shortlist 即全量候选），本函数只负责把
 * 能力元数据 + 展示契约（分组 / 名称 / 图标 / 排序 / 可用性 / 勾选态）标准化一次。
 *
 * 关键一致性保证：只要 shortlist 非空，就把 `native` / `sessionOptions` 一律挡在裁决之外。
 * 否则「设置窗口有桥目录、主窗口有 live session、拉会窗口什么都没有」会让同一个模型在
 * 不同窗口拿到不同的 effort 档位或分组名，signature 就不再相等。引擎目录只在首启
 * （还没有任何可用模型）时作为初始清单使用。
 */
export function resolveModelOptions(source: ModelOptionsSource): ModelOptionsResult {
  const shortlist = pickShortlist(source)
  // 用引擎目录校正 shortlist：短名单只能填顺序 / 开关 / 别名，不能保留引擎不提供的原生模型。
  const engineIds = engineNativeIds(source)
  const corrected =
    engineIds === null
      ? shortlist
      : shortlist.filter((model) => model.api_id.startsWith("gateway:") || engineIds.has(model.api_id))
  // 区分「首启，还没有任何可用模型」与「用户明确把模型全关了」：前者才允许引擎目录做初始清单。
  const fromSnapshot = source.providerSnapshot === null ? [] : providerBuiltInModels(source.providerSnapshot, "openai")
  const shortlistConfigured =
    corrected.length > 0 ||
    source.savedOverrides !== undefined ||
    fromSnapshot.length > 0 ||
    (nativeModelOverrides()?.length ?? 0) > 0
  // 只有「首启、还没维护过可用模型」才允许引擎目录进入裁决。一旦用户维护过 shortlist，
  // 哪怕把每一行都关掉（没有任何 enabled 行），也必须把引擎目录彻底挡在外面：底层
  // `resolveModelConfig` 在 saved 为空时会回落到 `catalogRows(catalog)`，把会话推荐子集里的
  // Astra/Sol 重新放回四个窗口，用户「全部禁用」的设置就形同虚设。QA-B2 正是这个边界。
  // 引擎目录只影响首启初始清单；非原生网关组由 `presentModelCatalog` 的展示兼容层与
  // `providerSnapshot` 提供，不依赖这里放行。
  const useEngineCatalog = !shortlistConfigured
  const config = resolveModelConfig({
    providerSnapshot: source.providerSnapshot,
    native: useEngineCatalog ? source.native : undefined,
    sessionOptions: useEngineCatalog ? source.sessionOptions : undefined,
    savedOverrides: corrected,
    tombstones: source.tombstones ?? undefined
  })

  const selectedId = source.selectedId ?? null
  const fastModes = source.fastModes ?? null
  const flat = config.entries.map((entry, index) => toOption(entry, index, selectedId, fastModes))

  // 按 groupId 聚合，保持 entries 首现顺序；ChatGPT 组强制置顶（上游 groupPriorities）。
  const map = new Map<string, ModelOptionGroup>()
  for (const option of flat) {
    const existing = map.get(option.groupId)
    if (existing !== undefined) {
      existing.options.push(option)
      continue
    }
    map.set(option.groupId, {
      id: option.groupId,
      name: option.groupName,
      icon: option.icon,
      order: option.groupId === NATIVE_MODEL_GROUP.id ? 0 : map.size + 1,
      options: [option]
    })
  }
  const groups = [...map.values()].sort((left, right) => left.order - right.order)
  const options = groups.flatMap((group) => group.options)
  const index = new Map(options.map((option) => [option.id, option]))

  return {
    status: config.status,
    shortlistConfigured,
    groups,
    options,
    byId: (id) => index.get(id) ?? null,
    effortFor: (id) => index.get(id)?.efforts ?? [],
    fastModeFor: (id) => index.get(id)?.fastMode ?? false,
    isFastCapable: (id) => index.get(id)?.fastCapable ?? false,
    signature: signatureOf(groups)
  }
}

/** 触发器显示名：紧凑名优先，并去掉网关路由前缀（发送仍用完整 id）。 */
export function modelTriggerLabel(option: Pick<ModelOption, "label" | "shortLabel">): string {
  const raw = cleanModelLabel(option.shortLabel ?? option.label)
  const match = /^gateway:[^:]+:(.+)$/.exec(raw)
  return match?.[1] ?? raw
}
