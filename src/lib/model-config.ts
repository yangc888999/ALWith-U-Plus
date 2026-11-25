/**
 * The one read-only answer to "which models does this app offer right now, and what are they?".
 *
 * v1.0.3 根因修复后的规则（详见 `model-options.ts` 与 memory.md）：
 *
 *   「供应商与可用模型」里用户维护的 enabled shortlist 是**唯一权威候选集**。
 *
 * 引擎目录（live session picker / `codex_bundled_models` bundled fallback / published list）只用来
 * 补充能力元数据（effort 档位、defaultEffort、contextWindow），**绝不用来裁剪候选集**；只有
 * shortlist 为空（首次运行、用户还没维护过可用模型）时才把引擎目录当作初始清单。
 *
 * 旧实现把 `sourceKind === "session" && status === "ready"` 判为 authoritative，并用
 * `saved.filter(model => live.has(model.api_id))` 让 shortlist 与会话 picker 求交集。会话 picker
 * 是 Codex 的「推荐模型集」预设（推荐子集，通常只有 Astra / Sol），不是全量目录；主窗口
 * `app.tsx` 有 live session 时发布给设置窗口的正是这个子集，于是已启用但不在该预设里的
 * 6.1 Terra / 6 Luna 被从「默认会话模型 / 分工默认模型 / 拉会成员」里抹掉 —— 这就是
 * v1.0.2 默认会话模型只能选到 2 个 GPT 的根因。引擎临时没发布目录（list_models 超时、
 * unavailable）也不能让用户启用的模型消失。
 *
 * 因此 `unverifiedIds` / `withdrawnIds` 恒为空：不在某个推荐子集里不代表不可调用，四处选择器
 * 统一由 `model-options.ts` 给出「启用即可用」的口径。唯一还在表达的负证据是
 * `retired`/`tombstones` —— provider **明确拒绝过**该 id（`retired-models.ts`，7 天 TTL）。
 *
 * This module is **pure and read-only**: it never writes localStorage, never syncs overrides and
 * never sends `session/set_config_option`. Opening a menu must not cost a request (0.4.4 removed
 * exactly that re-check); deciding what a menu shows is arithmetic over state we already hold.
 *
 * `providers.ts` imports this module and this module imports `providers.ts` back, because the old
 * exports had to keep working. The cycle is harmless by construction: neither module touches the
 * other at module scope — every cross-module reference is inside a function called long after both
 * have finished evaluating, so there is no temporal-dead-zone read.
 */

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { isGroupedSelect, isSelectOption } from "@alwith/api"

import { NATIVE_MODEL_GROUP } from "@/agent/native-models"
import type { CustomModel } from "@/bindings"

import { modelFastModeFor } from "./model-fast-mode"
import {
  gatewayModelId,
  nativeModelOverrides,
  pickerProviderGroups,
  providerBuiltInModels,
  type ProviderSnapshot
} from "./providers"
import { isModelRetired } from "./retired-models"

/** How much of the engine's GPT catalog a surface actually holds. */
export type ModelCatalogStatus = "ready" | "partial" | "pending" | "unavailable"

/**
 * The per-model verdict.
 *
 * `unknown` is the honest answer whenever the catalog behind it cannot be trusted, and it is the
 * only status a non-authoritative surface may report.
 */
export type ModelAvailability = "available" | "withdrawn" | "unknown" | "unsupported"

/** Where a surface's model list came from. Kept for diagnostics only; it no longer crops rows. */
export type ModelConfigSourceKind = "session" | "bundled" | "saved" | "none"

/**
 * The engine's GPT group as a surface publishes it.
 *
 * `sourceKind` only describes provenance (a live session's picker vs the `codex_bundled_models`
 * fallback). Both are **recommended subsets**, not the full catalog, so neither may be used to
 * decide which saved rows still exist. It is used for `status` reporting and metadata only.
 */
export interface NativeCatalog {
  name?: string
  sourceKind?: "session" | "bundled"
  models: Array<{ id: string; label: string; efforts?: string[]; defaultEffort?: string | null }>
}

