import { act, cleanup, fireEvent, render, within } from "@testing-library/react"
import { afterEach, beforeAll, expect, test } from "vitest"

import { initI18n } from "@/lib/i18n"

import { setDefaultModelChoice } from "@/lib/default-model"

import { DraftModelSelect } from "../draft-model-select"

beforeAll(async () => {
  await initI18n("en")
})
afterEach(cleanup)

test("draft falls back to the first configured model when the built-in default is unavailable", async () => {
  let selected: string | null = null
  const view = render(
    <DraftModelSelect
      snapshot={{
        revision: 1,
        appliedRevision: 1,
        providers: { hakimi: { configured: true, disabled: false, region: null, base_url: null } },
        customProviders: [],
        builtInModels: {}, managedProviders: [],
        status: "applied",
        error: null
      }}
      model={null}
      onChange={(model) => {
        selected = model
      }}
    />
  )
  const trigger = view.getByRole("button")
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(trigger)
    })
  })
  expect(within(view.getByTestId("model-trigger")).getByText("Opus 5.5", { exact: true })).toBeVisible()
  expect(document.body.textContent).toContain("Claude Opus 5.5")
  expect(view.queryByRole("group", { name: "ChatGPT" })).not.toBeInTheDocument()
  expect(view.queryByRole("group", { name: "DeepSeek" })).not.toBeInTheDocument()
  expect(document.body.textContent).not.toContain("OpenRouter")
  expect(document.body.innerHTML).not.toContain("test-secret-never-render")
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByText("Claude Opus 5.5"))
    })
  })
  expect(selected).toBe("gateway:hakimi:claude-opus-5-5")
  view.rerender(
    <DraftModelSelect
      snapshot={{
        revision: 1,
        appliedRevision: 1,
        providers: { hakimi: { configured: true, disabled: false, region: null, base_url: null } },
        customProviders: [],
        builtInModels: {}, managedProviders: [],
        status: "applied",
        error: null
      }}
      model={selected}
      onChange={() => {
        throw new Error("Unexpected model switch")
      }}
    />
  )
  expect(within(view.getByTestId("model-trigger")).getByText("Opus 5.5", { exact: true })).toBeVisible()
})

test("a new draft starts on the bundled DeepSeek-Flash when DeepSeek is configured", () => {
  const view = render(
    <DraftModelSelect
      snapshot={{
        revision: 1,
        appliedRevision: 1,
        providers: { deepseek: { configured: true, disabled: false, region: null, base_url: null } },
        customProviders: [],
        builtInModels: {}, managedProviders: [],
        status: "applied",
        error: null
      }}
      model={null}
      onChange={() => {
        throw new Error("Unexpected model switch")
      }}
    />
  )
  expect(view.getByTestId("model-trigger").textContent).toMatch(/Flash/)
})

test("removing a provider does not silently switch a selected draft to Codex", () => {
  const view = render(
    <DraftModelSelect
      snapshot={{
        revision: 2,
        appliedRevision: 2,
        providers: {},
        customProviders: [],
        builtInModels: {}, managedProviders: [],
        status: "applied",
        error: null
      }}
      model="gateway:hakimi:removed-model"
      onChange={() => {
        throw new Error("Unexpected model switch")
      }}
    />
  )
  expect(view.getByRole("button").textContent).toContain("removed-model")
})

test("draft shows the model 设置 → 默认会话模型 picked, not the built-in fallback", async () => {
  setDefaultModelChoice({ model: "gpt-6.1-sol", effort: null })
  localStorage.setItem(
    "alwith:native-model-overrides",
    JSON.stringify([
      { api_id: "gpt-6.1-sol", label: "Sol", enabled: true, reasoningLevels: [], defaultReasoningLevel: null },
      { api_id: "gpt-6.1-terra", label: "Terra", enabled: true, reasoningLevels: [], defaultReasoningLevel: null }
    ])
  )
  const view = render(
    <DraftModelSelect
      snapshot={{
        revision: 1,
        appliedRevision: 1,
        providers: { hakimi: { configured: true, disabled: false, region: null, base_url: null } },
        customProviders: [],
        builtInModels: {}, managedProviders: [],
        status: "applied",
        error: null
      }}
      model={null}
      onChange={() => {}}
    />
  )
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button"))
    })
  })
  // The chat this draft starts uses `client.resolveModel(null)`, which honours the saved default.
  expect(within(view.getByTestId("model-trigger")).getByText("6.1-Sol", { exact: true })).toBeVisible()
  setDefaultModelChoice(null)
  localStorage.removeItem("alwith:native-model-overrides")
})
