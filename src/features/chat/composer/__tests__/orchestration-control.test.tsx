import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { createSession } from "@alwith/api"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"
import { removeGroup, setGroup } from "@/lib/groups"
import { nativeModelOverrides } from "@/lib/providers"
import { orchestrationFor, setOrchestration } from "@/lib/session-orchestration"

import { OrchestrationControl } from "../orchestration-control"

const controls = vi.hoisted(() => ({
  error: vi.fn(),
  executePlan: vi.fn()
}))

vi.mock("@/lib/client", () => ({ client: { executePlan: controls.executePlan } }))
vi.mock("@/lib/chat-window-client", () => ({ RemoteChatClient: class RemoteChatClient {} }))
vi.mock("sonner", () => ({ toast: { error: controls.error } }))
// 设置 → 可用模型 only nominates the integrated ChatGPT group. Default it to "not configured" so the
// other cases see the untouched catalog; the shortlist case opts in per test.
vi.mock("@/lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers")>()
  return { ...actual, nativeModelOverrides: vi.fn(() => null) }
})

const NATIVE_A = "gpt-6-astra"
const NATIVE_B = "gpt-6-sol"
const GATEWAY = "gateway:hakimi:claude-opus-5-5"
const GATEWAY_PLAIN = "gateway:hakimi:plain-7"

function modelOption(value: string, name: string, efforts: string[], defaultEffort: string) {
  return {
    value,
    name,
    _meta: { alwith: { supportedReasoningEfforts: efforts, defaultReasoningEffort: defaultEffort } }
  }
}

function options(currentValue: string): acp.SessionConfigOption[] {
  return [
    {
      configId: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue,
      options: [
        {
          groupId: "chatgpt",
          name: "ChatGPT",
          options: [
            modelOption(NATIVE_A, "6 Astra", ["low", "high"], "high"),
            modelOption(NATIVE_B, "6 Sol", ["low", "medium"], "low")
          ]
        },
        {
          groupId: "hakimi",
          name: "Hakimi",
          options: [
            modelOption(GATEWAY, "Opus 5.5", ["low", "high"], "low"),
            modelOption(GATEWAY_PLAIN, "Plain 7", [], "")
          ]
        }
      ]
    }
  ]
}

function session(currentValue: string, cwd = "/tmp") {
  return { ...createSession("orchestration-ui", cwd), attached: true, configOptions: options(currentValue) }
}

beforeAll(() => initI18n("en"))

afterEach(() => {
  cleanup()
  setOrchestration("orchestration-ui", null)
  vi.mocked(nativeModelOverrides).mockReturnValue(null)
  controls.error.mockReset()
  controls.executePlan.mockReset()
})

test("a chat whose model left the catalog disables the split and clears a stored split with an explicit reason", async () => {
  setOrchestration("orchestration-ui", {
    planner: { model: NATIVE_A, effort: "high" },
    worker: { model: NATIVE_B, effort: "medium" }
  })
  const view = render(<OrchestrationControl session={session("ghost-model")} />)

  await waitFor(() => expect(orchestrationFor("orchestration-ui")).toBeNull())
  expect(controls.error).toHaveBeenCalledWith(expect.stringContaining("not in the model list"))

  fireEvent.click(view.getByRole("button"))
  expect(view.getByRole("switch")).toHaveAttribute("aria-disabled", "true")
  expect(view.getByText("The current chat's model is not in the model list, so the split cannot be enabled.")).toBeVisible()
})

test("every catalog model is offered and a ladder-less role hides its effort selector", () => {
  const view = render(<OrchestrationControl session={session(NATIVE_A)} />)
  fireEvent.click(view.getByRole("button"))
  fireEvent.click(view.getByRole("switch"))

  const planner = view.getByLabelText("Planner (expensive)") as HTMLSelectElement
  const worker = view.getByLabelText("Worker (cheaper)") as HTMLSelectElement
  expect([...planner.options].map((option) => option.value)).toEqual([NATIVE_A, NATIVE_B, GATEWAY, GATEWAY_PLAIN])
  expect([...worker.options].map((option) => option.value)).toEqual([NATIVE_A, NATIVE_B, GATEWAY, GATEWAY_PLAIN])
  // The gateway model with its own ladder is offered exactly like the native ones.
  expect(within(planner).queryByRole("option", { name: "Opus 5.5" })).toBeInTheDocument()

  // The ladder-less model is selectable, but there is no effort to pin on it.
  fireEvent.change(planner, { target: { value: GATEWAY_PLAIN } })
  expect(screen.queryByLabelText("Planner effort")).not.toBeInTheDocument()
  expect(orchestrationFor("orchestration-ui")).toEqual({
    planner: { model: GATEWAY_PLAIN, effort: null },
    worker: { model: NATIVE_B, effort: null }
  })
})

