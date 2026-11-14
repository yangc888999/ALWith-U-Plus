// The shared model catalog: every picker (设置默认模型/分工、拉会机器人、自动化、聊天草稿) calls
// modelEntries, so a rule fixed here is fixed everywhere. The regression that motivated the move:
// the enterprise provider is projected twice — once under its own id and once under the legacy
// `litellm` alias kept only so old persisted ids still resolve — and pickers that iterated the raw
// providerGroups showed 「企业内部模型」 two times in a row.

import { beforeEach, expect, test } from "vitest"

import { modelEntries } from "../model-catalog"
import { pickerProviderGroups, providerGroups, type ProviderSnapshot } from "../providers"

const enterprise = {
  id: "custom_alwith_enterprise_96b0637cadebcafe",
  name: "企业内部模型",
  baseUrl: "https://gateway.example/v1",
  models: [{ api_id: "deepseek-V4.1-flash", label: "企业内部模型" }]
}

function snapshot(): ProviderSnapshot {
  return {
    revision: 1,
    appliedRevision: 1,
    status: "applied",
    error: null,
    providers: {},
    customProviders: [],
    builtInModels: {},
    // The projection appends the legacy alias; resolution needs it, pickers must not show it.
    managedProviders: [enterprise, { ...enterprise, id: "litellm", name: "企业内部模型 (legacy)" }]
  } as unknown as ProviderSnapshot
}

beforeEach(() => {
  localStorage.clear()
})

test("the raw groups keep the legacy alias for resolution, the picker groups drop it", () => {
  expect(providerGroups(snapshot()).filter((group) => group.name.startsWith("企业内部模型"))).toHaveLength(2)
  expect(pickerProviderGroups(snapshot()).filter((group) => group.name.startsWith("企业内部模型"))).toHaveLength(1)
})

test("modelEntries lists the enterprise model exactly once", () => {
  const entries = modelEntries(snapshot(), { models: [] })
  const rows = entries.filter((entry) => entry.label === "企业内部模型")
  expect(rows).toHaveLength(1)
  expect(rows[0]?.groupId).toBe(enterprise.id)
})

test("native rows come from the published catalog with their effort ladder", () => {
  const entries = modelEntries(snapshot(), {
    name: "ChatGPT",
    models: [{ id: "gpt-6.1-sol", label: "6.1 Sol", efforts: ["low", "high"], defaultEffort: "high" }]
  })
  const sol = entries.find((entry) => entry.id === "gpt-6.1-sol")
  expect(sol).toMatchObject({ groupId: "chatgpt", groupName: "ChatGPT", efforts: ["low", "high"], defaultEffort: "high", available: true })
})

test("an unanswered native catalog keeps the saved shortlist; a failed one offers nothing", () => {
  localStorage.setItem("alwith:native-model-overrides", JSON.stringify([{ api_id: "gpt-6.1-sol", label: "6.1 Sol" }]))
  // undefined = the main window has not answered yet: the saved row survives, marked unavailable.
  const pending = modelEntries(snapshot(), undefined).find((entry) => entry.id === "gpt-6.1-sol")
  expect(pending?.available).toBe(false)
  // null = the engine failed to publish: no withdrawn ids are replayed.
  expect(modelEntries(snapshot(), null).some((entry) => entry.id === "gpt-6.1-sol")).toBe(false)
})
