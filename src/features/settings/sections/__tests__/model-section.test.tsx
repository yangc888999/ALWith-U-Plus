import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"

import { setDefaultModelChoice } from "@/lib/default-model"
import { initI18n } from "@/lib/i18n"
import { gatewayModelId, type ProviderSnapshot } from "@/lib/providers"

const native = {
  id: "chatgpt",
  name: "ChatGPT",
  models: [
    { id: "gpt-6.1-sol", label: "6.1-Sol", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "gpt-6-astra", label: "6-Astra", efforts: ["low", "high"], defaultEffort: "high" }
  ]
}
const snapshot: ProviderSnapshot = {
  revision: 1,
  appliedRevision: 1,
  status: "applied",
  error: null,
  providers: { hakimi: { configured: true, disabled: false, region: null, base_url: null, protocol: "responses" } },
  customProviders: [
    {
      id: "custom_private",
      name: "Private",
      baseUrl: "https://private.example.com/v1",
      models: [
        {
          label: "Private Opus",
          api_id: "private-opus",
          reasoningLevels: ["low", "high"],
          defaultReasoningLevel: "low"
        }
      ]
    }
  ],
  builtInModels: {},
  managedProviders: []
}

vi.mock("@/lib/use-providers", () => ({ useProviders: () => snapshot }))
vi.mock("@/lib/settings-bridge", () => ({ useSettingsNativeModels: () => native }))

import { ModelSection } from "../model-section"

beforeAll(async () => {
  await initI18n("en")
})

afterEach(() => {
  cleanup()
  setDefaultModelChoice(null)
})

test("shows the configured default model and effort", async () => {
  setDefaultModelChoice({ model: gatewayModelId("custom_private", "private-opus"), effort: "high" })
  render(<ModelSection />)

  // The trigger carries the configured choice: the gateway model with its pinned effort.
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Default model" })).toHaveTextContent("Private Opus"))
  expect(screen.getByRole("combobox", { name: "Default effort" })).toHaveTextContent("high")

  // The one-click "follow auto" shortcut is gone: the default is auto unless set, and edits are
  // staged behind 「立即应用」 instead of saving on change.
  expect(screen.queryByRole("button", { name: "Follow auto again" })).toBeNull()
  expect(screen.queryByTestId("default-model-apply")).toBeNull()
})

test("an unset default starts on auto with the effort picker disabled", async () => {
  render(<ModelSection />)
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Default model" })).toHaveTextContent("Auto (built-in default)")
  )
  // No model selected: there is no ladder to pin an effort against yet.
  expect(screen.getByRole("combobox", { name: "Default effort" })).toBeDisabled()
  expect(screen.queryByRole("button", { name: "Follow auto again" })).toBeNull()
})

test("the effort in use is spelled out, because ladder names say nothing about cost", async () => {
  // Following the model's own default: the pane must still name the level that will actually run.
  setDefaultModelChoice({ model: gatewayModelId("custom_private", "private-opus"), effort: null })
  render(<ModelSection />)

  await waitFor(() => expect(screen.getByText(/Light reasoning, quick replies/)).toBeTruthy())
  expect(screen.getByText(/low — Light reasoning, quick replies/)).toBeTruthy()
})

test("回归：已启用但不在会话推荐子集里的 GPT 模型，①② 都能选到且名称干净", async () => {
  // `useSettingsNativeModels()` 只返回 Astra / Sol（Codex 的推荐子集）。v1.0.2 会拿它和
  // 「供应商与可用模型」的 4 行求交集，把 Terra / Luna 从默认会话模型、分工默认模型里抹掉。
  // v1.0.3 统一出口只认 shortlist，四处都必须是 4 个、带 ChatGPT 分组、无星号 / 提示。
  localStorage.setItem(
    "alwith:native-model-overrides",
    JSON.stringify([
      {
        api_id: "gpt-6-astra",
        label: "6 Astra *",
        enabled: true,
        reasoningLevels: ["low", "medium"],
        defaultReasoningLevel: "medium"
      },
      {
        api_id: "gpt-6.1-sol",
        label: "6.1 Sol",
        enabled: true,
        reasoningLevels: ["low", "medium"],
        defaultReasoningLevel: "medium"
      },
      {
        api_id: "gpt-6.1-terra",
        label: "6.1 Terra",
        enabled: true,
        reasoningLevels: ["low", "medium"],
        defaultReasoningLevel: "medium"
      },
      {
        api_id: "gpt-6-luna",
        label: "6 Luna",
        enabled: true,
        reasoningLevels: ["low", "medium"],
        defaultReasoningLevel: "medium"
      }
    ])
  )
  try {
    render(<ModelSection />)
    const trigger = await screen.findByRole("combobox", { name: "Default model" })
    fireEvent.click(trigger)
    const labels = (await screen.findAllByRole("option")).map((item) => item.textContent?.trim() ?? "")
    for (const name of ["6 Astra", "6.1 Sol", "6.1 Terra", "6 Luna"]) {
      expect(labels.some((label) => label.includes(name))).toBe(true)
    }
    expect(labels.join(" ")).not.toContain("*")
    expect(labels.join(" ")).not.toContain("may be unavailable")
    expect(screen.getAllByText("ChatGPT").length).toBeGreaterThan(0)
  } finally {
    localStorage.removeItem("alwith:native-model-overrides")
  }
})
