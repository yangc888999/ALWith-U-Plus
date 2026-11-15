/**
 * 设置窗口里 ①②④ 三处选择器的共用取数入口。
 *
 * 这里刻意只做一件事：把该窗口能拿到的状态（provider snapshot + 主窗口桥发布的引擎目录）
 * 交给 `resolveModelOptions`。候选集规则、能力口径、名称清洗、分组与排序一律在那个纯函数里，
 * 本文件不写任何模型清单或筛选条件。聊天输入框（③）直接调用同一个纯函数，因此四处拿到的
 * `groups` / `options` / `signature` 完全一致。
 */

import { useMemo } from "react"

import { type ModelOptionsNative, type ModelOptionsResult, resolveModelOptions } from "@/lib/model-options"
import { type SettingsNativeModels, useSettingsNativeModels } from "@/lib/settings-bridge"
import { useProviders } from "@/lib/use-providers"

/** 把桥上的目录形状收敛成统一出口的入参形状（只保留能力元数据）。 */
function toNative(value: SettingsNativeModels | null | undefined): ModelOptionsNative | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return {
    name: value.name,
    sourceKind: value.sourceKind,
    models: value.models.map((model) => ({
      id: model.id,
      label: model.label,
      efforts: [...model.efforts],
      defaultEffort: model.defaultEffort
    }))
  }
}

/**
 * 设置窗口唯一的模型选项来源。
 *
 * `selectedId` 只影响勾选态，不影响候选集；不传时四处都拿同一份全量候选，由各自的
 * `ModelOptionsSelect` 用 `value` 决定当前项。
 */
export function useModelOptions(selectedId: string | null = null): ModelOptionsResult {
  const snapshot = useProviders()
  const native = useSettingsNativeModels()
  return useMemo(
    () =>
      resolveModelOptions({
        providerSnapshot: snapshot,
        native: toNative(native),
        selectedId
      }),
    [snapshot, native, selectedId]
  )
}
