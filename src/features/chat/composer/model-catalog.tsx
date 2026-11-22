/**
 * ③ 对话输入框模型下拉 —— 四处选择器中的一处。
 *
 * v1.0.3 之前这里自带一套私有规则：`trimNativeGroup` 把会话 picker（Codex 的「推荐模型集」
 * 预设，是推荐子集而非全量目录）当成权威，`unverified` 给不在该子集里的已启用模型追加
 * 「 · 可能不可用」；还有一张独立的紧凑短名表、一套私有图标 / 企业组改名 / `CHATGPT` 大写
 * 的分组标题。结果：Terra / Luna 明明已启用，这里却带「可能不可用」，而设置页默认模型
 * 干脆选不到它们。
 *
 * 现在原生 ChatGPT 组的候选集、名称、可用性、Effort 全部来自 `resolveModelOptions` —— 与
 * ① 默认会话模型、② 分工默认模型、④ 拉会成员同一个出口。图标 / 分组名 / 紧凑短名也复用
 * 该出口的 `modelIconKind` / `modelGroupLabel` / `modelShortLabel` / `modelTriggerLabel`，不再有
 * 任何硬编码模型清单、白名单、别名、星号后缀或「可能不可用」判断。
 *
 * 非原生（网关）组仍保留一层**只增不减**的兼容合并：会话 configOptions 里的网关行是引擎为
 * 该会话准备的运行时路由，未必与 provider snapshot 同步刷新；它们不是用户维护的模型清单，
 * 也绝不覆盖统一出口给出的候选。`ModelSettingsAction`（自定义模型配置入口）保持不变。
 */

import type { ModelMenuGroup, ModelMenuOption, ModelMenuProps } from "@alwith/module-chat/conversation"

import { NATIVE_MODEL_GROUP } from "@/agent/client"
import { ModelOptionIcon } from "@/components/model-options/model-option-icon"
import {
  cleanModelLabel,
  modelGroupLabel,
  modelIconKind,
  type ModelOptionsResult,
  modelShortLabel,
  modelTriggerLabel as unifiedModelTriggerLabel,
  resolveModelOptions
} from "@/lib/model-options"
import {
  displayModelLabel,
  gatewayRuntimeId,
  gatewayModelId,
  getProviderSnapshot,
  pickerProviderGroups,
  type ProviderSnapshot
} from "@/lib/providers"
import { modelDisplayId } from "@/lib/model-identity"

import { ModelSettingsAction } from "./model-settings-action"

type Row = ModelMenuOption
type ModelGroup = ModelMenuGroup

/**
 * 触发器显示名：与 ① ② ④ 完全同一个函数（紧凑名优先、去网关路由前缀、清洗星号别名）。
 * 保留本文件的导出名，让 `draft-model-select.tsx` 等旧调用方无需改动。
 */
export function modelTriggerLabel(model: { label: string; shortLabel?: string | null }): string {
  return unifiedModelTriggerLabel({ label: model.label, shortLabel: model.shortLabel ?? null })
}

/** 网关 id 的路由前缀是展示噪音，菜单行与触发器都只显示模型部分（发送仍用完整 id）。 */
function stripGatewayPrefix(label: string): string {
  return modelDisplayId(label)
}

/**
 * 会话目录的网关组与「供应商与可用模型」的供应商组合并。
 *
 * 这是纯增量的兼容层：会话是线程创建时写下的旧快照，改名 / 新增模型后要靠 snapshot 补上；
 * 而 snapshot 中途刷新可能缺组，所以会话独有的组不能反被裁掉（OpenRouter 例外：它的
 * snapshot 是用户显式启用的 shortlist，不再列出的行就是被关掉的）。legacy litellm 别名
 * 统一在最终展示层过滤。这里不产生任何 GPT 候选行 —— GPT 组完全由统一出口给出。
 */
function withSnapshotModels(groups: ModelGroup[], snapshot: ProviderSnapshot | null): ModelGroup[] {
  const next = groups.map((group) => ({ ...group, models: group.models.map((model) => ({ ...model })) }))
  if (snapshot === null) return next
  for (const provider of pickerProviderGroups(snapshot)) {
    // The snapshot keeps the public ID; session catalogs use the gateway's encoded runtime ID.
    const runtimeId = gatewayRuntimeId(provider.id)
    const matches = next.filter((group) => group.id === provider.id || group.id === runtimeId)
    let target = matches[0]
    if (target === undefined) {
      target = { id: provider.id, name: provider.name, models: [] }
      next.push(target)
    } else {
      const byId = new Map<string, Row>()
      for (const group of matches) {
        for (const model of group.models) {
          const existing = byId.get(model.api_id)
          byId.set(model.api_id, existing === undefined ? model : { ...model, ...existing })
        }
        if (group !== target) next.splice(next.indexOf(group), 1)
      }
      target.models = [...byId.values()]
    }
    if (provider.id === "openrouter") {
      const offered = new Set(provider.models.map((model) => gatewayModelId(provider.id, model.id)))
      target.models = target.models.filter(
        (model) => !model.api_id.startsWith(`gateway:${encodeURIComponent(runtimeId)}:`) || offered.has(model.api_id)
      )
    }
    for (const model of provider.models) {
      const apiId = gatewayModelId(provider.id, model.id)
      const label = displayModelLabel(apiId, model.label ?? model.id) ?? model.label ?? model.id
      const existing = target.models.find((row) => row.api_id === apiId)
      if (existing === undefined) target.models.push({ api_id: apiId, label })
      else existing.label = label
    }
  }
  return next
}

