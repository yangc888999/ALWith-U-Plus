import { gatewayModelId, type ProviderSnapshot } from "@/lib/providers"
import { expect, test } from "vitest"

import { enterpriseCatalog, isEnterpriseModel, projectEnterpriseProviders } from "../enterprise-providers"

const provider = {
  id: "custom_alwith_enterprise_account",
  name: "Company",
  baseUrl: "https://issued-gateway.test",
  models: [{ api_id: "issued/model", label: "Issued" }]
}
const snapshot = (): ProviderSnapshot => ({
  revision: 1,
  appliedRevision: 1,
  status: "applied",
  error: null,
  providers: {},
  customProviders: [{ ...provider, id: "custom_personal" }],
  managedProviders: [],
  builtInModels: {}
})

test("native enterprise metadata is exposed as account models alongside personal providers", () => {
  const result = projectEnterpriseProviders(snapshot(), provider)
  expect(result.customProviders.map((p) => p.id)).toEqual(["custom_personal"])
  // The catalog is projected twice: the current id and the pre-rename `litellm` alias, so a
  // conversation started before the id change still resolves its stored model.
  expect(result.managedProviders.map((p) => p.id)).toEqual([provider.id, "litellm"])
  expect(projectEnterpriseProviders(snapshot(), null).managedProviders).toEqual([])
  expect(isEnterpriseModel(gatewayModelId(provider.id, "issued/model"))).toBe(true)
  expect(isEnterpriseModel(gatewayModelId("custom_personal", "issued/model"))).toBe(false)
  expect(isEnterpriseModel("gateway:finture-enterprise:issued%2Fmodel")).toBe(true)
})

test("pre-rename sessions keep resolving through the legacy provider id", () => {
  // 0.3.x sessions stored `gateway:litellm:<model>`; the enterprise catalog now issues
  // `custom_alwith_enterprise_*`. The alias is the same object under the old id, with no extra
  // credential, and it must be recognised as an enterprise model.
  const result = projectEnterpriseProviders(snapshot(), provider)
  const legacy = result.managedProviders.find((entry) => entry.id === "litellm")
  expect(legacy).toBeDefined()
  expect(legacy?.baseUrl).toBe(provider.baseUrl)
  expect(legacy?.models).toEqual(provider.models)
  expect(isEnterpriseModel(gatewayModelId("litellm", "issued/model"))).toBe(true)
  // Clearing the account removes the alias together with the catalog.
  expect(projectEnterpriseProviders(snapshot(), null).managedProviders).toEqual([])
})

test("enterprise projection is idempotent and replaces only enterprise-managed entries", () => {
  const saved = snapshot()
  const unrelated = { ...provider, id: "custom_managed_other" }
  const previous = { ...provider, id: "custom_alwith_enterprise_previous" }
  saved.managedProviders = [unrelated, previous]
  saved.customProviders.push(previous)
  const projected = projectEnterpriseProviders(saved, provider)
  expect(projected.managedProviders.map((p) => p.id)).toEqual([unrelated.id, provider.id, "litellm"])
  expect(projectEnterpriseProviders(projected, provider)).toEqual(projected)
  expect(projectEnterpriseProviders(projected, null).managedProviders).toEqual([unrelated])
  expect(saved.managedProviders).toEqual([unrelated, previous])
})

test("the webview catalog carries API-issued metadata and rejects credentials", () => {
  expect(enterpriseCatalog(provider)).toEqual(provider)
  expect(enterpriseCatalog(null)).toBeNull()
  expect(() => enterpriseCatalog({ ...provider, apiKey: "secret" })).toThrow()
})

test("cached enterprise providers are hidden when native has no authorized catalog", () => {
  const saved = snapshot()
  saved.customProviders.push(provider)
  saved.managedProviders = [provider]
  expect(projectEnterpriseProviders(saved, null).customProviders.map((p) => p.id)).toEqual(["custom_personal"])
  expect(projectEnterpriseProviders(saved, null).managedProviders).toEqual([])
})