test("the 可用模型 shortlist owns the GPT group; gateways are never pruned by it", () => {
  // Two complaints, one rule. Without the shortlist the split offered GPT variants the user never
  // turned on ("GPT 没这么多模型"); applying the shortlist to *every* group then wiped Claude / Kimi /
  // DeepSeek out of the dropdown ("只展示GPT的模型"). Only the integrated group follows the shortlist.
  vi.mocked(nativeModelOverrides).mockReturnValue([{ api_id: NATIVE_B, label: "6 Sol", enabled: true }])

  const view = render(<OrchestrationControl session={session(NATIVE_B)} />)
  fireEvent.click(view.getByRole("button"))
  fireEvent.click(view.getByRole("switch"))

  const planner = view.getByLabelText("Planner (expensive)") as HTMLSelectElement
  const values = [...planner.options].map((option) => option.value)
  // …every gateway model stays, whatever the shortlist says…
  expect(values).toContain(GATEWAY)
  expect(values).toContain(GATEWAY_PLAIN)
  // …and the listed GPT model survives. A GPT row the split is already running on is kept too, even
  // when the shortlist dropped it — dropping it would leave that select blank (see the keep set).
  expect(values).toContain(NATIVE_B)
})

test("a saved GPT row the engine no longer advertises is not offered", () => {
  // The engine drops models on its own schedule: `gpt-6.1-terra` was in the catalog at 07:01 and
  // gone by 07:25 while 可用模型 kept the row. All three surfaces read the session's catalog
  // through `servedNativeRows`, so the row disappears here at the same moment it disappears
  // from 设置 and the chat picker — and comes back when the catalog lists it again. Nothing is
  // written back to the saved list, so a withdrawal never turns into a deletion.
  vi.mocked(nativeModelOverrides).mockReturnValue([
    { api_id: NATIVE_A, label: "6 Astra", enabled: true },
    {
      api_id: "gpt-6.1-terra",
      label: "6.1 Terra",
      enabled: true,
      reasoningLevels: ["low", "medium"],
      defaultReasoningLevel: "medium"
    }
  ])

  const view = render(<OrchestrationControl session={session(NATIVE_A)} />)
  fireEvent.click(view.getByRole("button"))
  fireEvent.click(view.getByRole("switch"))

  const planner = view.getByLabelText("Planner (expensive)") as HTMLSelectElement
  const values = [...planner.options].map((option) => option.value)
  expect(values).not.toContain("gpt-6.1-terra")
  expect(within(planner).queryByRole("option", { name: "6.1 Terra" })).toBeNull()
})

test("a group conversation renders no split control: the roster owns that session's models", () => {
  // 分工 × 拉会 are mutually exclusive. The composer already hides the control here and the client's
  // runtime gate ignores a stored split, so the component must not render a button either — one
  // that would only produce a plan with no approval path of its own.
  const directory = "/tmp/ALWith/groups/周会"
  setGroup({
    id: "group-ui-guard",
    name: "周会",
    roles: [],
    rounds: 1,
    directory,
    document: `${directory}/group.md`,
    topic: "",
    focus: "",
    materialFolders: [],
    sessionId: null,
    autoDiscuss: true
  })
  try {
    const view = render(<OrchestrationControl session={session(NATIVE_A, directory)} />)
    expect(view.container).toBeEmptyDOMElement()
  } finally {
    removeGroup("group-ui-guard")
  }
})

test("a quick-chat conversation renders no split control: a plan there could never be approved", () => {
  // The chat folder shape is the production one: each temporary chat owns `<quick-chat>/Chat/<stamp>`.
  const view = render(
    <OrchestrationControl session={session(NATIVE_A, "/Users/tester/Documents/Codex/Chat/2026-01-05 09-00-00")} />
  )
  expect(view.container).toBeEmptyDOMElement()
})

test("changing one role's model resets only that role's effort", () => {
  const view = render(<OrchestrationControl session={session(NATIVE_A)} />)
  fireEvent.click(view.getByRole("button"))
  fireEvent.click(view.getByRole("switch"))

  const planner = view.getByLabelText("Planner (expensive)") as HTMLSelectElement
  const worker = view.getByLabelText("Worker (cheaper)") as HTMLSelectElement
  // Pin the worker's effort first, so the reset below must leave it untouched.
  fireEvent.change(worker, { target: { value: NATIVE_B } })
  const workerEffort = screen.getByLabelText("Worker effort") as HTMLSelectElement
  fireEvent.change(workerEffort, { target: { value: "medium" } })
  expect(orchestrationFor("orchestration-ui")).toEqual({
    planner: { model: NATIVE_A, effort: null },
    worker: { model: NATIVE_B, effort: "medium" }
  })

  let plannerEffort = view.getByLabelText("Planner effort") as HTMLSelectElement
  expect([...plannerEffort.options].map((option) => option.value)).toEqual(["", "low", "high"])
  fireEvent.change(plannerEffort, { target: { value: "high" } })
  expect(orchestrationFor("orchestration-ui")).toEqual({
    planner: { model: NATIVE_A, effort: "high" },
    worker: { model: NATIVE_B, effort: "medium" }
  })

  fireEvent.change(planner, { target: { value: NATIVE_B } })
  plannerEffort = screen.getByLabelText("Planner effort") as HTMLSelectElement
  expect(plannerEffort.value).toBe("")
  expect([...plannerEffort.options].map((option) => option.value)).toEqual(["", "low", "medium"])
  expect(plannerEffort.options[0]?.textContent).toBe("Follow model default (low)")
  expect(orchestrationFor("orchestration-ui")).toEqual({
    planner: { model: NATIVE_B, effort: null },
    worker: { model: NATIVE_B, effort: "medium" }
  })
})
