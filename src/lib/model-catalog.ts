// 兼容层：保留旧的 `modelEntries` 签名，但真正的唯一出口是 `model-options.ts`。
//
// v1.0.3 之前这里自称「The one model catalog every picker calls」，却同时自己做了一次
// 「引擎目录没发布 → native 行全标 available=false」的私有可用性判断，和聊天框、分工各说各话。
// 现在四处选择器统一调用 `resolveModelOptions`，本文件只是把统一出口的 `ModelOption` 映射回
// 旧 `ModelEntry` 形状，不再有任何清单、白名单或可用性推断。新增模型只需在「供应商与可用模型」
// 维护一次。

import { cleanModelLabel, type ModelOptionsNative, resolveModelOptions } from "./model-options"
import type { ProviderSnapshot } from "./providers"

/** @deprecated 直接用 `ModelOptionsNative`（= `model-config.ts` 的 `NativeCatalog`）。 */
export type NativeCatalog = ModelOptionsNative

export interface ModelEntry {
  id: string
  label: string
  groupId: string
  groupName: string
  efforts: string[]
  defaultEffort: string | null
  /** 只反映 provider 明确拒绝过的 tombstone；引擎目录是否发布与可用性无关。 */
  available: boolean
}

/**
 * 旧签名上的薄封装。候选集、名称、分组、排序、可用性全部由 `resolveModelOptions` 决定；
 * `native` 只是可选的引擎能力元数据（shortlist 非空时不参与裁决）。
 */
export function modelEntries(
  snapshot: ProviderSnapshot | null,
  native: NativeCatalog | null | undefined
): ModelEntry[] {
  return resolveModelOptions({ providerSnapshot: snapshot, native }).options.map((option) => ({
    id: option.id,
    label: cleanModelLabel(option.label),
    groupId: option.groupId,
    groupName: option.groupName,
    efforts: [...option.efforts],
    defaultEffort: option.defaultEffort,
    available: option.available
  }))
}
