// The one model catalog every picker calls.
//
// 设置 → 大模型（默认会话模型 / 分工默认模型）、拉会机器人、自动化任务、聊天框都从这里取模型。
// 裁决只有一处：`model-config.ts` 的 `resolveModelConfig`（GPT 行走引擎目录、网关行走
// `pickerProviderGroups`；legacy litellm 别名只用于解析旧 id，绝不进选择器——它曾让「企业内部模型」
// 在每个下拉里出现两次）。
//
// 新界面要列模型 = 调 `modelEntries`（或直接调 `resolveModelConfig`），不要再自己拼 providerGroups。

import { NATIVE_MODEL_GROUP } from "@/agent/native-models"

import { resolveModelConfig } from "./model-config"
import type { ProviderSnapshot } from "./providers"

/** The native group as the main window publishes it over the settings bridge. */
export interface NativeCatalog {
  name?: string
  /** `session` = a live session's own picker, `bundled` = the `codex_bundled_models` fallback. */
  sourceKind?: "session" | "bundled"
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
  // One call decides which GPT rows this picker shows, what they are called, and whether anything
  // may be called 已下架 — the same call the chat picker and 分工 make. A row the engine has
  // withdrawn is already gone from this list; the editable 可用模型 table keeps showing it (marked
  // 已下架) so a save cannot silently drop it.
  const catalogKnown = (native?.models.length ?? 0) > 0
  return resolveModelConfig({ providerSnapshot: snapshot, native }).entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    // The settings bridge may name the group differently; the ChatGPT group is the GPT one
    // everywhere else, and this id drives the acceleration switch.
    groupId: entry.groupId,
    groupName: entry.groupName,
    efforts: entry.efforts,
    defaultEffort: entry.defaultEffort,
    // A catalog that has not arrived yet says nothing about availability; every GPT row then reads
    // false and the role defaults below fall back to plain order. Gateway groups come from the
    // provider snapshot, which is this app's own list — the engine resolves them per request.
    available: entry.groupId === NATIVE_MODEL_GROUP.id ? catalogKnown : true
  }))
}
