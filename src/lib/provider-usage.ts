/**
 * Who still calls a provider, so closing it cannot silently break a stored choice.
 *
 * A provider is closed by clearing its configuration, which drops its models out of every picker.
 * Three places remember a model id on their own and would keep asking for one that no longer
 * resolves: 设置 → 默认会话模型, the roles of a 群聊, and the per-conversation 分工 recorded with each
 * chat. The first two are live choices and block the close; the last one belongs to history, so it
 * only warns — the conversation falls back to its main model.
 */

import { defaultModelSnapshot } from "@/lib/default-model"
import { groupRoles } from "@/lib/group-roles"

const GATEWAY_ID = /^gateway:([^:]+):/
const ORCHESTRATION_KEY = "alwith:session-orchestration"

/** The provider a model id belongs to, or null for a native (engine-owned) model. */
export function providerOfModel(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null
  const match = GATEWAY_ID.exec(model)
  return match === null ? null : decodeURIComponent(match[1])
}

export type ProviderCloseBlocker =
  | { kind: "defaultModel" }
  | { kind: "groupRole"; role: string }

/** Why this provider must stay on, or null when closing it breaks nothing live. */
export function providerCloseBlocker(providerId: string): ProviderCloseBlocker | null {
  if (providerOfModel(defaultModelSnapshot()?.model ?? null) === providerId) return { kind: "defaultModel" }
  const role = groupRoles().find((entry) => providerOfModel(entry.model) === providerId)
  return role === undefined ? null : { kind: "groupRole", role: role.name }
}

/** How many conversations still carry this provider in their recorded 分工. */
export function orchestratedSessionsUsing(providerId: string): number {
  try {
    const raw = localStorage.getItem(ORCHESTRATION_KEY)
    const parsed = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>)
    let count = 0
    for (const value of Object.values(parsed ?? {})) {
      const entry = value as { planner?: { model?: string }; worker?: { model?: string } } | null
      if (entry === null || typeof entry !== "object") continue
      if (
        providerOfModel(entry.planner?.model) === providerId ||
        providerOfModel(entry.worker?.model) === providerId
      )
        count += 1
    }
    return count
  } catch {
    return 0
  }
}