export interface ModelConfigSource {
  providerSnapshot: ProviderSnapshot | null
  /** Absent or `undefined` = not published yet, `null` = published nothing. */
  native?: NativeCatalog | null
  /** A live session's `configOptions`; preferred over `native` when it carries a model list. */
  sessionOptions?: readonly acp.SessionConfigOption[] | null
  /** Defaults to the mirrored 可用模型 shortlist (`nativeModelOverrides()`). */
  savedOverrides?: CustomModel[] | null
  /** Defaults to the `retired-models` cache. Injecting it keeps this module testable. */
  tombstones?: ReadonlySet<string>
}

export interface ModelConfigEntry {
  id: string
  label: string
  groupId: string
  groupName: string
  efforts: string[]
  defaultEffort: string | null
  /** 设置 → 可用模型's acceleration switch for this model. */
  fastMode: boolean
  /** Only `CustomModel.contextWindow` supplies this. Never invented, never defaulted. */
  contextWindow: number | null
  status: ModelAvailability
  /** Tombstone: the provider refused this id and the TTL has not expired. */
  retired: boolean
  sourceKind: ModelConfigSourceKind
}

export interface ModelConfigResult {
  status: ModelCatalogStatus
  entries: ModelConfigEntry[]
  /** Tombstoned ids, published only for an authoritative surface (kept for legacy callers). */
  retiredIds: readonly string[]
  /** Deprecated: always empty. A recommended subset never proves a saved row is unavailable. */
  unverifiedIds: readonly string[]
  /** Reserved for positive-evidence withdrawal (served-model mismatch). Empty until that check lands. */
  withdrawnIds: readonly string[]
  byId(id: string): ModelConfigEntry | null
  effortFor(id: string): readonly string[]
  fastModeFor(id: string): boolean
  contextWindowFor(id: string): number | null
  /** True only for a live session that published a real catalog. */
  authoritative: boolean
}

/**
 * The floor of the status ladder, shared with `nativeCatalogStatus`.
 *
 * `undefined` means the question was never answered (a draft before `session/new`, or the settings
 * window before the main window replies). `null` and `[]` both mean the engine published nothing.
 */
export function catalogStatusOf(published: readonly unknown[] | null | undefined): "ready" | "pending" | "unavailable" {
  if (published === undefined) return "pending"
  if (published === null || published.length === 0) return "unavailable"
  return "ready"
}

/** One choice of a session's model select, flattened with its group. */
export interface SessionModel {
  id: string
  label: string
  groupId: string
  groupName: string
  efforts: string[]
  defaultEffort: string | null
}

type AdapterModelMeta = {
  alwith?: {
    supportedReasoningEfforts?: unknown
    defaultReasoningEffort?: unknown
  }
}

function reasoningMetadata(option: { _meta?: Record<string, unknown> | null }): {
  efforts: string[]
  defaultEffort: string | null
} {
  const meta = option._meta as AdapterModelMeta | null | undefined
  const rawEfforts = meta?.alwith?.supportedReasoningEfforts
  const efforts = Array.isArray(rawEfforts)
    ? [...new Set(rawEfforts.filter((value): value is string => typeof value === "string" && value !== ""))]
    : []
  const defaultEffort =
    typeof meta?.alwith?.defaultReasoningEffort === "string" && meta.alwith.defaultReasoningEffort !== ""
      ? meta.alwith.defaultReasoningEffort
      : null
  return { efforts, defaultEffort }
}

/**
 * A session's model groups, integrated group first.
 *
 * Raw: the saved shortlist is **not** applied here. `nativeModelCatalog` needs the engine's own list
 * (a shortlist must never make the engine look like it stopped serving a model it just published),
 * while `resolveModelConfig` applies the shortlist to this group only. One parser, two views.
 */
