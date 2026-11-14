import type { CustomProvider, ProviderSnapshot } from "@/lib/providers"

export const ENTERPRISE_PROVIDER_PREFIX = "custom_alwith_enterprise_"
// Must match gatewayModelId's custom-provider encoding in @/lib/providers; computed here so this
// module stays free of a runtime import cycle with the provider catalog.
const MODEL_PREFIX = `custom-${Array.from(new TextEncoder().encode(ENTERPRISE_PROVIDER_PREFIX), (byte) => byte.toString(16).padStart(2, "0")).join("")}`

/**
 * 旧版本里企业托管 provider 的 id。0.3.x 的会话把模型记成 `gateway:litellm:<model>`，而现在的
 * 企业目录用 `custom_alwith_enterprise_*`（模型 id 变成 `gateway:custom-<hex>:…`）。两套 id 对不上
 * 时，旧会话会被判定为「所选的账号模型不可用」，并且拒绝重放历史。
 */
const LEGACY_MANAGED_PROVIDER_ID = "litellm"

/** Exported for the provider UI, which must hide the alias instead of showing it as a second tab. */
export const LEGACY_ENTERPRISE_PROVIDER_ID = LEGACY_MANAGED_PROVIDER_ID

export function isEnterpriseModel(model: string | null | undefined): boolean {
  return (
    !!model &&
    (model.startsWith(`gateway:${MODEL_PREFIX}`) ||
      model.startsWith(`gateway:${LEGACY_MANAGED_PROVIDER_ID}:`) ||
      model.startsWith("gateway:finture-enterprise:"))
  )
}

/**
 * Replace any previous enterprise projection; relay credentials stay in native memory.
 *
 * The catalog is projected twice on purpose: once under its current id, and once under the legacy
 * `litellm` id. `resolveSessionModel` resolves a session's stored model id against the providers it
 * is given, so without the alias every conversation started before the id change would fail with
 * "The selected ALwith account model is unavailable". The alias carries no credential of its own —
 * it is the same object with a different id — so nothing extra is exposed.
 */
export function projectEnterpriseProviders(
  snapshot: ProviderSnapshot,
  provider: CustomProvider | null
): ProviderSnapshot {
  // Filter both the enterprise prefix and the legacy id so re-projecting the same snapshot twice
  // cannot accumulate aliases.
  const managed = (snapshot.managedProviders ?? []).filter(
    (entry) => !entry.id.startsWith(ENTERPRISE_PROVIDER_PREFIX) && entry.id !== LEGACY_MANAGED_PROVIDER_ID
  )
  return {
    ...snapshot,
    customProviders: snapshot.customProviders.filter((provider) => !provider.id.startsWith(ENTERPRISE_PROVIDER_PREFIX)),
    managedProviders:
      provider === null
        ? managed
        : [...managed, provider, { ...provider, id: LEGACY_MANAGED_PROVIDER_ID, name: `${provider.name} (legacy)` }]
  }
}

export function enterpriseCatalog(value: unknown): CustomProvider | null {
  if (value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid enterprise catalog")
  const provider = value as CustomProvider
  if (
    !provider.id?.startsWith(ENTERPRISE_PROVIDER_PREFIX) ||
    !provider.name?.trim() ||
    typeof provider.baseUrl !== "string" ||
    !Array.isArray(provider.models) ||
    !provider.models.length ||
    "apiKey" in value
  )
    throw new Error("Invalid enterprise catalog")
  return provider
}
