// The one model catalog every picker calls.
//
// 设置 → 大模型（默认会话模型 / 分工默认模型）、拉会机器人、自动化任务、聊天框都从这里取模型。
// 规则只写一遍：GPT 行走 `servedNativeRows`（与聊天框同一裁决），网关行走 `pickerProviderGroups`
// （legacy litellm 别名只用于解析旧 id，绝不进选择器——它曾让「企业内部模型」在每个下拉里出现两次）。
//
// 新界面要列模型 = 调 `modelEntries`，不要再自己拼 providerGroups。

import { NATIVE_MODEL_GROUP } from "@/agent/native-models"

import {
  gatewayModelId,
  nativeCatalogStatus,
  nativeModelOverrides,
  pickerProviderGroups,
  providerBuiltInModels,
  servedNativeRows,
  type ProviderSnapshot
} from "./providers"

/** The native group as the main window publishes it over the settings bridge. */
export interface NativeCatalog {
  name?: string
  models: Array<{ id: string; label: string; efforts?: string[]; defaultEffort?: string | null }>
}

export interface ModelEntry {
  id: string
  label: string
  groupId: string
  groupName: string
  efforts: string[]
  defaultEffort: string | null
  /**
   * Whether this session's engine still lists the model.
   *
   * A row the engine has revoked never reaches this list — it is dropped upstream, in
   * `servedNativeRows` — so every row here is live whenever a catalog is known. The flag still
   * matters in the settings window before the main window publishes its catalog: there nothing is
   * listed, every row reads `false`, and the role defaults below fall back to plain order instead
   * of claiming a model the engine may not serve.
   */
  available: boolean
}

/** Every model a picker offers: integrated group first, then each gateway. */
export function modelEntries(
  snapshot: ProviderSnapshot | null,
  native: NativeCatalog | null | undefined
): ModelEntry[] {
  const entries: ModelEntry[] = []
  // One call decides which GPT rows this picker shows and what they are called — the same call the
  // chat picker and 分工 make. A row the engine has withdrawn is already gone from this list; the
  // editable 可用模型 table keeps showing it (marked 已下架) so a save cannot silently drop it.
  const catalog = native?.models ?? []
  const groupName = native?.name ?? NATIVE_MODEL_GROUP.name
  // `undefined` = the main window has not answered yet; `null` = it answered that no live session
  // published a native group (the engine's online list_models timed out). Only the first case may
  // fall back to the saved shortlist — the second must say so instead of offering withdrawn ids.
  const status = nativeCatalogStatus(native === undefined ? undefined : native?.models ?? null)
  for (const row of servedNativeRows(nativeModelOverrides(), catalog, status)) {
    entries.push({
      id: row.id,
      label: row.label,
      // The settings bridge may name the group differently; the ChatGPT group is the GPT one
      // everywhere else, and this id drives the acceleration switch.
      groupId: NATIVE_MODEL_GROUP.id,
      groupName,
      efforts: row.efforts,
      defaultEffort: row.defaultEffort,
      // A catalog that has not arrived yet says nothing about availability; every row then reads
      // false and the role defaults below fall back to plain order.
      available: catalog.length > 0
    })
  }
  if (snapshot !== null)
    for (const group of pickerProviderGroups(snapshot)) {
      // Effort ladders live on the persisted model records, not on the picker's flat labels.
      const custom = snapshot.customProviders.find((provider) => provider.id === group.id)
      const overridden = providerBuiltInModels(snapshot, group.id)
      for (const model of group.models) {
        const record = custom?.models.find((entry) => entry.api_id === model.id)
        const override = overridden.find((entry) => entry.api_id === model.id)
        entries.push({
          id: gatewayModelId(group.id, model.id),
          label: model.label ?? model.id,
          groupId: group.id,
          groupName: group.name,
          efforts: record?.reasoningLevels ?? override?.reasoningLevels ?? [],
          defaultEffort: record?.defaultReasoningLevel ?? override?.defaultReasoningLevel ?? null,
          // Gateway groups come from the provider snapshot, which is this app's own list; the
          // engine resolves them per request.
          available: true
        })
      }
    }
  return entries
}