export function sessionModelGroups(
  options: readonly acp.SessionConfigOption[] | null | undefined
): Array<{ id: string; name: string; models: SessionModel[] }> {
  if (options === null || options === undefined) return []
  const option = options.find((entry) => entry.category === "model" && entry.type === "select")
  if (option === undefined || !isSelectOption(option) || !isGroupedSelect(option.options)) return []
  const groups = [...option.options].sort(
    (left, right) => Number(right.groupId === NATIVE_MODEL_GROUP.id) - Number(left.groupId === NATIVE_MODEL_GROUP.id)
  )
  return groups.map((group) => {
    // An unnamed group keeps its id, except the integrated one: 「ChatGPT」 is what every surface
    // already shows for it, and the adapter may publish the group without a name.
    const name = group.name ?? (group.groupId === NATIVE_MODEL_GROUP.id ? NATIVE_MODEL_GROUP.name : group.groupId)
    return {
      id: group.groupId,
      name,
      models: group.options.map((choice) => ({
        id: choice.value,
        label: choice.name ?? choice.value,
        groupId: group.groupId,
        groupName: name,
        ...reasoningMetadata(choice)
      }))
    }
  })
}

/** Every model a session's picker offers, in catalog order. Raw and unfiltered. */
export function sessionModelEntries(options: readonly acp.SessionConfigOption[] | null | undefined): SessionModel[] {
  return sessionModelGroups(options).flatMap((group) => group.models)
}

/** One row of the shortlist-governed GPT group, after the catalog decision below. */
type NativeRow = {
  id: string
  label: string
  efforts: string[]
  defaultEffort: string | null
  contextWindow: number | null
}

function savedRows(saved: CustomModel[]): CustomModel[] {
  return saved.filter((model) => model.enabled !== false && model.api_id.trim() !== "")
}

/** The user's row and the catalog's row merged: the user's label and ladder win, the id is shared. */
function mergeSaved(
  model: CustomModel,
  entry: { label?: string | null; efforts?: readonly string[]; defaultEffort?: string | null } | undefined
): NativeRow {
  const explicitDefault =
    model.defaultReasoningLevelExplicit === true && model.defaultReasoningLevel !== undefined
      ? model.defaultReasoningLevel
      : undefined
  return {
    id: model.api_id,
    label: model.label.trim() !== "" ? model.label : (entry?.label ?? model.api_id),
    efforts: model.reasoningLevels ?? [...(entry?.efforts ?? [])],
    defaultEffort: explicitDefault ?? entry?.defaultEffort ?? model.defaultReasoningLevel ?? null,
    contextWindow: model.contextWindow ?? null
  }
}

function catalogRows(catalog: NativeCatalog["models"], saved: CustomModel[]): NativeRow[] {
  const byId = new Map(saved.map((model) => [model.api_id, model]))
  return catalog.map((entry) => {
    const model = byId.get(entry.id)
    const contextWindow = model?.contextWindow ?? null
    return {
      id: entry.id,
      label: model !== undefined && model.label.trim() !== "" ? model.label : (entry.label ?? entry.id),
      efforts: model?.reasoningLevels ?? [...(entry.efforts ?? [])],
      defaultEffort:
        model?.defaultReasoningLevelExplicit === true && model.defaultReasoningLevel !== undefined
          ? model.defaultReasoningLevel
          : (entry.defaultEffort ?? model?.defaultReasoningLevel ?? null),
      contextWindow
    }
  })
}

/**
 * Resolves every model a surface may show, plus the two verdicts it may state.
 *
 * The decision table (rows = what the surface holds, columns = what may be said):
 *
 * | catalog                              | status      | entries      | withdrawn |
 * |--------------------------------------|-------------|--------------|-----------|
 * | live session picker                  | ready       | shortlist    | no        |
 * | published list, no session behind it | ready       | shortlist    | no        |
 * | `codex_bundled_models` fallback      | partial     | shortlist    | no        |
 * | not answered yet                     | pending     | shortlist    | no        |
 * | answered nothing                     | unavailable | shortlist    | no        |
 * | no shortlist yet (first run)         | any         | catalog      | no        |
 *
 * v1.0.3: 「供应商与可用模型」维护的 enabled shortlist 是**唯一权威候选集**。引擎目录（live
 * session picker / bundled fallback / published list）只用来补充能力元数据（effort 档位、
 * defaultEffort、contextWindow），**绝不用来裁剪候选集**。原因见 `model-options.ts` 与
 * memory.md：会话 picker 是 Codex 的「推荐模型集」预设，是推荐子集而非全量目录；拿它与
 * shortlist 求交集，会把 6.1 Terra / 6 Luna 这类已启用、只是不在当前预设里的模型从
 * 「默认会话模型 / 分工默认模型 / 拉会成员」里抹掉 —— 这正是 v1.0.2 的默认会话模型
 * 只能选到 2 个 GPT 的根因。引擎临时没发布目录（list_models 超时）也不能让用户启用的模型消失。
 */
