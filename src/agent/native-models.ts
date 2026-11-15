import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"

import { sessionModelEntries, sessionModelGroups } from "@/lib/model-config"

/** The only model group that may use a planner/worker split. */
export const NATIVE_MODEL_GROUP = { id: "chatgpt", name: "ChatGPT" } as const

export type NativeModel = {
  id: string
  label: string
  /** Catalog group the model belongs to; the integrated ChatGPT group is the only GPT one. */
  groupId: string
  /** Reasoning levels the model itself declares, not the session's current model levels. */
  efforts: string[]
  /** The model's own catalog default, or null when the adapter did not publish one. */
  defaultEffort: string | null
}

/**
 * Models that may take a planner/worker split, in catalog order.
 *
 * The native group comes first, then every provider group whose models publish their own reasoning
 * efforts: those can be switched to and pinned like the native ones. Restricting the split to the
 * native group left the checkbox disabled whenever a third-party model was selected, which reads as
 * a broken control rather than an unavailable one.
 *
 * The picker is parsed in `model-config.ts` (`sessionModelGroups`) so this list and the ones the
 * model menus show can never disagree; this function only drops the group name it does not need.
 */
export function nativeModelCatalog(options: acp.SessionConfigOption[]): NativeModel[] {
  return sessionModelEntries(options).map((model) => ({
    id: model.id,
    label: model.label,
    groupId: model.groupId,
    efforts: model.efforts,
    defaultEffort: model.defaultEffort
  }))
}

/** Model membership alone decides whether the split may use a model. */
export function isNativeModel(options: acp.SessionConfigOption[], model: string | null): boolean {
  return model !== null && sessionModelEntries(options).some((entry) => entry.id === model)
}

/**
 * The integrated group's models with their own effort ladders, for surfaces that hold no session.
 *
 * The settings window has no agent connection; the main window answers its picker from whichever
 * conversation is live, because every session's model option carries the same integrated group.
 */
export function nativeGroupModels(
  options: acp.SessionConfigOption[]
): { id: string; name: string; models: NativeModel[] } | null {
  const group = sessionModelGroups(options).find((entry) => entry.id === NATIVE_MODEL_GROUP.id)
  if (group === undefined) return null
  return {
    id: group.id,
    name: group.name,
    models: group.models.map((model) => ({
      id: model.id,
      label: model.label,
      groupId: model.groupId,
      efforts: model.efforts,
      defaultEffort: model.defaultEffort
    }))
  }
}

export function selectedModelId(options: acp.SessionConfigOption[]): string | null {
  const option = options.find((entry) => entry.category === "model" && entry.type === "select")
  return option?.type === "select" && typeof option.currentValue === "string" ? option.currentValue : null
}

/** A model can participate in a split only when its own effort ladder is complete and valid. */
export function hasUsableEffortCatalog(model: NativeModel): boolean {
  return model.efforts.length > 0 && model.defaultEffort !== null && model.efforts.includes(model.defaultEffort)
}