/**
 * 原生 ChatGPT 组：只认统一出口。
 *
 * `shortlistConfigured === false`（首启）时才把会话目录的原生行当作初始清单，且同样经过
 * 统一的名称清洗 / 图标 / 短名处理。用户一旦在「供应商与可用模型」维护过（哪怕全部禁用），
 * 会话 picker 这个推荐子集就再也不能决定这里列什么。
 */
function unifiedNativeGroup(sessionNative: ModelGroup | undefined, result: ModelOptionsResult): ModelGroup | null {
  const native = result.groups.find((group) => group.id === NATIVE_MODEL_GROUP.id)
  const options = native?.options ?? []
  const rows: Row[] =
    options.length > 0
      ? options.map((option) => ({
          api_id: option.id,
          label: option.label,
          shortLabel: option.shortLabel ?? undefined,
          disabled: !option.available
        }))
      : result.shortlistConfigured
        ? []
        : // 首启 / 草稿：保留会话目录的原生行，包括 `api_id: ""` 的「跟随引擎内置默认」哨兵。
          // 那不是模型清单，而是 自动（内置默认） 能力的入口，删掉会让恢复卡片选不到原生默认。
          (sessionNative?.models.map((model) => ({ ...model })) ?? [])
  if (rows.length === 0) return null
  return {
    id: NATIVE_MODEL_GROUP.id,
    name: modelGroupLabel(NATIVE_MODEL_GROUP.id, sessionNative?.name ?? NATIVE_MODEL_GROUP.name),
    models: rows
  }
}

/** 统一图标：直接取 `ModelOptionIcon` 的元素，保证紧凑菜单的分组标题标记与 ①②④ 一致。 */
function rowIcon(groupId: string, apiId: string, groupTitle: string | undefined): Row["icon"] {
  return ModelOptionIcon({
    kind: modelIconKind(groupId, apiId),
    groupTitle: groupTitle ?? null,
    className: "model-picker-icon"
  })
}

/**
 * 把会话目录的分组整理成菜单分组。
 *
 * `groups` 只提供**非原生**的网关运行时行与展示元数据；候选 GPT 行由 `resolveModelOptions`
 * 一次性给出。第二参数是注入的 provider snapshot（草稿选择器持有它；聊天菜单不传，由
 * 出口在调用时读 `getProviderSnapshot()`）。
 */
export function presentModelCatalog(
  groups: ModelGroup[],
  snapshotOverride: ProviderSnapshot | null | undefined = undefined
): ModelGroup[] {
  const snapshot = snapshotOverride === undefined ? getProviderSnapshot() : snapshotOverride
  const result = resolveModelOptions({ providerSnapshot: snapshot })

  const sessionNative = groups.find((group) => group.id === NATIVE_MODEL_GROUP.id)
  const gateway = withSnapshotModels(
    groups.filter((group) => group.id !== NATIVE_MODEL_GROUP.id),
    snapshot
  )
    .filter((group) => group.id !== "litellm")
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => !model.api_id.startsWith("gateway:litellm:"))
    }))
  const native = unifiedNativeGroup(sessionNative, result)
  const ordered = [...(native === null ? [] : [native]), ...gateway]

  return ordered.map((group) => {
    const groupName = modelGroupLabel(group.id, group.name)
    return {
      ...group,
      name: groupName,
      models: group.models.map((model, index) => {
        // 用户在「供应商与可用模型」里改的名优先于线程旧目录名与紧凑短名表；历史脏 label 在此清洗。
        const renamed = displayModelLabel(model.api_id)
        const label = stripGatewayPrefix(cleanModelLabel(renamed ?? model.label))
        const shortLabel =
          renamed !== null
            ? label
            : model.shortLabel !== undefined && model.shortLabel !== null
              ? cleanModelLabel(model.shortLabel)
              : (modelShortLabel(model.api_id, label) ?? undefined)
        return {
          ...model,
          label,
          shortLabel,
          icon: rowIcon(group.id, model.api_id, index === 0 ? groupName : undefined)
        }
      })
    }
  })
}

/** U's model menu policy: subscription models first, shared icons/labels, settings action. */
export const chatModelMenu: Pick<ModelMenuProps, "catalog" | "defaultGroup" | "headerAction"> = {
  defaultGroup: NATIVE_MODEL_GROUP,
  catalog: (groups) => presentModelCatalog(groups),
  headerAction: <ModelSettingsAction />
}