export function resolveModelConfig(source: ModelConfigSource): ModelConfigResult {
  const saved = savedRows(source.savedOverrides ?? nativeModelOverrides() ?? [])
  const tombstones = source.tombstones ?? null
  const retired = (id: string): boolean => (tombstones === null ? isModelRetired(id) : tombstones.has(id))

  const sessionGroups = sessionModelGroups(source.sessionOptions)
  const sessionNativeGroup = sessionGroups.find((group) => group.id === NATIVE_MODEL_GROUP.id)

  let status: ModelCatalogStatus
  let sourceKind: ModelConfigSourceKind
  let groupName: string = NATIVE_MODEL_GROUP.name
  /** The catalog the shortlist is judged against; empty whenever nothing may be judged. */
  let catalog: NativeCatalog["models"] = []
  // This value crossed a window boundary (the settings bridge serialises it), so a payload without
  // a `models` array is possible even though the type forbids it. Reading it as "answered nothing"
  // is the only safe interpretation; reading it as "everything withdrawn" is the bug this module
  // exists to prevent.
  const published = source.native == null ? source.native : (source.native.models ?? null)

  if (sessionGroups.length > 0) {
    // A live session's own picker is the narrowest and most current list there is.
    if (sessionNativeGroup === undefined) {
      // This session does not offer the integrated group at all. That is "nothing to say about
      // GPT", not "every GPT model was withdrawn".
      status = "unavailable"
      sourceKind = "session"
    } else {
      catalog = sessionNativeGroup.models.map((model) => ({
        id: model.id,
        label: model.label,
        efforts: model.efforts,
        defaultEffort: model.defaultEffort
      }))
      groupName = sessionNativeGroup.name
      status = "ready"
      sourceKind = "session"
    }
  } else if (published === undefined) {
    status = "pending"
    sourceKind = saved.length > 0 ? "saved" : "none"
  } else if (published === null || published.length === 0) {
    status = "unavailable"
    sourceKind = saved.length > 0 ? "saved" : "none"
  } else {
    catalog = published
    groupName = source.native?.name ?? NATIVE_MODEL_GROUP.name
    // A bundled fallback is the engine's built-in catalog, not this machine's live one.
    sourceKind = source.native?.sourceKind === "bundled" ? "bundled" : "session"
    status = sourceKind === "bundled" ? "partial" : "ready"
  }

  const authoritative = sourceKind === "session" && status === "ready"

  // v1.0.3 根因修复：候选集的唯一权威是「供应商与可用模型」维护的 enabled shortlist（saved）。
  // 引擎目录（live session picker / bundled fallback / published list）只用于**补充能力元数据**
  // （effort 档位、defaultEffort、contextWindow），绝不用于裁剪候选集。
  //
  // 旧逻辑在这里用 `saved.filter(model => live.has(model.api_id))` 把 shortlist 与会话 picker
  // 求交集。会话 picker 是 Codex 的「推荐模型集」预设，是推荐子集而非全量目录；主窗口
  // `app.tsx` 有 live session 时发布的正是这个子集（sourceKind: "session"），于是已启用但
  // 不在当前预设里的 6.1 Terra / 6 Luna 被从「默认会话模型 / 分工默认模型 / 拉会成员」
  // 里抹掉 —— 这就是默认会话模型只出 2 个 GPT 的根因。引擎临时没发布目录（list_models
  // 超时、unavailable）也不能让用户启用的模型消失。
  //
  // 只有 shortlist 为空（首次运行、用户还没维护过可用模型）时，才把引擎目录当作初始清单。
  let rows: NativeRow[] = []
  if (saved.length > 0) {
    rows = saved.map((model) =>
      mergeSaved(
        model,
        catalog.find((entry) => entry.id === model.api_id)
      )
    )
  } else if (status === "unavailable") {
    rows = []
  } else {
    rows = catalogRows(catalog, saved)
  }

  // 「未验证 / 可能不可用」这类基于目录子集的私有判断已废弃：不在某个推荐子集里，不代表
  // 模型不可调用。四处选择器统一由 `model-options.ts` 给出「启用即可用」的口径。
  const unverifiedIds: readonly string[] = []
  // Reserved for positive-evidence withdrawal (post-B served-model verification). Empty pre-B.
  const withdrawnIds: readonly string[] = []

  const entries: ModelConfigEntry[] = rows.map((row) => {
    const isRetired = retired(row.id)
    return {
      id: row.id,
      label: row.label,
      groupId: NATIVE_MODEL_GROUP.id,
      groupName,
      efforts: row.efforts,
      defaultEffort: row.defaultEffort,
      fastMode: modelFastModeFor(row.id),
      contextWindow: row.contextWindow,
      status: !authoritative ? "unknown" : isRetired ? "unsupported" : "available",
      retired: isRetired,
      sourceKind
    }
  })

  // Other groups a live session published (a gateway group the engine routed) are this app's own
  // list: the engine resolves them per request, so they are available without a catalog diff.
  for (const group of sessionGroups) {
    if (group.id === NATIVE_MODEL_GROUP.id) continue
    for (const model of group.models) {
      entries.push({
        id: model.id,
        label: model.label,
        groupId: group.id,
        groupName: group.name,
        efforts: model.efforts,
        defaultEffort: model.defaultEffort,
        fastMode: modelFastModeFor(model.id),
        contextWindow: null,
        status: "available",
        retired: retired(model.id),
        sourceKind
      })
    }
  }

  const snapshot = source.providerSnapshot
  if (snapshot !== null) {
    for (const group of pickerProviderGroups(snapshot)) {
      // Effort ladders and context windows live on the persisted model records, not on the
      // picker's flat labels.
      // A snapshot can cross a window boundary (or be a test fixture) without every collection;
      // read each field defensively instead of trusting the declared shape.
      const custom = snapshot.customProviders?.find((provider) => provider.id === group.id)
      const overridden = providerBuiltInModels(snapshot, group.id)
      for (const model of group.models) {
        const id = gatewayModelId(group.id, model.id)
        const record = custom?.models.find((entry) => entry.api_id === model.id)
        const override = overridden.find((entry) => entry.api_id === model.id)
        entries.push({
          id,
          label: model.label ?? model.id,
          groupId: group.id,
          groupName: group.name,
          efforts: record?.reasoningLevels ?? override?.reasoningLevels ?? [],
          defaultEffort: record?.defaultReasoningLevel ?? override?.defaultReasoningLevel ?? null,
          fastMode: modelFastModeFor(id),
          // Only a saved `CustomModel` carries a context window; the engine's catalog does not.
          contextWindow: record?.contextWindow ?? override?.contextWindow ?? null,
          status: "available",
          retired: retired(id),
          sourceKind: "session"
        })
      }
    }
  }

  const index = new Map(entries.map((entry) => [entry.id, entry]))
  return {
    status,
    entries,
    // A tombstone is evidence of a refusal, which no catalog can revoke; but a *verdict list* is
    // only published when the whole picture is authoritative. `entry.retired` stays truthful
    // either way, so a surface that needs the raw tombstone is never blocked.
    retiredIds: authoritative ? entries.filter((entry) => entry.retired).map((entry) => entry.id) : [],
    unverifiedIds,
    withdrawnIds,
    byId: (id) => index.get(id) ?? null,
    effortFor: (id) => index.get(id)?.efforts ?? [],
    fastModeFor: (id) => index.get(id)?.fastMode ?? false,
    contextWindowFor: (id) => index.get(id)?.contextWindow ?? null,
    authoritative
  }
}

/**
 * Whether a model id is one this session's engine actually runs.
 *
 * An empty set means "the catalog has not loaded yet": reporting unknown as unsupported would flag
 * every model during startup and auto-disable 分工 on open.
 */
export function isEngineModel(engineIds: ReadonlySet<string>, id: string): boolean {
  return engineIds.size === 0 || engineIds.has(id)
}
