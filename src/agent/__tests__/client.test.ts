import { RequestError } from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { type BooleanOption, isSelectOption, type SelectOption, type Session, textOf } from "@alwith/api"
import { toast } from "sonner"
import { afterEach, expect, test, vi } from "vitest"

import { must } from "@/lib/__tests__/must"
import { setActivePreview } from "@/lib/active-preview"
import { setQueueSendMode } from "@/lib/chat-display-preferences"
import { pendingPlanFor, setPendingPlan } from "@/lib/pending-plan"
import { cancelQueuedPrompt, QueueCancelledError, queuedPromptCount, queuedPromptText } from "@/lib/queued-prompt"
import { modelFastModeFor, setModelFastMode } from "@/lib/model-fast-mode"
import { setSandboxSettings } from "@/lib/sandbox-preference"
import { orchestrationFor, setOrchestration } from "@/lib/session-orchestration"
import { clearGroupControl, requestGroupStop, setGroupPaused } from "@/lib/group-runtime"
import { groupSessionRows } from "@/lib/group-sessions"
import { automationSessionRows, replaceAutomationSessionRows } from "@/lib/automation-sessions"
import { removeGroup, setGroup } from "@/lib/groups"

import { type ClientOptions, CodexClient, type GatewayModel, modelVendor, parkedRetryDelay, turnNotSteerable, withoutModelSwitchNotes } from "../client"
import { macProjectPaths, type ProjectPaths } from "../project-path"
import { createFakeAgent } from "./fake-agent"
import { FakeHubPort } from "./fake-runtime-client"

// The client reports model hand-offs through `sonner`. Mocking it keeps those calls assertable
// without a DOM toast host, and keeps the suite from depending on sonner's own side effects.
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

/**
 * `providers/set` in catalog mode (codex-acp-v2 0.5.0): the gateway's models join every
 * session's `model` option as their own group and a session moves to the gateway only when
 * one of them is selected. Nothing global changes.
 */
type GatewayConfig = {
  /** Gateway id (`_meta.codex.id`); one `model_providers` entry and one picker group per id. */
  id: string
  name: string
  baseUrl: string
  bearerToken: string
  models: GatewayModel[]
  /** Extra Codex thread-config keys applied only to threads on the gateway. */
  config: Record<string, unknown>
}

// Native host owns provider registration; tests configure the in-process engine through its port.
async function registerGateway(port: FakeHubPort, gateway: GatewayConfig) {
  await port.acpRequest("codex", "providers/set", {
    providerId: "openai",
    apiType: "openai",
    baseUrl: gateway.baseUrl,
    _meta: {
      codex: {
        id: gateway.id,
        mode: "catalog",
        name: gateway.name,
        bearerToken: gateway.bearerToken,
        config: gateway.config
      },
      alwith: { models: gateway.models }
    }
  })
}
async function unregisterGateway(port: FakeHubPort, id: string) {
  await port.acpRequest("codex", "providers/disable", { providerId: "openai", _meta: { codex: { id } } })
}

const clients: CodexClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect()
})

async function make(
  configure?: (fake: ReturnType<typeof createFakeAgent>) => void,
  projectPaths?: ProjectPaths,
  options?: {
    resolveModel?: ClientOptions["resolveModel"]
    defaultEffort?: ClientOptions["defaultEffort"]
    defaultFastMode?: ClientOptions["defaultFastMode"]
  }
) {
  const fake = createFakeAgent()
  configure?.(fake)
  const port = new FakeHubPort(() => fake.app)
  const client = new CodexClient(() => Promise.resolve(port), {
    agentId: "codex",
    launch: { engine: "codex" },
    projectPaths,
    resolveModel: options?.resolveModel,
    defaultEffort: options?.defaultEffort,
    defaultFastMode: options?.defaultFastMode
  })
  clients.push(client)
  await client.connect()
  return { client, fake, port }
}

type ReasoningModelFixture = {
  id: string
  groupId: string
  efforts: string[]
  defaultEffort: string
}

function reasoningCatalog(
  currentModel: string,
  currentEffort: string,
  models: ReasoningModelFixture[],
  effortConfigId = "reasoning_effort"
): Session["configOptions"] {
  const current = must(models.find((model) => model.id === currentModel), "missing current model")
  const groups = new Map<string, ReasoningModelFixture[]>()
  for (const model of models) groups.set(model.groupId, [...(groups.get(model.groupId) ?? []), model])
  return [
    {
      configId: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: currentModel,
      options: [...groups.entries()].map(([groupId, entries]) => ({
        groupId,
        name: groupId === "chatgpt" ? "ChatGPT" : groupId,
        options: entries.map((model) => ({
          value: model.id,
          name: model.id,
          _meta: {
            alwith: {
              supportedReasoningEfforts: model.efforts,
              defaultReasoningEffort: model.defaultEffort
            }
          }
        }))
      }))
    },
    {
      configId: effortConfigId,
      category: "thought_level",
      name: "Effort",
      type: "select",
      currentValue: currentEffort,
      options: current.efforts.map((effort) => ({ value: effort, name: effort }))
    }
  ]
}

/** A model catalog whose switch follows the adapter: unsupported effort falls back to the new default. */
function configureReasoningModels(
  fake: ReturnType<typeof createFakeAgent>,
  models: ReasoningModelFixture[],
  initialModel: string,
  initialEffort: string,
  effortConfigId = "reasoning_effort"
) {
  let model = initialModel
  let effort = initialEffort
  const switchedTo: Array<{ model: string; effort: string }> = []
  fake.sessionOptions.current = () => reasoningCatalog(model, effort, models, effortConfigId)
  fake.configResponse.current = (request) => {
    if (request.configId === "model") {
      model = String(request.value)
      const target = must(models.find((entry) => entry.id === model), "missing target model")
      effort = target.efforts.includes(effort) ? effort : target.defaultEffort
      switchedTo.push({ model, effort })
    } else if (request.configId === effortConfigId) {
      const target = must(models.find((entry) => entry.id === model), "missing effort model")
      const next = String(request.value)
      if (!target.efforts.includes(next))
        throw RequestError.invalidRequest({ effort: next }, `Unsupported reasoning effort ${next}`)
      effort = next
    }
    return { configOptions: reasoningCatalog(model, effort, models, effortConfigId) }
  }
  return { switchedTo }
}

function orchestrationOrder(fake: ReturnType<typeof createFakeAgent>): string[] {
  return fake.events.map((event) => {
    if (event.type === "config") return `config:${event.request.configId}=${String(event.request.value)}`
    return event.text.includes("分工模式·规划") ? "prompt:planner" : "prompt:worker"
  })
}

test("new sessions resolve the configured default before asking the agent to create them", async () => {
  // In this architecture the resolver runs when a new chat's draft is prepared, before the
  // session request leaves for the agent; a plain `newSession` stays engine-default.
  const resolve = vi.fn((model: string | null) => Promise.resolve(model ?? "configured-default"))
  const { client, fake } = await make(undefined, undefined, { resolveModel: resolve })
  const id = await client.prepareDraft("main", "/tmp/configured-default")
  expect(resolve).toHaveBeenCalledWith(null, "draft")
  expect(fake.modelHints.get(id)).toBe("configured-default")
})

test("opening historical conversations does not replace their model with another slot's preference", async () => {
  const { client, fake } = await make()
  client.setModelSelections({ main: "other-main-model", chat: "other-floating-model" })
  await client.open("h1", "/tmp/one")
  expect(fake.modelHints.get("h1")).toBeNull()
})

test.each(["new", "resume", "fork"] as const)(
  "%s sessions initialize commands from the response",
  async (operation) => {
    const { client, fake } = await make()
    const source = await client.newSession("/tmp/commands-source")
    const initial = [{ name: "status", description: "Show session status" }]
    fake.sessionCommands.current = initial
    const id =
      operation === "new"
        ? await client.newSession("/tmp/commands")
        : operation === "fork"
          ? await client.fork(source, "/tmp/commands-source")
          : await client.open("h1", "/tmp/one").then(() => "h1")
    expect(client.session(id).commands).toEqual(initial)
    expect(client.session(source).commands).toEqual([])

    const updated = [{ name: "compact", description: "Compact conversation" }]
    await fake.pushUpdate(id, { sessionUpdate: "available_commands_update", availableCommands: updated })
    await vi.waitFor(() => expect(client.session(id).commands).toEqual(updated))
    expect(client.session(source).commands).toEqual([])
  }
)

test.each([{ snapshot: undefined }, { snapshot: [] }])(
  "resume command snapshots distinguish omitted and empty lists: $snapshot",
  async ({ snapshot }) => {
    const { client, fake } = await make()
    const id = await client.newSession("/tmp/commands")
    const previous = [{ name: "status", description: "Show session status" }]
    await fake.pushUpdate(id, { sessionUpdate: "available_commands_update", availableCommands: previous })
    await vi.waitFor(() => expect(client.session(id).commands).toEqual(previous))
    await client.stopSession(id)
    fake.sessionCommands.current = snapshot
    await client.open(id, "/tmp/commands")
    expect(client.session(id).commands).toEqual(snapshot ?? previous)
  }
)

test.each([{ snapshot: undefined }, { snapshot: [] }])(
  "fork command snapshots distinguish omitted and empty lists: $snapshot",
  async ({ snapshot }) => {
    const { client, fake } = await make()
    const source = await client.newSession("/tmp/commands")
    const previous = [{ name: "status", description: "Show session status" }]
    fake.replayUpdates.push({ sessionUpdate: "available_commands_update", availableCommands: previous })
    fake.sessionCommands.current = snapshot
    const id = await client.fork(source, "/tmp/commands")
    expect(client.session(id).commands).toEqual(snapshot ?? previous)
  }
)

test.each([true, false])(
  "new sessions start with Fast disabled when the agent default is %s",
  async (inheritedFast) => {
    const option: BooleanOption = {
      configId: "fast-mode",
      category: "model_config",
      name: "Fast",
      type: "boolean",
      currentValue: inheritedFast
    }
    const writes: unknown[] = []
    const { client } = await make((fake) => {
      fake.sessionOptions.current = () => [{ ...option }]
      fake.configResponse.current = (request) => {
        writes.push(request)
        expect(request.configId).toBe("fast-mode")
        expect(request.type).toBe("boolean")
        option.currentValue = request.value as boolean
        return { configOptions: [{ ...option }] }
      }
    })
    const id = await client.prepareDraft("main", "/tmp/default-fast")
    expect(client.session(id).configOptions).toEqual([{ ...option, currentValue: false }])
    expect(writes).toHaveLength(inheritedFast ? 1 : 0)
    await client.setConfig(id, "fast-mode", true)
    expect(client.session(id).configOptions).toEqual([{ ...option, currentValue: true }])
    expect(await client.prepareDraft("main", "/tmp/default-fast")).toBe(id)
    expect(client.session(id).configOptions[0]?.currentValue).toBe(true)
  }
)

test("a failed Fast default update does not expose a ready draft", async () => {
  const { client, fake } = await make((fake) => {
    fake.sessionOptions.current = () => [
      { configId: "fast-mode", category: "model_config", name: "Fast", type: "boolean", currentValue: true }
    ]
    fake.configResponse.current = () => {
      throw RequestError.invalidRequest({}, "Cannot disable Fast")
    }
  })
  await expect(client.prepareDraft("main", "/tmp/default-fast-failure")).rejects.toThrow("Cannot disable Fast")
  expect(client.state.draftSessions).toEqual({})
  expect(client.state.sessions).toEqual({})
  expect(fake.deleted.has("s0")).toBe(true)
})

test("a model's saved Fast switch is applied to a brand-new draft", async () => {
  const option: BooleanOption = {
    configId: "fast-mode",
    category: "model_config",
    name: "Fast",
    type: "boolean",
    currentValue: true
  }
  const writes: boolean[] = []
  setModelFastMode("gpt-6.1-sol", true)
  try {
    // The session must report which model it opened on: the saved switch is keyed by that id.
    const modelOption: SelectOption = {
      configId: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: "gpt-6.1-sol",
      options: [
        {
          groupId: "chatgpt",
          name: "ChatGPT",
          options: [{ value: "gpt-6.1-sol", name: "GPT-6.1 Sol" }]
        }
      ]
    }
    const { client } = await make((fake) => {
      fake.sessionOptions.current = () => [modelOption, { ...option }]
      fake.configResponse.current = (request) => {
        writes.push(request.value as boolean)
        option.currentValue = request.value as boolean
        return { configOptions: [modelOption, { ...option }] }
      }
    })
    expect(modelFastModeFor("gpt-6.1-sol")).toBe(true)
    const id = await client.prepareDraft("main", "/tmp/default-fast-on")
    expect(client.session(id).configOptions.some((entry) => entry.configId === "model")).toBe(true)
    // The adapter turns an inherited Fast off first; the model switch then turns it back on.
    expect(writes).toEqual([false, true])
    expect(
      client.session(id).configOptions.find((entry) => entry.configId === "fast-mode")?.currentValue
    ).toBe(true)
  } finally {
    setModelFastMode("gpt-6.1-sol", false)
  }
})

test("a model that publishes no Fast option keeps its saved switch", async () => {
  // The session exposes no fast-mode option, but that is ambiguous: the model may simply not have
  // published its config options yet (a transient gap), or a role that never exposes the switch.
  // Wiping the saved preference here would delete a GPT model's enabled flag on that gap and it
  // would never be re-applied, so the preference is preserved.
  setModelFastMode("gpt-6.1-sol", true)
  try {
    const { client } = await make()
    const id = await client.prepareDraft("main", "/tmp/default-fast-unsupported")
    expect(client.session(id).configOptions.some((option) => option.configId === "fast-mode")).toBe(false)
    // The saved switch survives: a transient gap must not clear a real GPT preference.
    expect(modelFastModeFor("gpt-6.1-sol")).toBe(true)
  } finally {
    setModelFastMode("gpt-6.1-sol", false)
  }
})

test("a reopened session restores its last model, effort and Fast state", async () => {
  const model: SelectOption = {
    configId: "model",
    category: "model",
    name: "Model",
    type: "select",
    currentValue: "gpt-6.1-sol",
    options: [
      {
        groupId: "chatgpt",
        name: "ChatGPT",
        options: [{ value: "gpt-6.1-sol", name: "GPT-6.1 Sol" }]
      }
    ]
  }
  const effort: SelectOption = {
    configId: "reasoning_effort",
    category: "thought_level",
    name: "Effort",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "low" },
      { value: "medium", name: "medium" },
      { value: "high", name: "high" }
    ]
  }
  const fast: BooleanOption = {
    configId: "fast-mode",
    category: "model_config",
    name: "Fast",
    type: "boolean",
    currentValue: false
  }
  const storage = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear()
  })
  localStorage.setItem(
    "alwith:session-models",
    JSON.stringify({ h1: { model: "gpt-6.1-sol", effort: "high", fastMode: true, effortExplicit: true, fastExplicit: true } })
  )
  try {
    const { client } = await make((fake) => {
      fake.sessionOptions.current = () => [model, effort, fast]
      fake.configResponse.current = (request) => {
        if (request.configId === "reasoning_effort") effort.currentValue = request.value as string
        if (request.configId === "fast-mode") fast.currentValue = request.value as boolean
        return { configOptions: [model, effort, fast] }
      }
    })
    await client.open("h1", "/tmp/one")
    await vi.waitFor(() => expect(fast.currentValue).toBe(true))
    expect(effort.currentValue).toBe("high")
    // The restored pair is written back, so the next launch reuses the same record.
    await vi.waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("alwith:session-models") ?? "{}")
      expect(stored.h1).toMatchObject({ model: "gpt-6.1-sol", effort: "high", fastMode: true })
    })
  } finally {
    localStorage.removeItem("alwith:session-models")
    vi.unstubAllGlobals()
  }
})

test("a reopened session without an explicit pick follows the model row", async () => {
  // A record written before the per-chat pins existed carries the effort the engine happened to
  // run on. It must not outrank 设置 → 可用模型: the row's level and switch win until the user
  // actually changes something in the chat.
  const model: SelectOption = {
    configId: "model",
    category: "model",
    name: "Model",
    type: "select",
    currentValue: "gpt-6.1-sol",
    options: [
      {
        groupId: "chatgpt",
        name: "ChatGPT",
        options: [
          {
            value: "gpt-6.1-sol",
            name: "GPT-6.1 Sol",
            _meta: { alwith: { supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" } }
          }
        ]
      }
    ]
  }
  const effort: SelectOption = {
    configId: "reasoning_effort",
    category: "thought_level",
    name: "Effort",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "low" },
      { value: "medium", name: "medium" },
      { value: "high", name: "high" }
    ]
  }
  const fast: BooleanOption = {
    configId: "fast-mode",
    category: "model_config",
    name: "Fast",
    type: "boolean",
    currentValue: false
  }
  const storage = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear()
  })
  localStorage.setItem(
    "alwith:session-models",
    JSON.stringify({ h2: { model: "gpt-6.1-sol", effort: "high", fastMode: false } })
  )
  setModelFastMode("gpt-6.1-sol", true)
  try {
    const { client } = await make((fake) => {
      fake.sessionOptions.current = () => [model, effort, fast]
      fake.configResponse.current = (request) => {
        if (request.configId === "reasoning_effort") effort.currentValue = request.value as string
        if (request.configId === "fast-mode") fast.currentValue = request.value as boolean
        return { configOptions: [model, effort, fast] }
      }
    })
    await client.open("h2", "/tmp/two")
    await vi.waitFor(() => expect(fast.currentValue).toBe(true))
    expect(effort.currentValue).toBe("medium")
  } finally {
    localStorage.removeItem("alwith:session-models")
    localStorage.removeItem("alwith:model-fast-mode")
    vi.unstubAllGlobals()
  }
})


test("activity reply reads an unopened session without resume, selection, or transcript writes", async () => {
  const received: unknown[] = []
  const { client, fake } = await make((fake) => {
    fake.app.onRequest(
      "_codex/session_history_items",
      (value) => value as { sessionId: string },
      ({ params }) => {
        received.push(params)
        return {
          sessionId: params.sessionId,
          consistency: "live",
          revision: null,
          nextCursor: null,
          complete: true,
          items: [
            {
              updates: [
                {
                  sessionUpdate: "agent_message",
                  messageId: "reply",
                  content: [{ type: "text", text: "Latest reply" }]
                }
              ]
            }
          ]
        }
      }
    )
  })
  client.applyRunStates([
    {
      sessionId: "unopened",
      state: "done",
      reusableDraft: false,
      owner: "stdio",
      cwd: "/tmp",
      title: "Unopened",
      since: 0,
      lastActivityAt: 0,
      version: 1,
      interruption: null,
      tasks: [],
      listeningPorts: [],
      executionId: null,
      executionRole: null
    }
  ])
  expect(await client.activityReply("unopened")).toBe("Latest reply")
  expect(received).toEqual([expect.objectContaining({ sessionId: "unopened", sortDirection: "desc", mode: "browse" })])
  expect(client.state.sessions).toEqual({})
  expect(client.state.sessionWindows).toEqual({})
  expect(client.state.runStates.unopened?.state).toBe("done")
  expect(fake.modelHints.size).toBe(0)
})

test("retry is routed by session and failed turn, deduplicated, and never inserts a user prompt", async () => {
  const received: unknown[] = []
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const { client, fake } = await make((fake) => {
    fake.app.onRequest(
      "_codex/session_retry",
      (value) => value as { sessionId: string; turnId: string; trigger: string },
      async ({ params, client: agentClient }) => {
        received.push(params)
        await gate
        await agentClient.notify("session/update", {
          sessionId: params.sessionId,
          update: { sessionUpdate: "state_update", state: "running" }
        })
        return {}
      }
    )
  })
  const id = await client.newSession("/tmp/retry")
  const before = client.session(id).items
  const first = client.retrySession(id, "failed-native", "manual")
  const second = client.retrySession(id, "failed-native", "automatic")
  expect(second).toBe(first)
  await vi.waitFor(() => expect(received).toHaveLength(1))
  expect(received).toEqual([{ sessionId: id, turnId: "failed-native", trigger: "manual" }])
  finish()
  await first
  await vi.waitFor(() => expect(client.session(id).state).toBe("running"))
  expect(client.session(id).items).toBe(before)
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" })
  await vi.waitFor(() => expect(client.session(id).state).toBe("idle"))
  await client.close(id)
  await expect(client.retrySession(id, "failed-native", "manual")).rejects.toThrow()
  expect(received).toHaveLength(1)
})

test("history enumeration and export leave sidebar, selection and attachments untouched", async () => {
  const { client, fake, port } = await make((fake) =>
    fake.app.onRequest(
      "_codex/session_history_items",
      (value) => value as { sessionId: string },
      ({ params }) => ({
        sessionId: params.sessionId,
        createdAt: 100,
        running: false,
        revision: "r",
        consistency: "optimistic",
        items: [],
        complete: true,
        nextCursor: null
      })
    )
  )
  const before = client.state
  expect((await client.listHistorySessions(() => {})).map((sessionRow) => sessionRow.sessionId)).toEqual(["h1", "h2"])
  expect(await client.exportHistory("h2", () => {})).toBe("")
  expect(client.state).toBe(before)
  expect(port.attached).toEqual([])
  expect(fake.modelHints.size).toBe(0)
  const agent = client.state.agent
  if (!agent) throw new Error("Missing initialized agent")
  client.store.setState({ agent: { ...agent, capabilities: {} } })
  await expect(client.exportHistory("h2", () => {})).rejects.toThrow("0.7.7")
})

test("history checks do not misreport a startup failure as an unsupported adapter", async () => {
  const client = new CodexClient(() => Promise.reject(new Error("Runtime startup failed")), {
    agentId: "codex",
    launch: { engine: "codex" }
  })
  clients.push(client)
  await expect(client.connect()).rejects.toThrow("Runtime startup failed")
  await expect(client.exportHistory("history", () => {})).rejects.toThrow("Codex is not connected")
  await expect(client.listHistorySessions(() => {})).rejects.toThrow("Codex is not connected")
})

async function until(predicate: () => boolean) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > 3000) throw new Error("Timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("fork sends the real turn boundary, keeps model hints and preserves replayed title and lineage", async () => {
  const { client, fake, port } = await make()
  await registerGateway(port, {
    id: "gateway",
    name: "Gateway",
    baseUrl: "https://example.com/v1",
    bearerToken: "test",
    models: [{ id: "custom-model" }],
    config: {}
  })
  const source = await client.newSession("/tmp/fork", "custom-model")
  fake.replayUpdates.push(
    { sessionUpdate: "session_info_update", title: "Original title" },
    {
      sessionUpdate: "agent_message",
      messageId: "answer-item",
      content: [{ type: "text", text: "Kept answer" }],
      _meta: { codex: { turnId: "turn-1", phase: "final_answer" } }
    }
  )
  const forked = await client.fork(source, "/tmp/fork", "turn-1")
  expect(fake.forks[0]).toMatchObject({
    sessionId: source,
    _meta: { codex: { lastTurnId: "turn-1" }, alwith: { model: "custom-model" } }
  })
  expect(client.state.sessionList.find((sessionRow) => sessionRow.sessionId === forked)).toMatchObject({
    title: "Original title (2)",
    nativeSessionId: forked,
    forkedFromId: source
  })
  expect(
    client.session(forked).items.some((item) => item.kind === "assistant" && textOf(item.content) === "Kept answer")
  ).toBe(true)
  expect(client.session(source).items).toHaveLength(0)
  expect(client.session(forked).items.every((item) => item.replayed)).toBe(true)
  client.store.setState({ agent: { info: { name: "test", version: "1" }, protocolVersion: 2 } })
  await expect(client.fork(source, "/tmp/fork", "turn-1")).rejects.toThrow("does not support")
  expect(fake.forks).toHaveLength(1)
})

test("fork titles are saved immediately, collisions are skipped, and the boundary survives reopening", async () => {
  const { client, fake } = await make()
  const source = await client.newSession("/tmp/titles")
  await client.renameSession(source, "Review")
  fake.listSessions.current = () => ({ sessions: [{ sessionId: "existing", cwd: "/tmp/titles", title: "Review (2)" }] })
  const [first, second] = await Promise.all([
    client.fork(source, "/tmp/titles", "t1"),
    client.fork(source, "/tmp/titles", "t1")
  ])
  expect(fake.renamed.get(first)).toBe("Review (3)")
  expect(fake.renamed.get(second)).toBe("Review (4)")
  expect(client.session(source).title).toBe("Review")
  expect(client.state.forkOrigins[first]).toEqual({ sourceId: source, boundaryTurnId: "t1" })
  await client.close(first)
  await client.open(first, "/tmp/titles")
  expect(client.state.forkOrigins[first]).toEqual({ sourceId: source, boundaryTurnId: "t1" })
  const nested = await client.fork(second, "/tmp/titles", "t1")
  expect(fake.renamed.get(nested)).toBe("Review (5)")
})

test("source lookup reads every page across projects and archived chats and rejects cyclic results", async () => {
  const { client, fake } = await make()
  const entry = (id: string, parent: string | null, cwd: string, archived = false) => ({
    sessionId: id,
    cwd,
    _meta: { codex: { nativeSessionId: id, forkedFromId: parent, archived } }
  })
  const before = client.state.sessionList
  const requests: unknown[] = []
  fake.listSessions.current = (request) => {
    requests.push(request)
    if (request._meta) return { sessions: [entry("archived-parent", "root", "/old", true)] }
    return request.cursor === "next"
      ? {
          sessions: [entry("branch", "archived-parent", "/other"), entry("sibling", "root", "/project")],
          nextCursor: null
        }
      : { sessions: [entry("root", null, "/project"), entry("unrelated", null, "/project")], nextCursor: "next" }
  }
  expect((await client.readSessionSummary("branch"))?.cwd).toBe("/other")
  expect(requests).toContainEqual({ _meta: { codex: { archived: true } } })
  expect(requests).toContainEqual({ cursor: "next" })
  expect((await client.readSessionSummary("archived-parent"))?.archived).toBe(true)
  expect(client.state.sessionList).toBe(before)
  fake.listSessions.current = () => ({ sessions: [], nextCursor: "cycle" })
  await expect(client.readSessionSummary("root")).rejects.toThrow("repeated cursor")
})

test("a newly forked attached chat remains selectable before Codex lists it", async () => {
  const { client, fake } = await make()
  const root = await client.newSession("/tmp/fork")
  fake.listSessions.current = (request) =>
    request._meta
      ? { sessions: [] }
      : {
          sessions: [
            { sessionId: root, cwd: "/tmp/fork", _meta: { codex: { nativeSessionId: root, forkedFromId: null } } }
          ]
        }
  const child = await client.fork(root, "/tmp/fork", "turn-1")
  await client.listSessions({ reset: true })
  expect(client.state.sessionList.some((sessionRow) => sessionRow.sessionId === child)).toBe(true)
  expect((await client.listProjectSessions("/tmp/fork")).some((sessionRow) => sessionRow.sessionId === child)).toBe(true)
  await client.delete(child)
  expect((await client.listProjectSessions("/tmp/fork")).some((sessionRow) => sessionRow.sessionId === child)).toBe(false)
})

test("stream bursts preserve every chunk across sessions with bounded UI notifications", async () => {
  const { client, fake } = await make()
  const a = await client.newSession("/tmp/a")
  const b = await client.newSession("/tmp/b")
  let notifications = 0
  const stop = client.store.subscribe(() => notifications++)
  for (let i = 0; i < 400; i++) {
    await fake.pushUpdate(i % 2 === 0 ? a : b, {
      sessionUpdate: "agent_thought_chunk",
      messageId: "thought",
      content: { type: "text", text: `${i},` }
    })
  }
  const expected = (parity: number) => Array.from({ length: 200 }, (_, i) => `${i * 2 + parity},`).join("")
  await until(() =>
    client.state.sessions[b]?.items.some((item) => item.kind === "thought" && textOf(item.content) === expected(1))
  )
  stop()
  for (const [id, parity] of [
    [a, 0],
    [b, 1]
  ] as const) {
    const item = client.state.sessions[id].items.find((item) => item.kind === "thought")
    expect(item?.kind === "thought" && textOf(item.content)).toBe(expected(parity))
    expect(client.state.sessions[id]).toBe(client.session(id))
  }
  expect(notifications).toBeLessThan(40)
})

test("completion publishes pending chunks and disconnect cannot restore a stale attached session", async () => {
  const { client, fake } = await make()
  const id = await client.newSession("/tmp/a")
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "running" })
  await fake.pushUpdate(id, {
    sessionUpdate: "agent_message_chunk",
    messageId: "answer",
    content: { type: "text", text: "complete" }
  })
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" })
  await until(() => client.session(id).state === "idle")
  expect(client.state.sessions[id]).toBe(client.session(id))
  expect(
    client.state.sessions[id].items.some((item) => item.kind === "assistant" && textOf(item.content) === "complete")
  ).toBe(true)
  await fake.pushUpdate(id, {
    sessionUpdate: "agent_message_chunk",
    messageId: "answer",
    content: { type: "text", text: "!" }
  })
  client.disconnect()
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(client.state.sessions[id].attached).toBe(false)
})

test("history replay batches complete upserts and publishes the full transcript before open resolves", async () => {
  const { client, fake } = await make()
  for (let i = 0; i < 400; i++) {
    fake.replayUpdates.push({
      sessionUpdate: "agent_message",
      messageId: `history-${i}`,
      content: [{ type: "text", text: `restored ${i}` }]
    })
  }
  let notifications = 0
  let publishedWhileRestoring = 0
  const stop = client.store.subscribe((state) => {
    notifications++
    if (state.sessions.h1?.restoring && state.sessions.h1.items.length > 0) publishedWhileRestoring++
  })
  await client.open("h1", "/tmp/one")
  stop()
  expect(client.state.sessions.h1.items).toHaveLength(402)
  expect(client.state.sessions.h1.restoring).toBe(false)
  expect(client.state.sessions.h1).toBe(client.session("h1"))
  // Replayed frames fold silently; only the finished transcript is published.
  expect(publishedWhileRestoring).toBe(0)
  expect(notifications).toBeLessThan(10)
})

test("history opens only the latest page, deduplicates older loads and preserves a live answer during pagination", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const requests: Array<Record<string, unknown>> = []
  const { client, fake } = await make((fake) => {
    fake.historyResponse.current = async (params) => {
      requests.push(params)
      const older = params.cursor === "older"
      if (older) await gate
      return {
        sessionId: params.sessionId,
        consistency: "live",
        revision: null,
        nextCursor: older ? null : "older",
        complete: older,
        turns: [
          {
            turnId: older ? "old" : "new",
            itemsView: "full",
            updates: [
              {
                sessionUpdate: "user_message",
                messageId: older ? "old-user" : "new-user",
                content: [{ type: "text", text: older ? "old" : "new" }]
              },
              {
                sessionUpdate: "agent_message",
                messageId: older ? "old-answer" : "answer",
                content: [{ type: "text", text: "stored" }]
              }
            ]
          }
        ]
      }
    }
  })
  await client.open("h1", "/tmp/one")
  expect(requests).toHaveLength(1)
  expect(client.session("h1").items.map((item) => item.id)).toEqual(["new-user", "answer"])
  const loading = client.loadOlderHistory("h1")
  expect(client.loadOlderHistory("h1")).toBe(loading)
  await fake.pushUpdate("h1", {
    sessionUpdate: "agent_message",
    messageId: "answer",
    content: [{ type: "text", text: "live" }]
  })
  await until(() =>
    client.session("h1").items.some((item) => item.kind === "assistant" && textOf(item.content) === "live")
  )
  release()
  await loading
  expect(client.session("h1").items.map((item) => item.id)).toEqual(["old-user", "old-answer", "new-user", "answer"])
  expect(client.session("h1").items.at(-1)).toMatchObject({ content: [{ text: "live" }] })
  expect(client.state.historyPages.h1).toEqual({ cursor: null, loading: false, error: null })
  await client.loadOlderHistory("h1")
  expect(requests).toHaveLength(2)
})

test("older history exposes retry errors and a late page cannot resurrect a closed session", async () => {
  let fail = true
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { client } = await make((fake) => {
    fake.historyResponse.current = async (params) => {
      if (params.cursor) {
        if (fail) throw RequestError.invalidRequest({}, "Read failed")
        await gate
      }
      return {
        sessionId: params.sessionId,
        consistency: "live",
        revision: null,
        turns: [],
        nextCursor: params.cursor ? null : "next",
        complete: !!params.cursor,
        ...(params.cursor ? {} : { turns: [{ turnId: "new", itemsView: "full", updates: [] }] })
      }
    }
  })
  await client.open("h1", "/tmp/one")
  await expect(client.loadOlderHistory("h1")).rejects.toThrow("Read failed")
  expect(client.state.historyPages.h1).toMatchObject({
    cursor: "next",
    loading: false,
    error: expect.stringContaining("Read failed") as string
  })
  fail = false
  const pending = client.loadOlderHistory("h1")
  await client.close("h1")
  release()
  await pending
  expect(client.state.sessions.h1).toBeUndefined()
  expect(client.state.historyPages.h1).toBeUndefined()
})

test("navigation indexes without replaying bodies, deduplicates hydration and discards a closed session's result", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let itemReads = 0
  const { client, fake } = await make((fake) => {
    fake.historyResponse.current = (params) => ({
      sessionId: params.sessionId,
      consistency: "live",
      revision: null,
      nextCursor: null,
      complete: true,
      turns: (params.itemsView === "summary" ? ["new", "old"] : ["new"]).map((turnId) => ({
        turnId,
        itemsView: params.itemsView,
        updates:
          params.itemsView === "summary"
            ? []
            : [{ sessionUpdate: "user_message", messageId: "new-user", content: [{ type: "text", text: "new" }] }]
      }))
    })
    fake.app.onRequest(
      "_codex/session_history_items",
      (value) => value as { sessionId: string; turnId: string },
      async ({ params }) => {
        itemReads++
        await gate
        return {
          sessionId: params.sessionId,
          consistency: "live",
          revision: null,
          nextCursor: null,
          complete: true,
          items: [
            {
              turnId: params.turnId,
              itemId: "old-user",
              updates: [
                { sessionUpdate: "user_message", messageId: "old-user", content: [{ type: "text", text: "old" }] }
              ]
            }
          ]
        }
      }
    )
  })
  await client.open("h1", "/tmp/one")
  const session = client.session("h1")
  const firstIndex = client.loadHistoryNavigation("h1")
  expect(client.loadHistoryNavigation("h1")).toBe(firstIndex)
  await firstIndex
  expect(client.state.historyNavigation.h1.turns.map((turn) => turn.turnId)).toEqual(["old", "new"])
  expect(client.session("h1")).toBe(session)
  const load = client.loadHistoryTurn("h1", "old")
  expect(client.loadHistoryTurn("h1", "old")).toBe(load)
  await until(() => itemReads === 1)
  await client.close("h1")
  release()
  await expect(load).rejects.toThrow("cancelled")
  expect(client.state.historyNavigation.h1).toBeUndefined()
  expect(client.state.sessions.h1).toBeUndefined()
  expect(fake.historyRequests.filter((params) => params.itemsView === "summary")).toHaveLength(1)
})

test("prompt acknowledgement is not completion; cancelling one session leaves the other running", async () => {
  const { client } = await make()
  const [a, b] = await Promise.all([client.newSession("/tmp/a"), client.newSession("/tmp/b")])
  await Promise.all([
    client.prompt(a, [{ type: "text", text: "one" }]),
    client.prompt(b, [{ type: "text", text: "two" }])
  ])
  expect(client.session(a).state).toBe("running")
  expect(client.session(b).state).toBe("running")
  await client.cancel(a)
  await until(() => client.session(a).state === "idle" && client.session(b).state === "idle")
  expect(client.session(a).items.some((item) => item.kind === "assistant")).toBe(false)
  const reply = client.session(b).items.find((item) => item.kind === "assistant")
  expect(reply?.kind === "assistant" && reply.content[0]?.type === "text" ? reply.content[0].text : "").toBe(
    `reply:${b}`
  )
  expect(client.state.sessions[b]).toBe(client.session(b))
})

test("the user's stop closes the ACP session so its backend task tree ends", async () => {
  const { client, fake, port } = await make()
  fake.promptHoldIdle.current = () => true
  const id = await client.newSession("/tmp/stop-process")
  await client.prompt(id, [{ type: "text", text: "long-running task" }])
  await until(() => client.session(id).state === "running")
  const request = vi.spyOn(port, "acpRequest")

  await client.cancel(id)

  expect(fake.cancels).toContain(id)
  expect(
    request.mock.calls.some(
      (call) => call[1] === "session/close" && (call[2] as { sessionId: string }).sessionId === id
    )
  ).toBe(true)
  expect(client.state.sessions[id]).toMatchObject({ attached: false, state: "idle" })
  expect(client.session(id).items.some((item) => item.kind === "user")).toBe(true)
  request.mockRestore()
})

test("stopping a session retains its transcript, cancels its permission and preserves the shared agent", async () => {
  const { client, port } = await make()
  const a = await client.newSession("/tmp/a")
  const b = await client.newSession("/tmp/b")
  await Promise.all([
    client.prompt(a, [{ type: "text", text: "permission" }]),
    client.prompt(b, [{ type: "text", text: "permission" }])
  ])
  await until(() => client.state.actions.length === 2)
  const items = client.session(a).items
  await client.stopSession(a)
  expect(client.state.sessions[a]).toMatchObject({ attached: false, restoring: false, state: "idle" })
  expect(client.session(a).items).toEqual(expect.arrayContaining(items))
  expect(client.state.actions.map((action) => action.sessionId)).toEqual([b])
  expect(client.session(b).state).toBe("requires_action")
  expect((await port.agents()).map((agent) => agent.agentId)).toEqual(["codex"])
  expect(client.state.connection).toBe("ready")
  await client.open(a, "/tmp/a")
  expect(client.session(a).attached).toBe(true)
  await client.close(b)
})

test("a rejected session stop preserves the conversation for retry", async () => {
  const { client, port } = await make()
  const id = await client.newSession("/tmp/a")
  const session = client.session(id)
  vi.spyOn(port, "acpRequest").mockRejectedValueOnce(new Error("Close failed"))
  await expect(client.stopSession(id)).rejects.toThrow("Close failed")
  expect(client.state.sessions[id]).toBe(session)
  expect(client.session(id).attached).toBe(true)
  await client.stopSession(id)
  expect(client.state.sessions[id]?.attached).toBe(false)
})

test("permission requests surface as actions and resolve back to the agent", async () => {
  const { client } = await make()
  const id = await client.newSession("/tmp/a")
  await client.prompt(id, [{ type: "text", text: "permission" }])
  await until(() => client.state.actions.length === 1)
  const action = client.state.actions[0]
  expect(action.kind).toBe("permission")
  expect(client.session(id).state).toBe("requires_action")
  expect(() =>
    client.respond(action.id, {
      outcome: { outcome: "selected", optionId: "nope" }
    })
  ).toThrow()
  client.respond(action.id, {
    outcome: { outcome: "selected", optionId: "allow_once" }
  })
  await until(() => client.session(id).state === "idle")
  expect(client.state.actions).toHaveLength(0)
  const reply = client.session(id).items.find((item) => item.kind === "assistant")
  expect(reply?.kind === "assistant" && reply.content[0]?.type === "text" ? reply.content[0].text : "").toContain(
    "allow_once"
  )
})

test("terminal output is decoded across chunk boundaries", async () => {
  const { client } = await make()
  const id = await client.newSession("/tmp/a")
  await client.prompt(id, [{ type: "text", text: "terminal" }])
  await until(() => client.session(id).state === "idle")
  expect(client.session(id).terminals.t1?.output).toBe("héllo")
  const tool = client.session(id).items.find((item) => item.kind === "tool")
  expect(tool?.kind === "tool" ? tool.status : null).toBe("completed")
})

test("threads come from the agent and open() replays history", async () => {
  const { client, fake } = await make()
  await client.listSessions()
  expect(client.state.sessionList.map((sessionRow) => sessionRow.sessionId)).toEqual(["h1"])
  await client.listArchived()
  expect(client.state.archivedSessions.map((sessionRow) => sessionRow.sessionId)).toEqual(["h2"])
  await client.open("h1", "/tmp/one")
  const session = client.session("h1")
  expect(session.attached).toBe(true)
  expect(session.items.map((item) => item.kind)).toEqual(["user", "assistant"])
  await client.archive("h1")
  expect(fake.archived.has("h1")).toBe(true)
  expect(client.state.sessionList).toHaveLength(0)
  expect(client.state.archivedSessions.map((sessionRow) => sessionRow.sessionId)).toEqual(["h1", "h2"])
  expect(client.state.sessions.h1).toBeUndefined()
})

test("opening an attached read-only session retries resume until the writer is released", async () => {
  let locked = true
  let attempts = 0
  let pending: Promise<void> = Promise.resolve()
  const { client } = await make((fake) => {
    fake.resumeResponse.current = async () => {
      attempts++
      await pending
      return { _meta: { codex: { readOnly: locked } } }
    }
  })
  await client.open("locked", "/tmp/locked")
  expect(client.session("locked")).toMatchObject({ attached: true, readOnly: true, restoring: false })
  await client.open("locked", "/tmp/locked")
  expect(attempts).toBe(2)
  expect(client.session("locked").readOnly).toBe(true)

  locked = false
  const ready = Promise.withResolvers<void>()
  pending = ready.promise
  const retry = client.open("locked", "/tmp/locked")
  await until(() => client.session("locked").restoring)
  expect(client.session("locked").restoring).toBe(true)
  const joined = client.open("locked", "/tmp/locked")
  ready.resolve()
  await Promise.all([retry, joined])
  expect(attempts).toBe(3)
  expect(client.session("locked")).toMatchObject({ attached: true, readOnly: false, restoring: false })
  expect(client.session("locked").items).toHaveLength(2)
  expect(client.session("locked").items[0]).toMatchObject({ content: [{ text: "history" }] })
  await client.open("locked", "/tmp/locked")
  expect(attempts).toBe(3)
})

test("startup sends an object for the full list through a null-normalizing transport", async () => {
  const { client, port } = await make()
  const send = port.acpRequest.bind(port)
  vi.spyOn(port, "acpRequest").mockImplementation((agentId, method, params, options) => {
    const wireParams = params ?? null
    if (method === "_codex/session_list" && wireParams === null)
      return Promise.reject(RequestError.invalidParams(undefined, "Expected an object"))
    return send(agentId, method, wireParams, options)
  })
  await client.listSessions()
  expect(client.state.sessionListLoaded).toBe(true)
  expect(client.state.sessionListError).toBeNull()
  expect(client.state.sessionList.length).toBeGreaterThan(0)
})

test("project views share one full list with empty object params, deduplicate IDs and reuse memory", async () => {
  const { client, fake } = await make()
  fake.listSessions.current = () => ({
    sessions: [
      { sessionId: "p1", cwd: "/tmp/project", title: "Old" },
      { sessionId: "p1", cwd: "/tmp/project", title: "Renamed" },
      { sessionId: "other", cwd: "/tmp/other" },
      { sessionId: "archive", cwd: "/tmp/project", _meta: { codex: { archived: true } } }
    ]
  })
  const [project] = await Promise.all([client.listProjectSessions("/tmp/project"), client.listSessions()])
  expect(project.map((sessionRow) => [sessionRow.sessionId, sessionRow.title])).toEqual([["p1", "Renamed"]])
  expect(client.state.sessionList.map((sessionRow) => sessionRow.sessionId)).toEqual(["p1", "other"])
  await client.listProjectSessions("/tmp/other")
  expect(fake.fullListRequests).toEqual([{}])
})

test("explicitly selected history entries join the shared list only once", async () => {
  const { client } = await make()
  await client.listSessions()
  const selected = { sessionId: "older", cwd: "/tmp/project", title: "Selected", updatedAt: null, archived: false }
  client.includeSession(selected)
  const state = client.state
  client.includeSession({ ...selected, title: "Stale" })
  expect(client.state).toBe(state)
  expect(await client.listProjectSessions("/tmp/project")).toEqual([selected])
})

test("a pending refresh preserves a newly selected project chat", async () => {
  const { client, fake } = await make()
  await client.listSessions()
  let answer!: (value: { sessions: Array<{ sessionId: string; cwd: string; title: string }> }) => void
  fake.listSessions.current = () =>
    new Promise((resolve) => {
      answer = resolve
    })
  const pending = client.listSessions({ reset: true })
  await until(() => answer !== undefined)
  client.includeSession({ sessionId: "older", cwd: "/tmp/project", title: "Selected", updatedAt: null, archived: false })
  answer({ sessions: [{ sessionId: "older", cwd: "/tmp/project", title: "Stale" }] })
  await pending
  expect(client.state.sessionList.filter((sessionRow) => sessionRow.sessionId === "older")).toHaveLength(1)
  expect(client.state.sessionList.find((sessionRow) => sessionRow.sessionId === "older")?.title).toBe("Selected")
})

test("refresh replaces the complete list and preserves the last snapshot on failure", async () => {
  const { client, fake } = await make()
  await client.listSessions()
  fake.listSessions.current = () => {
    throw new Error("Unavailable")
  }
  await expect(client.listSessions({ reset: true })).rejects.toThrow()
  expect(client.state.sessionList.map((sessionRow) => sessionRow.sessionId)).toEqual(["h1"])
  expect(client.state.sessionListLoaded).toBe(true)
  fake.listSessions.current = () => ({ sessions: [{ sessionId: "external", cwd: "/tmp/other" }] })
  await client.listSessions({ reset: true })
  expect(client.state.sessionList.map((sessionRow) => sessionRow.sessionId)).toEqual(["external"])
  fake.listSessions.current = () => ({ sessions: [], nextCursor: "unexpected" })
  await expect(client.listSessions({ reset: true })).rejects.toThrow("Full session list returned a cursor")
  expect(client.state.sessionList.map((sessionRow) => sessionRow.sessionId)).toEqual(["external"])
})

test("thread loading reports failure and clears it after retry", async () => {
  const { client, fake } = await make()
  let answer: ((value: { sessions: [] }) => void) | null = null
  let attempts = 0
  fake.listSessions.current = async () => {
    attempts += 1
    if (attempts === 1) throw new Error("list unavailable")
    return await new Promise<{ sessions: [] }>((resolve) => {
      answer = resolve
    })
  }

  await expect(client.listSessions({ reset: true })).rejects.toThrow("Internal error")
  expect(client.state.sessionListLoaded).toBe(false)
  expect(client.state.sessionListLoading).toBe(false)
  expect(client.state.sessionListError).toContain("Internal error")

  const retry = client.listSessions({ reset: true })
  expect(client.state.sessionListLoading).toBe(true)
  expect(client.state.sessionListError).toBeNull()
  await until(() => answer !== null)
  const respond = answer as ((value: { sessions: [] }) => void) | null
  if (respond === null) throw new Error("The retry did not reach the agent")
  respond({ sessions: [] })
  await retry
  expect(client.state.sessionListLoaded).toBe(true)
  expect(client.state.sessionListLoading).toBe(false)
  expect(client.state.sessionList).toEqual([])
})

test("a gap the client could not refill replays the whole session from the engine's record", async () => {
  const { client, port } = await make()
  await client.open("h1", "/tmp/one")
  expect(client.session("h1").items.map((item) => item.kind)).toEqual(["user", "assistant"])
  // The Runtime journal no longer had frames 3..5: what we hold is not continuous any more.
  for (const handler of port.gapHandlers) handler({ sessionId: "h1", from: 3, to: 5 })
  expect(client.session("h1").restoring).toBe(true)
  await until(() => !client.session("h1").restoring)
  // Replayed, not appended: the old projection was cleared first.
  expect(client.session("h1").items.map((item) => item.kind)).toEqual(["user", "assistant"])
  expect(client.session("h1").attached).toBe(true)
})

test("authentication errors propagate from session/new", async () => {
  const { client } = await make()
  await expect(client.newSession("/needs-auth")).rejects.toThrow()
})

test("a configured gateway can create a chat without signing in to Codex", async () => {
  const { client, fake, port } = await make()
  await registerGateway(port, {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/",
    bearerToken: "test-only",
    models: [{ id: "deepseek-flash", label: "DeepSeek-Flash" }],
    config: {}
  })
  await expect(client.newSession("/needs-auth")).rejects.toThrow()
  const id = await client.newSession("/needs-auth", "deepseek-flash")
  expect(fake.modelHints.get(id)).toBe("deepseek-flash")
  expect(client.session(id).attached).toBe(true)
})

test("host configured gateway models are identified from the session catalog and resumed with the model hint", async () => {
  const { client, fake, port } = await make()
  expect(client.providerCatalog).toBe(true)
  await registerGateway(port, {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/",
    bearerToken: "sk-test",
    models: [{ id: "deepseek-flash", label: "DeepSeek-Flash" }],
    config: { model_catalog_json: "/models.json", web_search: "disabled" }
  })
  const sent = must(fake.gateway.current, "a gateway request")
  expect(sent.providerId).toBe("openai")
  expect(sent.baseUrl).toBe("https://api.deepseek.com/")
  expect(sent._meta).toEqual({
    codex: {
      id: "deepseek",
      mode: "catalog",
      name: "DeepSeek",
      bearerToken: "sk-test",
      config: { model_catalog_json: "/models.json", web_search: "disabled" }
    },
    alwith: { models: [{ id: "deepseek-flash", label: "DeepSeek-Flash" }] }
  })

  // Existing conversations never borrow the slot's choice: opening one sends no model hint and it
  // keeps whatever its own thread was using.
  const seen: Array<[string, string, boolean]> = []
  client.onSessionModel((sessionId, modelId, isGateway) => seen.push([sessionId, modelId, isGateway]))
  client.setModelSelections({ main: "deepseek-flash", chat: null })
  await client.open("h1", "/tmp/one")
  await client.open("h2", "/tmp/two")
  expect(fake.modelHints.get("h1")).toBeNull()
  expect(fake.modelHints.get("h2")).toBeNull()
  expect(seen).toEqual([
    ["h1", "gpt-6.1-sol", false],
    ["h2", "gpt-6.1-sol", false]
  ])

  // A new conversation inherits the slot choice; a gateway model can be asked for explicitly.
  const draft = await client.prepareDraft("main", "/tmp/draft")
  expect(fake.modelHints.get(draft)).toBe("deepseek-flash")
  const native = await client.newSession("/tmp/n")
  const moved = await client.newSession("/tmp/m", "deepseek-flash")
  expect(fake.modelHints.get(native)).toBeNull()
  expect(fake.modelHints.get(moved)).toBe("deepseek-flash")

  await unregisterGateway(port, "deepseek")
  expect(fake.gateway.current).toBeNull()
})

test("a new draft uses each slot's current choice without creating a probe session", async () => {
  const { client, fake } = await make()
  client.setModelSelections({ main: "main-model", chat: "chat-model" })
  const main = await client.prepareDraft("main", "/tmp/one")
  const chat = await client.prepareDraft("chat", "/tmp/two")
  expect(fake.modelHints.get(main)).toBe("main-model")
  expect(fake.modelHints.get(chat)).toBe("chat-model")
  expect(fake.modelHints.size).toBe(2)
  expect(fake.deleted.size).toBe(0)
})

test("an existing conversation keeps its own model instead of the slot's", async () => {
  const { client, fake } = await make()
  // The first open binds h1 to its own (native) model and records it per conversation.
  await client.open("h1", "/tmp/one", "chat")
  const seen: unknown[] = []
  client.onConfirmedModel((...args) => seen.push(args))
  // Another conversation's slot choice must not leak into h1 when it is reopened.
  client.setModelSelections({ main: "main-model", chat: "chat-model" })
  await client.stopSession("h1")
  await client.open("h1", "/tmp/one")
  expect(fake.modelHints.get("h1")).toBe("gpt-6.1-sol")
  // A fresh draft still inherits the slot's choice.
  const draft = await client.prepareDraft("main", "/tmp/draft")
  expect(fake.modelHints.get(draft)).toBe("main-model")
  expect(seen).toEqual([])
})

test("only an explicit successful model selection updates its own slot memory", async () => {
  const { client, fake } = await make()
  const seen: unknown[] = []
  client.onConfirmedModel((...args) => seen.push(args))
  const draft = await client.prepareDraft("main", "/tmp/one")
  await client.open("h1", "/tmp/one")
  await client.prompt("h1", [{ type: "text", text: "hello" }])
  expect(seen).toEqual([])
  await client.setConfig(draft, "model", "picked", "chat")
  expect(seen).toEqual([["chat", "picked"]])
  fake.configResponse.current = () => {
    throw new Error("Rejected model change")
  }
  await expect(client.setConfig(draft, "model", "unavailable", "chat")).rejects.toThrow("Internal error")
  expect(seen).toEqual([["chat", "picked"]])
  const floating = await client.prepareDraft("chat", "/tmp/two")
  expect(fake.modelHints.get(floating)).toBe("picked")
})

test("a new slot does not borrow another slot's saved selection", async () => {
  const { client, fake } = await make()
  client.setModelSelections({ main: "picked", chat: null })
  await client.open("h1", "/tmp/one", "chat")
  expect(fake.modelHints.get("h1")).toBeNull()
})

test("switching one conversation's model never changes another conversation", async () => {
  const { client, fake } = await make()
  await client.open("h1", "/tmp/one")
  await client.open("h2", "/tmp/two", "chat")
  await client.setConfig("h1", "model", "picked", "main")
  const modelOf = (id: string) =>
    client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined
  expect(modelOf("h1")).toBe("picked")
  // Reopening the untouched conversation resumes on its own recorded model, not h1's new one.
  await client.stopSession("h2")
  await client.open("h2", "/tmp/two")
  expect(modelOf("h2")).toBe("gpt-6.1-sol")
  expect(fake.modelHints.get("h2")).toBe("gpt-6.1-sol")
})

test("a handed-off session no longer changes the previous slot's model", async () => {
  const { client, fake } = await make()
  await client.open("h1", "/tmp/one", "chat")
  const previousModel = client.session("h1").configOptions.find((option) => option.category === "model")?.currentValue
  await client.open("h1", "/tmp/one", "main")
  await client.setConfig("h1", "model", "main-picked", "main")
  const draft = await client.prepareDraft("chat", "/tmp/two")
  expect(fake.modelHints.get(draft)).toBe(previousModel)
})

test("a draft waits for the host's applied provider selection", async () => {
  const ready = Promise.withResolvers<string | null>()
  const { client, fake } = await make(undefined, undefined, { resolveModel: () => ready.promise })
  const preparing = client.prepareDraft("main", "/tmp/one")
  expect(fake.modelHints.size).toBe(0)
  ready.resolve("configured-default")
  const draft = await preparing
  expect(fake.modelHints.get(draft)).toBe("configured-default")
  expect(fake.modelHints.size).toBe(1)
})

test("provider application failures stop draft preparation without creating a session", async () => {
  const { client, fake } = await make(undefined, undefined, {
    resolveModel: () => {
      return Promise.try(() => {
        throw new Error("Provider unavailable")
      })
    }
  })
  await expect(client.prepareDraft("main", "/tmp/one")).rejects.toThrow("Provider unavailable")
  expect(fake.modelHints.size).toBe(0)
})

test("model changes after restoring a session wait for the previous configuration change", async () => {
  const { client, fake, port } = await make()
  await registerGateway(port, {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/",
    bearerToken: "test-only",
    models: [{ id: "deepseek-flash" }],
    config: {}
  })
  await client.open("h1", "/tmp/one")

  let releaseFirst!: () => void
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let enteredFirst = false
  fake.configDelay.current = async () => {
    if (enteredFirst) return
    enteredFirst = true
    await firstBlocked
  }

  const first = client.setConfig("h1", "model", "deepseek-flash")
  await until(() => enteredFirst)
  const second = client.setConfig("h1", "model", "gpt-6.1-sol")
  const results = Promise.allSettled([first, second])
  await new Promise((resolve) => setTimeout(resolve, 20))
  releaseFirst()
  expect(await results).toEqual([
    { status: "fulfilled", value: undefined },
    { status: "fulfilled", value: undefined }
  ])
  expect(fake.configChanges).toEqual(["deepseek-flash", "gpt-6.1-sol"])
  const model = client.session("h1").configOptions.find((option) => option.configId === "model")
  expect(model?.currentValue).toBe("gpt-6.1-sol")
})

test("a parked switch that keeps being refused backs off instead of hammering the agent", () => {
  // What one machine actually logged: `Wait for the current turn before changing its provider`
  // every two seconds for ninety minutes, each cycle re-parking itself, until the ring buffer held
  // nothing else. The ladder is the guard — assert it grows and then flattens.
  expect(parkedRetryDelay(1)).toBe(2_000)
  expect(parkedRetryDelay(2)).toBe(4_000)
  expect(parkedRetryDelay(3)).toBe(8_000)
  expect(parkedRetryDelay(4)).toBe(16_000)
  expect(parkedRetryDelay(9)).toBe(16_000)
  expect(parkedRetryDelay(0)).toBe(2_000)
})

test("a model picked mid-turn is parked, never errors, and lands once the turn settles", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "deepseek-flash", groupId: "deepseek", efforts: ["low", "high"], defaultEffort: "low" }
  ]
  let switchedTo: Array<{ model: string; effort: string }> = []
  const { client, fake } = await make((fake) => {
    switchedTo = configureReasoningModels(fake, models, "gpt-6.1-sol", "medium").switchedTo
  })
  // The agent answers a mid-turn provider change with a rejection; the client must absorb it.
  const configured = must(fake.configResponse.current, "missing config handler")
  let turnRunning = false
  fake.configResponse.current = (request) => {
    if (request.configId === "model" && turnRunning)
      throw RequestError.invalidRequest({ sessionId: request.sessionId }, "Wait for the current turn to finish")
    return configured(request)
  }
  const id = await client.newSession("/tmp/park")
  const currentModel = (): string | undefined =>
    client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "running" })
  turnRunning = true

  // The switch neither rejects nor takes effect while the turn runs. The fake records the
  // attempted write before the handler rejects it, so assert on the switch never landing.
  await client.setConfig(id, "model", "deepseek-flash")
  expect(switchedTo.filter((entry) => entry.model === "deepseek-flash")).toEqual([])
  expect(client.pendingModelFor(id)).toBe("deepseek-flash")
  expect(currentModel()).toBe("gpt-6.1-sol")

  // The turn settles; the parked choice applies by itself.
  turnRunning = false
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "idle" })
  await until(() => currentModel() === "deepseek-flash")
  expect(client.pendingModelFor(id)).toBeNull()
})

test("a model picked right after Stop lands instead of parking behind the turn", async () => {
  // What the agent does when a turn is still unwinding: it refuses the provider rebind. For a
  // native model that refusal is routine right after a stop, because every native model resolves to
  // the "no gateway" rebind while the thread sits on the shared router. Parking it there is what
  // left the "下一轮" badge on the composer with nothing left to wait for.
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium"], defaultEffort: "medium" },
    { id: "gpt-6.1-luna", groupId: "chatgpt", efforts: ["low", "medium"], defaultEffort: "medium" }
  ]
  const { client, fake } = await make((agent) => {
    configureReasoningModels(agent, models, "gpt-6.1-sol", "medium")
  })
  const configured = must(fake.configResponse.current, "missing config handler")
  let refuseOnce = true
  fake.configResponse.current = (request) => {
    if (request.configId === "model" && refuseOnce) {
      refuseOnce = false
      throw RequestError.invalidRequest({ sessionId: request.sessionId }, "Wait for the current turn to finish")
    }
    return configured(request)
  }
  const id = await client.newSession("/tmp/stop-switch")
  const currentModel = (): string | undefined =>
    client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined

  // The user presses Stop, then picks another GPT model a moment later.
  await client.cancel(id)
  await client.open(id, "/tmp/stop-switch")
  await client.setConfig(id, "model", "gpt-6.1-luna")

  expect(currentModel()).toBe("gpt-6.1-luna")
  // No badge left behind: the choice was applied, not queued.
  expect(client.pendingModelFor(id)).toBeNull()
})

test("a new turn clears the stop, so the next model pick parks the ordinary way", async () => {
  // "Switch now" is decided by state, not by a clock: once the user sends again, the chat has a
  // turn to wait for and a model picked during it belongs in the queue — even if the stop was a
  // second ago.
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium"], defaultEffort: "medium" },
    { id: "gpt-6.1-luna", groupId: "chatgpt", efforts: ["low", "medium"], defaultEffort: "medium" }
  ]
  const { client, fake } = await make((agent) => {
    configureReasoningModels(agent, models, "gpt-6.1-sol", "medium")
  })
  const configured = must(fake.configResponse.current, "missing config handler")
  let turnRunning = false
  fake.configResponse.current = (request) => {
    if (request.configId === "model" && turnRunning)
      throw RequestError.invalidRequest({ sessionId: request.sessionId }, "Wait for the current turn to finish")
    return configured(request)
  }
  const id = await client.newSession("/tmp/stop-then-send")
  await client.cancel(id)
  await client.open(id, "/tmp/stop-then-send")

  // The user sends again; this turn is genuinely running when they pick a model.
  turnRunning = true
  const turn = client.prompt(id, [{ type: "text", text: "继续" }])
  await client.setConfig(id, "model", "gpt-6.1-luna")

  expect(client.pendingModelFor(id)).toBe("gpt-6.1-luna")
  turnRunning = false
  await turn
})

test("a model name alone does not identify a vendor", () => {
  // 哈基米 is a reseller: its catalog carries `gpt-6.1-sol` under the same words as the native one.
  // Same name, different vendor, different quota pool — so a switch between them must not be
  // treated as a no-op while the request stays with the old vendor (2026-11-19). The picker, the
  // engine and the bridge spell the same choice three ways; all three resolve to one vendor here.
  expect(modelVendor("gpt-6.1-sol")).toBe("native")
  expect(modelVendor("gateway:hakimi:gpt-6.1-sol")).toBe("hakimi")
  expect(modelVendor("hakimi/gpt-6.1-sol")).toBe("hakimi")
  expect(modelVendor("gateway:qwen:qwen3.8-max")).toBe("qwen")
  expect(modelVendor("qwen/qwen3.8-max")).toBe("qwen")
  // A custom provider runtime id is opaque: it must not collapse into a builtin vendor.
  expect(modelVendor("gateway:custom-68616b696d69:gpt-6.1-sol")).toBe("custom-68616b696d69")

  // The rule the switch applies: inside one vendor this is only a name change…
  expect(modelVendor("gateway:hakimi:claude-fable-5-1")).toBe(modelVendor("gateway:hakimi:gpt-6.1-sol"))
  // …but the same words from another vendor are a different pick, whatever the id spelling.
  expect(modelVendor("gateway:hakimi:gpt-6.1-sol")).not.toBe(modelVendor("gpt-6.1-sol"))
})

test("a turn that failed leaves nothing to wait for, so the next model pick lands", async () => {
  // The capacity failure ends the turn. If that still counts as "busy", the pick the user makes
  // right after — switch models and retry — is parked behind a turn that no longer exists.
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium"], defaultEffort: "medium" },
    { id: "gpt-6.1-luna", groupId: "chatgpt", efforts: ["low", "medium"], defaultEffort: "medium" }
  ]
  const { client, fake } = await make((agent) => {
    configureReasoningModels(agent, models, "gpt-6.1-sol", "medium")
  })
  const configured = must(fake.configResponse.current, "missing config handler")
  let refuseOnce = true
  fake.configResponse.current = (request) => {
    if (request.configId === "model" && refuseOnce) {
      refuseOnce = false
      throw RequestError.invalidRequest({ sessionId: request.sessionId }, "Wait for the current turn to finish")
    }
    return configured(request)
  }
  fake.promptError.current = () => new Error("Selected model is at capacity. Please try a different model.")
  const id = await client.newSession("/tmp/failed-turn")
  const currentModel = (): string | undefined =>
    client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined

  await expect(client.prompt(id, [{ type: "text", text: "继续" }])).rejects.toThrow()

  await client.setConfig(id, "model", "gpt-6.1-luna")
  expect(currentModel()).toBe("gpt-6.1-luna")
  expect(client.pendingModelFor(id)).toBeNull()
})

/** A session opened straight off a shared config.toml: no per-model metadata to overwrite it. */
function bareCatalog(model: string, effort: string, offered: string[]): Session["configOptions"] {
  return [
    {
      configId: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: model,
      options: [
        {
          groupId: "chatgpt",
          name: "ChatGPT",
          options: offered.map((id) => ({ value: id, name: id }))
        }
      ]
    },
    {
      configId: "reasoning_effort",
      category: "thought_level",
      name: "Effort",
      type: "select",
      currentValue: effort,
      options: ["low", "medium", "high"].map((level) => ({ value: level, name: level }))
    }
  ]
}

test("a turn repairs an illegal effort inherited from the shared config.toml", async () => {
  // The real 2026-11-05 config had `model_reasoning_effort = "meduim"`. With no published
  // per-model default, applyDefaultEffort leaves it alone and the backend answers 400 on every
  // native turn. The last gate before prompt must replace it with a level the model publishes.
  const { client, fake } = await make()
  let effort = "meduim"
  const catalog = (): Session["configOptions"] => bareCatalog("gpt-6.1-sol", effort, ["gpt-6.1-sol"])
  fake.sessionOptions.current = catalog
  fake.configResponse.current = (request) => {
    if (request.configId === "reasoning_effort") effort = String(request.value)
    return { configOptions: catalog() }
  }
  const id = await client.newSession("/tmp/shared-config-effort")
  expect(client.effortOf(id)).toBe("meduim")
  await client.prompt(id, [{ type: "text", text: "继续" }])
  expect(client.effortOf(id)).toBe("medium")
})

test("a turn moves off a withdrawn default model before it reaches the backend", async () => {
  // config.toml still named gpt-6.1-terra after the provider withdrew it. Codex accepts the id,
  // so nothing errors locally; the upstream then reports capacity for a model that cannot run.
  const { client, fake } = await make()
  let model = "gpt-6.1-terra"
  const catalog = (): Session["configOptions"] =>
    bareCatalog(model, "medium", ["gpt-6.1-sol", "gpt-6.1-luna"])
  fake.sessionOptions.current = catalog
  fake.configResponse.current = (request) => {
    if (request.configId === "model") model = String(request.value)
    return { configOptions: catalog() }
  }
  const id = await client.newSession("/tmp/withdrawn-default")
  await client.prompt(id, [{ type: "text", text: "继续" }])
  expect(client.session(id).configOptions.find((entry) => entry.configId === "model")?.currentValue).toBe(
    "gpt-6.1-sol"
  )
})

test("Stop drops the message queued behind the turn instead of sending it next", async () => {
  // "queued" send mode holds a message until the running turn settles. Without clearing it here,
  // pressing Stop is immediately followed by that message going out — the extra round nobody asked
  // for. The composer puts the cancelled text back in the input, so nothing is lost.
  const { client } = await make()
  const id = await client.newSession("/tmp/stop-queue")
  const internals = client as unknown as {
    holds: (sessionId: string) => boolean
    session: (sessionId: string) => Session
  }
  vi.spyOn(internals, "holds").mockReturnValue(true)
  const real = client.session(id)
  vi.spyOn(internals, "session").mockImplementation(() => ({ ...real, state: "running" }) as Session)

  setQueueSendMode("queued")
  const pending = client.prompt(id, [{ type: "text", text: "下一轮" }])
  await vi.waitFor(() => expect(queuedPromptCount(id)).toBe(1))

  await client.cancel(id)
  await expect(pending).rejects.toBeInstanceOf(QueueCancelledError)
  expect(queuedPromptCount(id)).toBe(0)
  setQueueSendMode("immediate")
})

test("a stale Runtime 'running' entry does not wedge a parked model switch", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium"], defaultEffort: "medium" },
    { id: "deepseek-flash", groupId: "deepseek", efforts: ["low", "high"], defaultEffort: "low" }
  ]
  let switchedTo: Array<{ model: string; effort: string }> = []
  const { client, fake } = await make((fake) => {
    switchedTo = configureReasoningModels(fake, models, "gpt-6.1-sol", "medium").switchedTo
  })
  const configured = must(fake.configResponse.current, "missing config handler")
  let turnRunning = false
  fake.configResponse.current = (request) => {
    if (request.configId === "model" && turnRunning)
      throw RequestError.invalidRequest({ sessionId: request.sessionId }, "Wait for the current turn to finish")
    return configured(request)
  }
  const id = await client.newSession("/tmp/park-stale")
  const currentModel = (): string | undefined =>
    client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "running" })
  turnRunning = true
  await client.setConfig(id, "model", "deepseek-flash")
  expect(client.pendingModelFor(id)).toBe("deepseek-flash")

  // The turn dies with the engine: this conversation reads idle again, but the Runtime's mirror
  // keeps the old "running" row and nothing will ever clear it. Liveness has to expire by itself.
  turnRunning = false
  client.applyRunStates([
    {
      sessionId: id,
      state: "running",
      reusableDraft: false,
      owner: "stdio",
      cwd: "/tmp/park-stale",
      title: "Parked",
      since: Date.now() - 5 * 60_000,
      lastActivityAt: Date.now() - 5 * 60_000,
      version: 1,
      interruption: null,
      tasks: [],
      listeningPorts: [],
      executionId: null,
      executionRole: null
    }
  ])
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "idle" })

  await until(() => currentModel() === "deepseek-flash")
  expect(client.pendingModelFor(id)).toBeNull()
  expect(switchedTo.filter((entry) => entry.model === "deepseek-flash")).toHaveLength(1)
})

test("a Runtime row that keeps ticking never holds a parked switch past the stale window", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium"], defaultEffort: "medium" },
    { id: "deepseek-flash", groupId: "deepseek", efforts: ["low", "high"], defaultEffort: "low" }
  ]
  let switchedTo: Array<{ model: string; effort: string }> = []
  const { client, fake } = await make((fake) => {
    switchedTo = configureReasoningModels(fake, models, "gpt-6.1-sol", "medium").switchedTo
  })
  const configured = must(fake.configResponse.current, "missing config handler")
  let turnRunning = false
  fake.configResponse.current = (request) => {
    if (request.configId === "model" && turnRunning)
      throw RequestError.invalidRequest({ sessionId: request.sessionId }, "Wait for the current turn to finish")
    return configured(request)
  }
  const id = await client.newSession("/tmp/park-heartbeat")
  const currentModel = (): string | undefined =>
    client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined
  const runRow = (): Parameters<typeof client.applyRunStates>[0][number] => ({
    sessionId: id,
    state: "running",
    reusableDraft: false,
    owner: "stdio",
    cwd: "/tmp/park-heartbeat",
    title: "Parked",
    since: Date.now() - 5 * 60_000,
    // The Runtime refreshes this stamp on every republish: it is a heartbeat, not evidence of work.
    lastActivityAt: Date.now(),
    version: 1,
    interruption: null,
    tasks: [],
    listeningPorts: [],
    executionId: null,
    executionRole: null
  })
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "running" })
  turnRunning = true
  client.applyRunStates([runRow()])
  await client.setConfig(id, "model", "deepseek-flash")
  expect(client.pendingModelFor(id)).toBe("deepseek-flash")

  // The turn is over: the conversation reads idle, yet the Runtime keeps republishing the same
  // "running" row with a fresh stamp. A switch must not wait on that row forever.
  turnRunning = false
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "idle" })
  client.applyRunStates([runRow()])
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(client.pendingModelFor(id)).toBe("deepseek-flash")

  const clock = vi.spyOn(Date, "now")
  try {
    clock.mockReturnValue(Date.now() + 2 * 60_000)
    client.applyRunStates([runRow()])
    await until(() => currentModel() === "deepseek-flash")
  } finally {
    clock.mockRestore()
  }
  expect(client.pendingModelFor(id)).toBeNull()
  expect(switchedTo.filter((entry) => entry.model === "deepseek-flash")).toHaveLength(1)
})

test("a per-model effort override wins over the catalog default", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium", "high", "max"], defaultEffort: "medium" }
  ]
  const { client } = await make((fake) => {
    configureReasoningModels(fake, models, "gpt-6.1-sol", "low")
  })
  // The settings window's per-model default effort (mirrored into localStorage). The engine
  // test environment has no DOM storage, so install a minimal one for this case.
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  } as Storage
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
  storage.setItem(
    "alwith:native-model-overrides",
    JSON.stringify([{ api_id: "gpt-6.1-sol", label: "6.1 Sol", enabled: true, defaultReasoningLevel: "max" }])
  )
  try {
    const id = await client.newSession("/tmp/override-effort")
    await until(() => client.effortOf(id) === "max")
    expect(client.effortOf(id)).toBe("max")
  } finally {
    store.clear()
    Reflect.deleteProperty(globalThis, "localStorage")
  }
})

test("an enterprise (account-managed) model defaults to the 大模型-page reasoning level", async () => {
  // The company model's default thinking level is configured on the 大模型 page (stored in
  // `companyModelConfig`), independent of the gateway catalog's own default. Here the catalog says
  // "high" but the configured level is "low" — the conversation must open on the configured level,
  // not the gateway's "high" and not the global "medium" fallback.
  const models: ReasoningModelFixture[] = [
    { id: "gateway:finture-enterprise:company", groupId: "finture-enterprise", efforts: ["low", "high", "max"], defaultEffort: "high" }
  ]
  const { client } = await make((fake) => {
    configureReasoningModels(fake, models, "gateway:finture-enterprise:company", "high")
  })
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  } as Storage
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
  storage.setItem("alwith:company-model", JSON.stringify({ reasoningLevel: "low" }))
  try {
    const id = await client.newSession("/tmp/enterprise-default-effort")
    await until(() => client.effortOf(id) === "low")
    expect(client.effortOf(id)).toBe("low")
  } finally {
    store.clear()
    Reflect.deleteProperty(globalThis, "localStorage")
  }
})

test("switching models in a running chat lands on the new model's configured effort", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium", "high", "max"], defaultEffort: "max" },
    { id: "gpt-6-luna", groupId: "chatgpt", efforts: ["low", "medium", "high", "max"], defaultEffort: "max" }
  ]
  const { client } = await make((fake) => {
    configureReasoningModels(fake, models, "gpt-6.1-sol", "max")
  })
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  } as Storage
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
  // Settings → 大模型: 6 Luna is pinned to medium while 6.1 Sol runs at max.
  storage.setItem(
    "alwith:native-model-overrides",
    JSON.stringify([
      { api_id: "gpt-6.1-sol", label: "6.1 Sol", enabled: true, defaultReasoningLevel: "max" },
      { api_id: "gpt-6-luna", label: "6 Luna", enabled: true, defaultReasoningLevel: "medium" }
    ])
  )
  try {
    const id = await client.newSession("/tmp/switch-effort")
    await until(() => client.effortOf(id) === "max")
    // The adapter keeps an effort the new model also publishes, which is why the chat sat on Max.
    await client.setConfig(id, "model", "gpt-6-luna")
    await until(() => client.effortOf(id) === "medium")
    expect(client.effortOf(id)).toBe("medium")
  } finally {
    store.clear()
    Reflect.deleteProperty(globalThis, "localStorage")
  }
})

test("a new conversation starts on the model's own default effort, not the agent global default", async () => {
  // The agent opens the thread on "low" (its global config); the model's catalog says "max".
  // Without the catalog fallback the picker sat on Low even though every model defaulted to Max.
  const models: ReasoningModelFixture[] = [
    { id: "deepseek-flash", groupId: "deepseek", efforts: ["low", "high", "max"], defaultEffort: "max" }
  ]
  let switchedTo: Array<{ model: string; effort: string }> = []
  const { client } = await make((fake) => {
    switchedTo = configureReasoningModels(fake, models, "deepseek-flash", "low").switchedTo
  })
  const id = await client.newSession("/tmp/default-effort")
  await until(() => client.effortOf(id) === "max")
  expect(client.effortOf(id)).toBe("max")
  // The agent's own initial "low" was overridden exactly once, by the catalog default.
  expect(switchedTo).toEqual([])
})

test("a parked switch waits for the runtime's run state, not only the session state", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "deepseek-flash", groupId: "deepseek", efforts: ["low", "high"], defaultEffort: "low" }
  ]
  let switchedTo: Array<{ model: string; effort: string }> = []
  const { client, fake } = await make((fake) => {
    switchedTo = configureReasoningModels(fake, models, "gpt-6.1-sol", "medium").switchedTo
  })
  const id = await client.newSession("/tmp/park-race")
  const currentModel = (): string | undefined =>
    client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined
  const runState = (state: "running" | "idle", version: number): void => {
    client.applyRunStates([
      {
        sessionId: id,
        state,
        reusableDraft: false,
        owner: "stdio",
        cwd: "/tmp/park-race",
        title: "",
        since: 0,
        lastActivityAt: 0,
        version,
        interruption: null,
        tasks: [],
        listeningPorts: [],
        executionId: null,
        executionRole: null
      }
    ])
  }
  // The prompt is dispatched: the runtime already reports the turn, the session state lags.
  runState("running", 1)
  const configured = must(fake.configResponse.current, "missing config handler")
  let turnRunning = true
  fake.configResponse.current = (request) => {
    if (request.configId === "model" && turnRunning)
      throw RequestError.invalidRequest({ sessionId: request.sessionId }, "Wait for the current turn to finish")
    return configured(request)
  }
  // The write is attempted but rejected; the choice is parked, nothing lands.
  await client.setConfig(id, "model", "deepseek-flash")
  expect(switchedTo.filter((entry) => entry.model === "deepseek-flash")).toEqual([])
  expect(client.pendingModelFor(id)).toBe("deepseek-flash")

  // The session state alone says idle; the runtime still holds the turn, so the write stays parked.
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "idle" })
  await until(() => client.session(id).state === "idle")
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(switchedTo.filter((entry) => entry.model === "deepseek-flash")).toEqual([])
  expect(client.pendingModelFor(id)).toBe("deepseek-flash")

  // The runtime releases the turn; the parked choice lands.
  turnRunning = false
  runState("idle", 2)
  await until(() => currentModel() === "deepseek-flash")
  expect(client.pendingModelFor(id)).toBeNull()
})

test("the next prompt flushes a parked switch so the turn uses the new gateway", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "deepseek-flash", groupId: "deepseek", efforts: ["low", "high"], defaultEffort: "low" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "gpt-6.1-sol", "medium"))
  const id = await client.newSession("/tmp/park-flush")
  const currentModel = (): string | undefined =>
    client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined
  let releaseWrite!: () => void
  const writeHeld = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  let holding = false
  fake.configDelay.current = async () => {
    if (!holding) return
    await writeHeld
  }
  const configured = must(fake.configResponse.current, "missing config handler")
  let turnRunning = false
  fake.configResponse.current = (request) => {
    if (request.configId === "model" && turnRunning)
      throw RequestError.invalidRequest({ sessionId: request.sessionId }, "Wait for the current turn to finish")
    return configured(request)
  }
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "running" })
  turnRunning = true
  await client.setConfig(id, "model", "deepseek-flash")
  expect(client.pendingModelFor(id)).toBe("deepseek-flash")

  // The turn ends and the parked write starts, held inside the agent.
  turnRunning = false
  holding = true
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "idle" })
  await until(() => fake.events.some((event) => event.type === "config" && event.request.configId === "model"))
  // Sending immediately must wait for that write: the turn goes to the new gateway.
  const sending = client.prompt(id, [{ type: "text", text: "next" }])
  await new Promise((resolve) => setTimeout(resolve, 20))
  releaseWrite()
  await sending
  expect(currentModel()).toBe("deepseek-flash")
  expect(fake.prompts.at(-1)).toBe("next")
  // The write reached the agent before the prompt it routes.
  const configAt = fake.events.findIndex((event) => event.type === "config" && event.request.configId === "model")
  const promptAt = fake.events.findIndex((event) => event.type === "prompt")
  expect(configAt).toBeGreaterThanOrEqual(0)
  expect(promptAt).toBeGreaterThan(configAt)
})

test("a newer explicit pick supersedes a parked switch", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "deepseek-flash", groupId: "deepseek", efforts: ["low", "high"], defaultEffort: "low" },
    { id: "qwen-max", groupId: "qwen", efforts: ["low", "high"], defaultEffort: "low" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "gpt-6.1-sol", "medium"))
  const id = await client.newSession("/tmp/park-supersede")
  const currentModel = (): string | undefined =>
    client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined
  const configured = must(fake.configResponse.current, "missing config handler")
  let turnRunning = false
  fake.configResponse.current = (request) => {
    if (request.configId === "model" && turnRunning)
      throw RequestError.invalidRequest({ sessionId: request.sessionId }, "Wait for the current turn to finish")
    return configured(request)
  }
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "running" })
  turnRunning = true
  await client.setConfig(id, "model", "deepseek-flash")
  expect(client.pendingModelFor(id)).toBe("deepseek-flash")
  // While still running the user changes their mind: the newest choice replaces the parked one.
  await client.setConfig(id, "model", "qwen-max")
  expect(client.pendingModelFor(id)).toBe("qwen-max")
  turnRunning = false
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "idle" })
  await until(() => currentModel() === "qwen-max")
  expect(currentModel()).toBe("qwen-max")
  expect(client.pendingModelFor(id)).toBeNull()
})

test("a new conversation starts on the model row's default effort", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "deepseek-flash", groupId: "deepseek", efforts: ["low", "high"], defaultEffort: "low" }
  ]
  const { client, fake } = await make(
    (fake) => configureReasoningModels(fake, models, "gpt-6.1-sol", "low"),
    undefined,
    { defaultEffort: () => "high" }
  )
  // 设置 → 可用模型 owns the per-model level; the global choice only covers models that publish
  // none of their own. The engine opened on its own "low", so the row's medium is written once.
  const draft = await client.prepareDraft("main", "/tmp/default-effort")
  await until(() => client.effortOf(draft) === "medium")
  expect(client.effortOf(draft)).toBe("medium")
  // The write went through the agent under the id it actually serves, and it was persisted with
  // the selection rather than racing the confirmation.
  expect(fake.events.filter((event) => event.type === "config").map((event) => event.request)).toEqual([
    { configId: "reasoning_effort", sessionId: draft, type: "id", value: "medium" }
  ])
  // An explicit pick still overrides the default for that conversation.
  await client.setConfig(draft, "effort", "low")
  expect(client.effortOf(draft)).toBe("low")
})

test("a default effort the model does not publish is skipped", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" }
  ]
  const { client, fake } = await make(
    (fake) => configureReasoningModels(fake, models, "gpt-6.1-sol", "medium"),
    undefined,
    { defaultEffort: () => "max" }
  )
  const id = await client.newSession("/tmp/default-effort-unsupported")
  // Never invent a level the agent would reject: the model's own default applies instead.
  expect(client.effortOf(id)).toBe("medium")
  expect(fake.events.filter((event) => event.type === "config")).toEqual([])
})

test("several gateways register under their own ids and can be removed one at a time", async () => {
  const { client, fake, port } = await make()
  await registerGateway(port, {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/",
    bearerToken: "sk-a",
    models: [{ id: "deepseek-flash", label: "DeepSeek-Flash" }],
    config: {}
  })
  await registerGateway(port, {
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    bearerToken: "xai-b",
    models: [{ id: "grok-4.6", label: "Grok 4.6" }],
    config: {}
  })
  expect([...fake.gateways.keys()]).toEqual(["deepseek", "xai"])

  // Every session's model option carries one group per gateway after Codex's own.
  const id = await client.newSession("/tmp/g")
  const option = client.session(id).configOptions.find((entry) => entry.configId === "model")
  if (option === undefined || !isSelectOption(option)) throw new Error("model option missing")
  const groupIds = option.options.map((group) => ("groupId" in group ? group.groupId : ""))
  expect(groupIds).toEqual(["chatgpt", "deepseek", "xai"])

  // A model of the second gateway counts as a gateway model.
  const seen: Array<[string, boolean]> = []
  client.onSessionModel((_sessionId, modelId, isGateway) => seen.push([modelId, isGateway]))
  const moved = await client.newSession("/tmp/x", "grok-4.6")
  expect(fake.modelHints.get(moved)).toBe("grok-4.6")
  expect(seen.at(-1)).toEqual(["grok-4.6", true])

  await unregisterGateway(port, "xai")
  expect([...fake.gateways.keys()]).toEqual(["deepseek"])
  expect(fake.gateway.current).not.toBeNull()
  await unregisterGateway(port, "deepseek")
  expect(fake.gateway.current).toBeNull()
})

test("rename, account, rate limits and file search pass through the adapter's _codex methods", async () => {
  const { client, fake } = await make()
  await client.listSessions({ reset: true })
  await client.renameSession("h1", "Renamed")
  expect(fake.renamed.get("h1")).toBe("Renamed")
  expect(client.state.sessionList.find((sessionRow) => sessionRow.sessionId === "h1")?.title).toBe("Renamed")

  const account = await client.readAccount()
  expect(account.account).toEqual({ type: "chatgpt", email: "ny@example.com", planType: "plus" })
  const limits = await client.readRateLimits()
  expect(limits.primary?.usedPercent).toBe(40)

  const seen: number[] = []
  const stop = client.onRateLimits((update) => seen.push(update.primary?.usedPercent ?? -1))
  await fake.pushRateLimits(65)
  await until(() => seen.length === 1)
  expect(seen).toEqual([65])
  stop()

  const found = await client.fuzzyFileSearch({ query: "client", roots: ["/tmp/one"] })
  expect(fake.fileSearches).toEqual(["client"])
  expect(found.files.map((file) => file.path)).toEqual(["src/agent/client.ts"])
})

test("the user's message is on screen before Codex reports it; the receipt claims it, the echo adopts it", async () => {
  const { client } = await make()
  const id = await client.newSession("/tmp/a")
  const sending = client.prompt(id, [{ type: "text", text: "shown at once" }])
  const local = client.session(id).items.find((item) => item.kind === "user")
  expect(local?.kind === "user" ? local.echo : null).toBe("pending")
  await sending
  const claimed = client.session(id).items.find((item) => item.kind === "user")
  expect(claimed?.id).toBe("u")
  expect(claimed?.kind === "user" ? claimed.echo : null).toMatch(/^(acknowledged|adopted)$/)
  await until(() => client.session(id).state === "idle")
  const users = client.session(id).items.filter((item) => item.kind === "user")
  expect(users).toHaveLength(1)
  expect(users[0]?.id).toBe("u")
  expect(users[0]?.kind === "user" ? users[0].echo : null).toBe("adopted")
})

test("Stop answers the session's pending permission with cancelled before session/cancel — no zombie prompt on the next attach", async () => {
  const { client } = await make()
  const id = await client.newSession("/tmp/a")
  await client.prompt(id, [{ type: "text", text: "permission" }])
  await until(() => client.state.actions.length === 1)
  await client.cancel(id)
  expect(client.state.actions).toEqual([])
  await until(() => client.session(id).state === "idle")
  const reply = client.session(id).items.find((item) => item.kind === "assistant")
  // the fake echoes the answer it got as JSON text
  expect(JSON.stringify(reply)).toContain("cancelled")
})

test("precreated drafts expose real models without entering thread indexes", async () => {
  const { client, fake } = await make()
  const [first, duplicate] = await Promise.all([
    client.prepareDraft("main", "/tmp/draft"),
    client.prepareDraft("main", "/tmp/draft")
  ])
  expect(duplicate).toBe(first)
  expect(fake.modelHints.size).toBe(1)
  expect(client.session(first).configOptions[0]?.currentValue).toBe("gpt-6.1-sol")
  expect(client.state.draftSessions[first]).toBe("main")
  fake.listSessions.current = () => ({ sessions: [{ sessionId: first, cwd: "/tmp/draft" }] })
  await client.listSessions({ reset: true })
  expect(client.state.sessionList).toEqual([])
  expect(await client.listProjectSessions("/tmp/draft")).toEqual([])
  await client.prompt(first, [{ type: "text", text: "hello" }])
  expect(client.state.draftSessions[first]).toBeUndefined()
  expect(client.state.sessionList.some((sessionRow) => sessionRow.sessionId === first)).toBe(true)
  await client.discardDraft("main")
  expect(fake.deleted.has(first)).toBe(false)
})

test("draft replacement preserves the old session on failure and transfers ownership", async () => {
  const { client, fake } = await make()
  const first = await client.prepareDraft("main", "/tmp/a")
  await expect(client.prepareDraft("main", "/needs-auth")).rejects.toThrow()
  expect(client.state.draftSessions[first]).toBe("main")
  expect(fake.deleted.has(first)).toBe(false)
  const replacement = await client.prepareDraft("main", "/tmp/b")
  expect(fake.deleted.has(first)).toBe(true)
  expect(client.session(replacement).cwd).toBe("/tmp/b")
  await client.transferDraft(replacement, "chat")
  await client.discardDraft("main")
  expect(fake.deleted.has(replacement)).toBe(false)
  expect(await client.prepareDraft("chat", "/tmp/b")).toBe(replacement)
  await client.discardDraft("chat")
  expect(fake.deleted.has(replacement)).toBe(true)
})

test("changing an empty draft's model creates it on that model without resuming the default model", async () => {
  const { client, fake } = await make()
  const first = await client.prepareDraft("main", "/tmp/model-draft")
  const replacement = await client.prepareDraft("main", "/tmp/model-draft", "deepseek-flash")
  expect(replacement).not.toBe(first)
  expect(fake.modelHints.get(replacement)).toBe("deepseek-flash")
  expect(fake.configChanges).toEqual([])
  expect(fake.deleted.has(first)).toBe(true)
  expect(client.state.draftSessions[replacement]).toBe("main")
  expect(await client.prepareDraft("main", "/tmp/model-draft", "deepseek-flash")).toBe(replacement)
  expect(client.state.sessionList).toEqual([])
  await client.prompt(replacement, [{ type: "text", text: "hello" }])
  expect(client.session(replacement).items.some((item) => item.kind === "user")).toBe(true)
})

test("failed draft model creation preserves the original draft for retry", async () => {
  const { client, fake } = await make()
  const first = await client.prepareDraft("main", "/tmp/model-failure")
  fake.newSessionDelay.current = () => {
    return Promise.try(() => {
      throw new Error("Gateway unavailable")
    })
  }
  await expect(client.prepareDraft("main", "/tmp/model-failure", "deepseek-flash")).rejects.toThrow()
  expect(client.state.draftSessions[first]).toBe("main")
  expect(fake.deleted.has(first)).toBe(false)
  fake.newSessionDelay.current = null
  const replacement = await client.prepareDraft("main", "/tmp/model-failure", "deepseek-flash")
  expect(fake.modelHints.get(replacement)).toBe("deepseek-flash")
})

test.each([false, true])(
  "draft model replacement preserves compatible settings and rolls back on setting failure (%s)",
  async (fail) => {
    const settings = [
      {
        configId: "mode",
        category: "mode",
        name: "Mode",
        type: "select",
        currentValue: "read-only",
        options: [
          { value: "read-only", name: "Read only" },
          { value: "auto", name: "Auto" }
        ]
      },
      {
        configId: "effort",
        category: "thought_level",
        name: "Effort",
        type: "select",
        currentValue: "high",
        options: [{ value: "high", name: "High" }]
      },
      { configId: "fast", category: "model_config", name: "Fast", type: "boolean", currentValue: true }
    ] satisfies [SelectOption, SelectOption, BooleanOption]
    let targetOptions: Session["configOptions"] = [
      {
        configId: "model",
        category: "model",
        name: "Model",
        type: "select",
        currentValue: "deepseek-flash",
        options: [{ value: "deepseek-flash", name: "Flash" }]
      },
      { ...settings[0], currentValue: "auto" },
      {
        configId: "effort",
        category: "thought_level",
        name: "Effort",
        type: "select",
        currentValue: "low",
        options: [{ value: "low", name: "Low" }]
      },
      { ...settings[2], currentValue: false }
    ]
    const writes: string[] = []
    const { client, fake } = await make((fake) => {
      fake.sessionOptions.current = (model) => (model === "deepseek-flash" ? targetOptions : settings)
      fake.configResponse.current = (params) => {
        if (fail) throw new Error("Cannot apply settings")
        writes.push(params.configId)
        targetOptions = targetOptions.map((option) =>
          option.configId === params.configId
            ? ({ ...option, currentValue: params.value } as Session["configOptions"][number])
            : option
        )
        return { configOptions: targetOptions }
      }
    })
    const first = await client.prepareDraft("main", "/tmp/settings")
    const replacement = client.prepareDraft("main", "/tmp/settings", "deepseek-flash")
    if (fail) {
      await expect(replacement).rejects.toThrow()
      expect(fake.deleted.has(first)).toBe(false)
      expect(fake.deleted.has("s1")).toBe(true)
      expect(client.state.draftSessions[first]).toBe("main")
    } else {
      const id = await replacement
      expect(id).not.toBe(first)
      expect(writes).toEqual(["mode", "fast"])
      expect(
        client
          .session(id)
          .configOptions.filter((option) => option.category !== "model")
          .map((option) => option.currentValue)
      ).toEqual(["read-only", "low", true])
      expect(fake.deleted.has(first)).toBe(true)
    }
  }
)

test("a delayed main draft does not block preparation in the floating window", async () => {
  const { client, fake } = await make()
  let release!: () => void
  fake.newSessionDelay.current = (cwd) =>
    cwd === "/tmp/slow-main"
      ? new Promise((resolve) => {
          release = resolve
        })
      : Promise.resolve()
  const main = client.prepareDraft("main", "/tmp/slow-main")
  await until(() => release !== undefined)
  const floating = await client.prepareDraft("chat", "/tmp/floating")
  expect(client.state.draftSessions[floating]).toBe("chat")
  release()
  const mainId = await main
  expect(client.state.draftSessions[mainId]).toBe("main")
})

test("a replacement waits for the draft's pending model before inheriting it", async () => {
  const { client, fake } = await make()
  const source = await client.prepareDraft("main", "/tmp/source")
  let release!: () => void
  fake.configDelay.current = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const config = client.setConfig(source, "model", "chosen-model")
  await until(() => release !== undefined)
  const replacement = client.prepareDraft("main", "/tmp/replacement")
  release()
  await config
  const id = await replacement
  expect(fake.modelHints.get(id)).toBe("chosen-model")
  expect(client.session(id).configOptions[0]?.currentValue).toBe("chosen-model")
})

test("a draft submitted during transfer can never regain deletion eligibility", async () => {
  const { client, fake } = await make()
  const source = await client.prepareDraft("main", "/tmp/source")
  const target = await client.prepareDraft("chat", "/tmp/target")
  const originalDelete = client.delete.bind(client)
  let release: (() => void) | undefined
  const deleting = vi.spyOn(client, "delete").mockImplementation(async (id) => {
    if (id === target)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    await originalDelete(id)
  })
  try {
    const transfer = client.transferDraft(source, "chat")
    await until(() => release !== undefined)
    await client.prompt(source, [{ type: "text", text: "retain this conversation" }])
    must(release, "pending draft cleanup")()
    await transfer
    expect(client.state.draftSessions[source]).toBeUndefined()
    await client.discardDraft("chat")
    expect(fake.deleted.has(source)).toBe(false)
    expect(client.state.sessions[source]).toBeDefined()
  } finally {
    release?.()
    deleting.mockRestore()
  }
})

test("prompt waits for the model transaction and a failed switch rejects its waiting prompt", async () => {
  const { client, fake } = await make()
  const id = await client.newSession("/tmp/model-order")
  let finish!: () => void
  fake.configDelay.current = () =>
    new Promise<void>((resolve) => {
      finish = resolve
    })
  const change = client.setConfig(id, "model", "chosen-model")
  await until(() => finish !== undefined)
  const sending = client.prompt(id, [{ type: "text", text: "hello" }])
  await Promise.resolve()
  expect(client.session(id).items).toEqual([])
  finish()
  await Promise.all([change, sending])
  expect(client.session(id).configOptions[0]?.currentValue).toBe("chosen-model")

  const other = await client.newSession("/tmp/failed-switch")
  let reject!: (error: Error) => void
  fake.configDelay.current = () =>
    new Promise<void>((_resolve, fail) => {
      reject = fail
    })
  const failed = client.setConfig(other, "model", "broken-model")
  await until(() => reject !== undefined)
  const queuedConfig = client.setConfig(other, "model", "another-model")
  const waiting = client.prompt(other, [{ type: "text", text: "must not send" }])
  const results = Promise.allSettled([failed, queuedConfig, waiting])
  fake.configDelay.current = null
  reject(new Error("model unavailable"))
  expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"])
  expect(client.session(other).items).toEqual([])
})

test.each(["archive", "delete", "rename"] as const)("a pending list cannot undo %s", async (action) => {
  const { client, fake } = await make()
  await client.listSessions()
  let answer: ((value: { sessions: Array<{ sessionId: string; cwd: string; title: string }> }) => void) | undefined
  fake.listSessions.current = () =>
    new Promise((resolve) => {
      answer = resolve
    })
  const pending = client.listSessions({ reset: true })
  await until(() => answer !== undefined)
  if (action === "rename") await client.renameSession("h1", "New title")
  else await client[action]("h1")
  must(answer, "pending list response")({ sessions: [{ sessionId: "h1", cwd: "/tmp/one", title: "Old title" }] })
  await pending
  expect(client.state.sessionList.map((sessionRow) => [sessionRow.sessionId, sessionRow.title])).toEqual(
    action === "rename" ? [["h1", "New title"]] : []
  )
  expect(client.state.archivedSessions.map((sessionRow) => sessionRow.sessionId)).toEqual(action === "archive" ? ["h1"] : [])
})

test("a pending archived list cannot undo restore", async () => {
  const { client, fake } = await make()
  await client.listArchived()
  let answer:
    | ((value: {
        sessions: Array<{ sessionId: string; cwd: string; _meta: { codex: { archived: boolean } } }>
      }) => void)
    | undefined
  fake.listSessions.current = () =>
    new Promise((resolve) => {
      answer = resolve
    })
  const pending = client.listArchived({ reset: true })
  await until(() => answer !== undefined)
  await client.unarchive("h2")
  must(
    answer,
    "pending list response"
  )({ sessions: [{ sessionId: "h2", cwd: "/tmp/two", _meta: { codex: { archived: true } } }] })
  await pending
  expect(client.state.archivedSessions).toEqual([])
  expect(client.state.sessionList.map((sessionRow) => sessionRow.sessionId)).toEqual(["h2"])
})

test("concurrent refreshes share one request and loading state", async () => {
  const { client, fake } = await make()
  let answer!: (value: { sessions: Array<{ sessionId: string; cwd: string }> }) => void
  fake.listSessions.current = () =>
    new Promise((resolve) => {
      answer = resolve
    })
  const first = client.listSessions({ reset: true })
  await until(() => answer !== undefined)
  const second = client.listSessions({ reset: true })
  expect(first).toBe(second)
  expect(client.state.sessionListLoading).toBe(true)
  expect(fake.fullListRequests).toHaveLength(1)
  answer({ sessions: [{ sessionId: "new", cwd: "/tmp/one" }] })
  await Promise.all([first, second])
  expect(client.state.sessionList.map((sessionRow) => sessionRow.sessionId)).toEqual(["new"])
  expect(client.state.sessionListLoading).toBe(false)
})

test("live user messages refresh recency, while history replay and older turns do not", async () => {
  const { client, fake } = await make()
  const original = "2026-01-01T00:00:00.000Z"
  const current = "2026-10-10T10:00:00.000Z"
  fake.listSessions.current = () => ({ sessions: [{ sessionId: "h1", cwd: "/tmp/one", updatedAt: original }] })
  await client.listSessions()
  await client.open("h1", "/tmp/one")
  expect(client.state.sessionList[0]?.updatedAt).toBe(original)
  await fake.pushUpdate("h1", {
    sessionUpdate: "user_message",
    messageId: "live",
    content: [{ type: "text", text: "continue" }],
    _meta: { codex: { turnStartedAt: Date.parse(current) } }
  })
  await until(() => client.session("h1").items.some((item) => item.id === "live"))
  expect(client.state.sessionList[0]?.updatedAt).toBe(current)
  await fake.pushUpdate("h1", {
    sessionUpdate: "user_message",
    messageId: "older",
    content: [{ type: "text", text: "earlier" }],
    _meta: { codex: { turnStartedAt: Date.parse(original) } }
  })
  await until(() => client.session("h1").items.some((item) => item.id === "older"))
  expect(client.state.sessionList[0]?.updatedAt).toBe(current)
})

test("deleted-project aliases share the same complete memory list", async () => {
  const { client, fake } = await make(undefined, macProjectPaths)
  const canonical = "/private/var/deleted/project"
  const alias = "/var/deleted/project"
  fake.listSessions.current = () => ({
    sessions: [
      { sessionId: "one", cwd: alias },
      { sessionId: "two", cwd: canonical }
    ]
  })
  await client.listSessions()
  const before = client.state
  const result = await client.listProjectSessions(canonical)
  expect(result.map((sessionRow) => sessionRow.cwd)).toEqual([canonical, canonical])
  expect(await client.listProjectSessions(`${alias}/`)).toEqual(result)
  expect(client.state).toBe(before)
  expect(fake.fullListRequests).toHaveLength(1)
})

test("new and explicitly included chats use the same project key as history", async () => {
  const { client } = await make(undefined, macProjectPaths)
  await client.newSession("/var/new-project")
  client.includeSession({
    sessionId: "historical",
    cwd: "/var/new-project",
    title: "Old",
    updatedAt: null,
    archived: false
  })
  expect(client.state.sessionList.map((sessionRow) => sessionRow.cwd)).toEqual([
    "/private/var/new-project",
    "/private/var/new-project"
  ])
})

test("hosts without macOS aliases preserve distinct private and non-private directories", async () => {
  const { client, fake } = await make()
  fake.listSessions.current = () => ({
    sessions: [
      { sessionId: "one", cwd: "/var/project" },
      { sessionId: "two", cwd: "/private/var/project" }
    ]
  })
  await client.listSessions()
  expect(client.state.sessionList.map((sessionRow) => sessionRow.cwd)).toEqual(["/var/project", "/private/var/project"])
  expect((await client.listProjectSessions("/var/project")).map((sessionRow) => sessionRow.sessionId)).toEqual(["one"])
})

test("plugin enablement uses the adapter extension with an explicit plugin ID", async () => {
  const requests: unknown[] = []
  const { client } = await make((fake) =>
    fake.app.onRequest(
      "_codex/plugin_set_enabled",
      (value) => value as { pluginId: string; enabled: boolean },
      ({ params }) => {
        requests.push(params)
        return { enabled: params.enabled }
      }
    )
  )
  expect(await client.setPluginEnabled("example@market", false)).toEqual({ enabled: false })
  expect(requests).toEqual([{ pluginId: "example@market", enabled: false }])
  expect(await client.setPluginEnabled("supabase@openai-curated-remote", false, "plugin_supabase")).toEqual({
    enabled: false
  })
  expect(requests.at(-1)).toEqual({
    pluginId: "supabase@openai-curated-remote",
    enabled: false,
    remotePluginId: "plugin_supabase"
  })
})

test("tracked prompt receipt names the retained authoritative turn", async () => {
  const { client } = await make()
  const id = await client.newSession("/tmp/voice-receipt")
  const messageId = await client.prompt(id, [{ type: "text", text: "voice" }])
  const prompt = must(client.state.sessions[id], "receipt session").items.find((item) => item.id === messageId)
  expect(prompt?.kind).toBe("user")
  expect(["acknowledged", "adopted"]).toContain(prompt && "echo" in prompt ? prompt.echo : null)
  expect(must(client.state.sessions[id], "receipt session").items.filter((item) => item.kind === "user")).toHaveLength(
    1
  )
  await client.cancel(id)
})

test("composer predictions cross the Runtime extension boundary and keep session ownership", async () => {
  const { client, fake } = await make((fake) => {
    fake.app.onRequest(
      "_codex/session_prediction_request",
      (value) => value as { sessionId: string; sourceTurnId: string },
      ({ params }) => {
        expect(params).toEqual({ sessionId: "s0", sourceTurnId: "turn-1" })
        return {}
      }
    )
  })
  const agent = must(client.state.agent, "agent")
  client.store.setState({
    agent: { ...agent, capabilities: { ...agent.capabilities, _meta: { codex: { composerPredictions: true } } } }
  })
  const first = await client.newSession("/tmp")
  const second = await client.newSession("/tmp")
  await client.requestPrediction(first, "turn-1")
  const prediction = { sourceTurnId: "turn-1", result: { type: "completed", text: "Run tests" } }
  await fake.pushUpdate(first, { sessionUpdate: "session_info_update", _meta: { codex: { prediction } } })
  await until(() => (client.session(first)._meta?.codex as { prediction?: unknown })?.prediction !== undefined)
  expect(client.session(first)._meta).toMatchObject({ codex: { prediction } })
  expect(client.session(second)._meta).not.toMatchObject({ codex: { prediction } })
  expect(client.session(first).state).toBe("idle")
  client.store.setState({ agent: { ...agent, capabilities: {} } })
  await expect(client.requestPrediction(first, "turn-1")).rejects.toThrow("does not support")
})

test("prediction errors propagate without disabling future requests", async () => {
  let calls = 0
  const { client } = await make((fake) => {
    fake.app.onRequest(
      "_codex/session_prediction_request",
      (value) => value as Record<string, unknown>,
      () => {
        calls++
        throw RequestError.internalError(undefined, "Prediction unavailable")
      }
    )
  })
  // Request failures do not change connection capabilities.
  const agent = must(client.state.agent, "agent")
  client.store.setState({ agent: { ...agent, capabilities: { _meta: { codex: { composerPredictions: true } } } } })
  await expect(client.requestPrediction("s", "turn")).rejects.toThrow()
  await expect(client.requestPrediction("s", "turn-2")).rejects.toThrow("Prediction unavailable")
  expect(calls).toBe(2)
})

test("concurrent opens await the same replay and close cancels its request before applying a late response", async () => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  let signal!: AbortSignal
  let calls = 0
  const { client } = await make((fake) => {
    fake.resumeResponse.current = async (current) => {
      calls++
      signal = current
      await gate
      return { configOptions: [] }
    }
  })
  const first = client.open("h1", "/projects/one")
  const firstResult = first.catch((error: unknown) => error)
  await until(() => calls === 1)
  let secondSettled = false
  const second = client.open("h1", "/projects/one").then(
    () => {
      secondSettled = true
    },
    (error: unknown) => {
      secondSettled = true
      return error
    }
  )
  await until(() => calls === 1)
  expect(secondSettled).toBe(false)
  const closing = client.close("h1")
  await until(() => signal.aborted)
  expect(calls).toBe(1)
  finish()
  expect(await firstResult).toMatchObject({ name: "AbortError" })
  expect(await second).toMatchObject({ name: "AbortError" })
  await closing
  expect(client.state.sessions.h1).toBeUndefined()
})

test("a pending receipt does not hold admission and cannot write into a reopened session", async () => {
  const { client, port } = await make()
  const id = await client.newSession("/tmp/receipt-lifetime")
  const original = port.acpRequest.bind(port)
  let respond!: (response: { messageId: string }) => void
  const request = vi.spyOn(port, "acpRequest").mockImplementation((agentId, method, params, options) => {
    if (method === "session/prompt")
      return new Promise((resolve) => {
        respond = resolve
      })
    return original(agentId, method, params, options)
  })
  const sending = client.prompt(id, [{ type: "text", text: "pending receipt" }])
  const outcome = sending.then(
    () => "accepted",
    (error: unknown) => error
  )
  await until(() => respond !== undefined)
  await client.setConfig(id, "model", "chosen-model")
  expect(client.session(id).configOptions[0]?.currentValue).toBe("chosen-model")
  await client.cancel(id)
  await client.close(id)
  await client.open(id, "/tmp/receipt-lifetime")
  const reopened = client.session(id)
  respond({ messageId: "late-receipt" })
  expect(await outcome).toMatchObject({ name: "AgentGoneError" })
  expect(client.session(id)).toBe(reopened)
  request.mockRestore()
})

test("stopping while retaining the transcript retires its pending receipt", async () => {
  const { client, port } = await make()
  const id = await client.newSession("/tmp/stopped-receipt")
  const original = port.acpRequest.bind(port)
  const receipt = Promise.withResolvers<{ messageId: string }>()
  let sent = false
  const request = vi.spyOn(port, "acpRequest").mockImplementation((agentId, method, params, options) => {
    if (method === "session/prompt") {
      sent = true
      return receipt.promise
    }
    return original(agentId, method, params, options)
  })
  try {
    const result = client.prompt(id, [{ type: "text", text: "retained" }]).catch((error: unknown) => error)
    await until(() => sent)
    await client.stopSession(id)
    const stopped = client.session(id)
    expect(stopped.items.some((item) => item.kind === "user")).toBe(true)
    receipt.resolve({ messageId: "retired-receipt" })
    expect(await result).toMatchObject({ name: "AgentGoneError" })
    expect(client.session(id)).toBe(stopped)
  } finally {
    request.mockRestore()
  }
})

test("reconnect releases each Runtime gap subscription", async () => {
  const { client, port } = await make()
  client.disconnect()
  const subscribe = port.onGap.bind(port)
  const releases: ReturnType<typeof vi.fn>[] = []
  const spy = vi.spyOn(port, "onGap").mockImplementation((listener) => {
    const release = vi.fn(subscribe(listener))
    releases.push(release)
    return release
  })
  try {
    await client.connect()
    client.disconnect()
    expect(releases[0]).toHaveBeenCalledTimes(1)
    await client.connect()
    client.disconnect()
    expect(releases[0]).toHaveBeenCalledTimes(1)
    expect(releases[1]).toHaveBeenCalledTimes(1)
  } finally {
    spy.mockRestore()
  }
})

test("writer conflicts still open browsable history and retry without claiming an attachment", async () => {
  let locked = true
  const { client, fake } = await make((fake) => {
    fake.historyResponse.current = () => ({
      sessionId: "locked",
      consistency: "live",
      revision: null,
      nextCursor: null,
      complete: true,
      turns: [
        {
          turnId: "stored",
          itemsView: "full",
          updates: [
            {
              sessionUpdate: "user_message",
              messageId: "stored-user",
              content: [{ type: "text", text: "Readable history" }]
            }
          ]
        }
      ]
    })
    fake.resumeResponse.current = () => {
      if (locked)
        return Promise.reject(
          RequestError.invalidRequest({ reason: "thread_active_writer", threadId: "locked" }, "Session in use")
        )
      return Promise.resolve({})
    }
  })
  await client.open("locked", "/tmp/locked")
  expect(client.session("locked")).toMatchObject({ attached: false, readOnly: true, restoring: false, error: null })
  expect(
    client.session("locked").items.some((item) => item.kind === "user" && textOf(item.content) === "Readable history")
  ).toBe(true)
  expect(fake.historyRequests).toHaveLength(1)
  locked = false
  await client.open("locked", "/tmp/locked")
  expect(client.session("locked")).toMatchObject({ attached: true, readOnly: false, restoring: false })
})

test("a prompt carries the previewed document to the agent but keeps the user bubble clean", async () => {
  const { client, fake } = await make()
  const id = await client.newSession("/tmp/preview-doc")
  setActivePreview({ path: "/tmp/preview-doc/report.md", title: "report.md", root: "/tmp/preview-doc" })
  try {
    await client.prompt(id, [{ type: "text", text: "summarize this" }])
    const received = fake.prompts[fake.prompts.length - 1] ?? ""
    expect(received).toContain("当前预览文档")
    expect(received).toContain("/tmp/preview-doc/report.md")
    expect(received).toContain("summarize this")
    // `display` keeps the optimistic bubble — and its echo — to what the user actually typed.
    const items = client.session(id).items
    expect(items.some((item) => item.kind === "user" && textOf(item.content) === "summarize this")).toBe(true)
    expect(items.some((item) => item.kind === "user" && textOf(item.content).includes("当前预览文档"))).toBe(false)
  } finally {
    setActivePreview(null)
  }
})

test("a prompt in another project never carries the previewed document", async () => {
  const { client, fake } = await make()
  const id = await client.newSession("/tmp/current-project")
  setActivePreview({ path: "/tmp/other-project/report.md", title: "report.md", root: "/tmp/other-project" })
  try {
    await client.prompt(id, [{ type: "text", text: "hello" }])
    expect(fake.prompts[fake.prompts.length - 1]).toBe("hello")
  } finally {
    setActivePreview(null)
  }
})

test("orchestration applies each role pair and restores the main conversation", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "max"], defaultEffort: "max" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "worker-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "low" }
  ]
  let switchedTo: Array<{ model: string; effort: string }> = []
  const storage = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear()
  })
  const { client, fake } = await make((fake) => {
    switchedTo = configureReasoningModels(fake, models, "main-native", "max").switchedTo
  })
  const id = await client.newSession("/tmp/orchestrated")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "high" },
    worker: { model: "worker-native", effort: "medium" }
  })
  try {
    await client.prompt(id, [{ type: "text", text: "build the report" }])
    // The planner ran; the worker did not.
    expect(fake.prompts.some((text) => text.includes("分工模式·规划"))).toBe(true)
    expect(fake.prompts.some((text) => text.includes("分工模式·执行"))).toBe(false)
    expect(pendingPlanFor(id)?.plan).toBe(`reply:${id}`)
    // The optimistic bubble stays exactly what the user typed.
    expect(
      client.session(id).items.some((item) => item.kind === "user" && textOf(item.content) === "build the report")
    ).toBe(true)
    expect(client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined).toBe(
      "main-native"
    )
    expect(client.effortOf(id)).toBe("max")
    expect(orchestrationFor(id)).toEqual({
      planner: { model: "planner-native", effort: "high" },
      worker: { model: "worker-native", effort: "medium" }
    })
    // Approval runs the worker on the worker model.
    await client.executePlan(id)
    expect(fake.prompts.some((text) => text.includes("分工模式·执行"))).toBe(true)
    expect(pendingPlanFor(id)).toBeNull()
    const model = client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined
    expect(model).toBe("main-native")
    expect(client.effortOf(id)).toBe("max")
    expect(orchestrationOrder(fake)).toEqual([
      "config:model=planner-native",
      "config:reasoning_effort=high",
      "prompt:planner",
      "config:model=main-native",
      "config:reasoning_effort=max",
      "config:model=worker-native",
      "config:reasoning_effort=medium",
      "prompt:worker",
      "config:model=main-native",
      "config:reasoning_effort=max"
    ])
    // Switching a model resets an unsupported effort to that model's default; the split then applies
    // the role's own pinned effort before prompting.
    expect(switchedTo).toEqual([
      { model: "planner-native", effort: "medium" },
      { model: "main-native", effort: "max" },
      { model: "worker-native", effort: "low" },
      { model: "main-native", effort: "medium" }
    ])
    // The split's role switches must not replace the conversation's saved main selection.
    const stored = JSON.parse(localStorage.getItem("alwith:session-models") ?? "{}")
    expect(stored[id]).toMatchObject({ model: "main-native", effort: "max", fastMode: false })
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
    vi.unstubAllGlobals()
  }
})

test("orchestration follows each role model's own default effort", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "high", "max"], defaultEffort: "high" },
    { id: "worker-native", groupId: "chatgpt", efforts: ["minimal", "low", "medium"], defaultEffort: "low" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "main-native", "medium"))
  const id = await client.newSession("/tmp/orchestrated-default-effort")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: null },
    worker: { model: "worker-native", effort: null }
  })
  try {
    await client.prompt(id, [{ type: "text", text: "build the report" }])
    await client.executePlan(id)
    expect(orchestrationOrder(fake)).toEqual([
      "config:model=planner-native",
      "config:reasoning_effort=high",
      "prompt:planner",
      "config:model=main-native",
      "config:reasoning_effort=medium",
      "config:model=worker-native",
      "config:reasoning_effort=low",
      "prompt:worker",
      "config:model=main-native",
      "config:reasoning_effort=medium"
    ])
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
  }
})

test("orchestration accepts gateway models as a role with published efforts", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "gateway:opaque", groupId: "hakimi", efforts: ["low", "high"], defaultEffort: "low" }
  ]
  let switchedTo: Array<{ model: string; effort: string }> = []
  const { client, fake } = await make((fake) => {
    switchedTo = configureReasoningModels(fake, models, "main-native", "medium").switchedTo
  })
  const id = await client.newSession("/tmp/orchestrated-gateway-worker")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "high" },
    worker: { model: "gateway:opaque", effort: "high" }
  })
  try {
    await client.prompt(id, [{ type: "text", text: "build the report" }])
    expect(fake.prompts.some((text) => text.includes("分工模式·规划"))).toBe(true)
    await client.executePlan(id)
    expect(fake.prompts.some((text) => text.includes("分工模式·执行"))).toBe(true)
    // The worker ran on the gateway model with its pinned effort; the main model came back.
    expect(orchestrationOrder(fake)).toEqual([
      "config:model=planner-native",
      "config:reasoning_effort=high",
      "prompt:planner",
      "config:model=main-native",
      "config:reasoning_effort=medium",
      "config:model=gateway:opaque",
      "config:reasoning_effort=high",
      "prompt:worker",
      "config:model=main-native",
      "config:reasoning_effort=medium"
    ])
    // A model switch resets an unsupported effort to the target's default (gateway: medium → low),
    // and the pinned effort is written afterwards.
    expect(switchedTo).toEqual([
      { model: "planner-native", effort: "medium" },
      { model: "main-native", effort: "high" },
      { model: "gateway:opaque", effort: "low" },
      { model: "main-native", effort: "high" }
    ])
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
  }
})

test("orchestration runs a role model without an effort catalog on its own default", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "worker-opaque", groupId: "hakimi", efforts: [], defaultEffort: "" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "main-native", "medium"))
  const id = await client.newSession("/tmp/orchestrated-no-effort")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "high" },
    worker: { model: "worker-opaque", effort: null }
  })
  try {
    await client.prompt(id, [{ type: "text", text: "build the report" }])
    await client.executePlan(id)
    // The ladder-less worker only switches the model: no effort is written for it.
    expect(orchestrationOrder(fake)).toEqual([
      "config:model=planner-native",
      "config:reasoning_effort=high",
      "prompt:planner",
      "config:model=main-native",
      "config:reasoning_effort=medium",
      "config:model=worker-opaque",
      "prompt:worker",
      "config:model=main-native",
      "config:reasoning_effort=medium"
    ])
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
  }
})

test("orchestration rejects a pinned effort on a model without an effort catalog", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "worker-opaque", groupId: "hakimi", efforts: [], defaultEffort: "" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "main-native", "medium"))
  const id = await client.newSession("/tmp/orchestrated-pinned-no-effort")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "high" },
    worker: { model: "worker-opaque", effort: "high" }
  })
  try {
    await expect(client.prompt(id, [{ type: "text", text: "build the report" }])).rejects.toThrow(
      "没有可用的 Effort 目录"
    )
    expect(fake.events).toEqual([])
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
  }
})

test("orchestration runs on a gateway session and restores its main model", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "gateway:opaque", groupId: "hakimi", efforts: ["low", "high"], defaultEffort: "low" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "worker-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "low" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "gateway:opaque", "low"))
  const id = await client.newSession("/tmp/orchestrated-gateway-session", "gateway:opaque")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "high" },
    worker: { model: "worker-native", effort: "medium" }
  })
  try {
    await client.prompt(id, [{ type: "text", text: "build the report" }])
    expect(fake.prompts.some((text) => text.includes("分工模式·规划"))).toBe(true)
    // The main selection is a gateway model: the split still runs and hands the session back.
    expect(client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined).toBe(
      "gateway:opaque"
    )
    expect(client.effortOf(id)).toBe("low")
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
  }
})

test("orchestration rejects an effort the target model does not support", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "main-native", "medium"))
  const id = await client.newSession("/tmp/orchestrated-unsupported-effort")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "max" },
    worker: { model: "planner-native", effort: "medium" }
  })
  try {
    await expect(client.prompt(id, [{ type: "text", text: "build the report" }])).rejects.toThrow(
      "不支持 Effort"
    )
    expect(fake.events).toEqual([])
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
  }
})

test("orchestration stops before prompting when the effort write fails", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "main-native", "medium"))
  const respond = must(fake.configResponse.current, "missing fake config responder")
  fake.configResponse.current = (request) => {
    if (request.configId === "reasoning_effort")
      throw RequestError.invalidRequest({ effort: request.value }, "Effort write rejected")
    return respond(request)
  }
  const id = await client.newSession("/tmp/orchestrated-effort-failure")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "high" },
    worker: { model: "planner-native", effort: "medium" }
  })
  try {
    await expect(client.prompt(id, [{ type: "text", text: "build the report" }])).rejects.toThrow(
      "Effort write rejected"
    )
    expect(fake.prompts).toEqual([])
    expect(pendingPlanFor(id)).toBeNull()
    expect(client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined).toBe(
      "main-native"
    )
    expect(client.effortOf(id)).toBe("medium")
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
  }
})

test("a worker effort failure restores the main chat and keeps the plan", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "max"], defaultEffort: "max" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium"], defaultEffort: "low" },
    { id: "worker-native", groupId: "chatgpt", efforts: ["low", "medium"], defaultEffort: "low" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "main-native", "max"))
  const respond = must(fake.configResponse.current, "missing fake config responder")
  let rejected = false
  fake.configResponse.current = (request) => {
    if (request.configId === "reasoning_effort" && request.value === "medium" && !rejected) {
      rejected = true
      throw RequestError.invalidRequest({ effort: request.value }, "Worker effort write rejected")
    }
    return respond(request)
  }
  const id = await client.newSession("/tmp/orchestrated-worker-effort-failure")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "low" },
    worker: { model: "worker-native", effort: "medium" }
  })
  try {
    await client.prompt(id, [{ type: "text", text: "build the report" }])
    await expect(client.executePlan(id)).rejects.toThrow("Worker effort write rejected")
    expect(fake.prompts.some((text) => text.includes("分工模式·执行"))).toBe(false)
    expect(pendingPlanFor(id)).not.toBeNull()
    expect(client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined).toBe(
      "main-native"
    )
    expect(client.effortOf(id)).toBe("max")
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
  }
})

test("orchestration fails when the applied model or effort does not read back", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "main-native", "medium"))
  const respond = must(fake.configResponse.current, "missing fake config responder")
  let rejected = false
  fake.configResponse.current = (request) => {
    const response = respond(request)
    if (request.configId !== "reasoning_effort" || rejected) return response
    rejected = true
    return {
      configOptions: response.configOptions.map((option) =>
        option.configId === "reasoning_effort" ? { ...option, currentValue: "low" } : option
      ) as Session["configOptions"]
    }
  }
  const id = await client.newSession("/tmp/orchestrated-readback")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "high" },
    worker: { model: "planner-native", effort: "medium" }
  })
  try {
    await expect(client.prompt(id, [{ type: "text", text: "build the report" }])).rejects.toThrow(
      "角色配置回读不一致"
    )
    expect(fake.prompts).toEqual([])
    expect(client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined).toBe(
      "main-native"
    )
    expect(client.effortOf(id)).toBe("medium")
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
  }
})

test("a new conversation follows the sandbox setting", async () => {
  const { client, fake } = await make()
  setSandboxSettings({ enabled: false, projectWrite: true })
  const unrestricted = await client.newSession("/tmp/sandbox-off")
  expect(fake.modes.get(unrestricted)).toBe("agent-full-access")
  setSandboxSettings({ enabled: true, projectWrite: true })
  try {
    const sandboxed = await client.newSession("/tmp/sandbox-on")
    expect(fake.modes.get(sandboxed)).toBe("workspace-write")
    setSandboxSettings({ projectWrite: false })
    const readOnly = await client.newSession("/tmp/sandbox-read-only")
    expect(fake.modes.get(readOnly)).toBe("read-only")
  } finally {
    setSandboxSettings({ enabled: false, projectWrite: true })
  }
})

test("a resumed conversation follows the sandbox preset while the sandbox is on", async () => {
  const { client, fake } = await make()
  setSandboxSettings({ enabled: false, projectWrite: true })
  const id = await client.newSession("/tmp/sandbox-resume")
  setSandboxSettings({ enabled: true, projectWrite: true })
  try {
    await client.stopSession(id)
    await client.open(id, "/tmp/sandbox-resume")
    expect(fake.modes.get(id)).toBe("workspace-write")
  } finally {
    setSandboxSettings({ enabled: false, projectWrite: true })
  }
})

test("effort is written to the id the adapter serves, not the composer's alias", async () => {
  const writes: string[] = []
  const { client } = await make((fake) => {
    let options: Session["configOptions"] = [
      {
        configId: "model",
        category: "model",
        name: "Model",
        type: "select",
        currentValue: "picked",
        options: [{ value: "picked", name: "Picked" }]
      },
      {
        configId: "reasoning_effort",
        category: "thought_level",
        name: "Effort",
        type: "select",
        currentValue: "low",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" }
        ]
      }
    ]
    fake.sessionOptions.current = () => options
    fake.configResponse.current = (request) => {
      writes.push(request.configId)
      options = options.map((option) =>
        option.configId === request.configId
          ? ({ ...option, currentValue: request.value } as Session["configOptions"][number])
          : option
      )
      return { configOptions: options }
    }
  })
  const id = await client.newSession("/tmp/effort-alias")
  await client.setConfig(id, "effort", "high")
  expect(writes).toEqual(["reasoning_effort"])
  expect(client.session(id).configOptions.find((option) => option.configId === "reasoning_effort")?.currentValue).toBe(
    "high"
  )
})

test("orchestration writes to the effort id the adapter actually exposes", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" }
  ]
  const { client, fake } = await make((fake) =>
    configureReasoningModels(fake, models, "main-native", "medium", "effort")
  )
  const id = await client.newSession("/tmp/orchestrated-effort")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "high" },
    worker: { model: "planner-native", effort: "medium" }
  })
  try {
    await client.prompt(id, [{ type: "text", text: "build the report" }])
    await client.executePlan(id)
    expect(orchestrationOrder(fake)).toEqual([
      "config:model=planner-native",
      "config:effort=high",
      "prompt:planner",
      "config:model=main-native",
      "config:effort=medium",
      "config:model=planner-native",
      "config:effort=medium",
      "prompt:worker",
      "config:model=main-native",
      "config:effort=medium"
    ])
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
  }
})

test("a group conversation ignores a stored split and sends an ordinary prompt", async () => {
  // 分工 × 拉会 are mutually exclusive: the roster switches the session's model per speaker, and the
  // split would switch it again per role inside the same turn. The runtime gate — not the composer
  // — is what enforces this, so a record carried into a group conversation must not reach the planner.
  const memory = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear()
  })
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "worker-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "main-native", "medium"))
  const directory = client.projectPath("/tmp/ALWith/groups/周会")
  setGroup({
    id: "group-orchestration-guard",
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
  const id = await client.newSession(directory)
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "high" },
    worker: { model: "worker-native", effort: "medium" }
  })
  try {
    await client.prompt(id, [{ type: "text", text: "讨论一下发布节奏" }])
    // The planner never ran, so no plan is waiting for an approval button that is not rendered here.
    expect(fake.prompts.some((text) => text.includes("分工模式·规划"))).toBe(false)
    expect(pendingPlanFor(id)).toBeNull()
    // The same words went out as a plain turn, and the session stayed on the user's own model.
    expect(fake.prompts).toContain("讨论一下发布节奏")
    expect(
      client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined
    ).toBe("main-native")
    // The record is the user's configuration: it is ignored, never silently consumed or rewritten.
    expect(orchestrationFor(id)).toEqual({
      planner: { model: "planner-native", effort: "high" },
      worker: { model: "worker-native", effort: "medium" }
    })
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
    removeGroup("group-orchestration-guard")
    vi.unstubAllGlobals()
  }
})

test("a quick-chat conversation ignores a stored split because it has no way to approve a plan", async () => {
  // A chat folder renders no 分工 control, so a plan produced there could never be executed. The
  // gate turns that into an ordinary prompt instead of leaving a plan with no button.
  const memory = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear()
  })
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "main-native", "medium"))
  // A temporary chat lives in its own folder under `<quick-chat>/Chat/<stamp>`; the folder test is
  // what classifies it, so the path shape here is the production one.
  const id = await client.newSession("/Users/tester/Documents/Codex/Chat/2026-01-05 09-00-00")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "high" },
    worker: { model: "main-native", effort: "medium" }
  })
  try {
    await client.prompt(id, [{ type: "text", text: "随便聊聊" }])
    expect(fake.prompts.some((text) => text.includes("分工模式·规划"))).toBe(false)
    expect(pendingPlanFor(id)).toBeNull()
    expect(fake.prompts).toContain("随便聊聊")
    expect(orchestrationFor(id)).not.toBeNull()
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
    vi.unstubAllGlobals()
  }
})

test("a project conversation still enters the split: the guard only excludes chat and group folders", async () => {
  // The regression this pins: tightening the gate must not quietly disable 分工 for the ordinary
  // project conversation that owns the control.
  const memory = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear()
  })
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "planner-native", groupId: "chatgpt", efforts: ["low", "medium", "high"], defaultEffort: "medium" }
  ]
  const { client, fake } = await make((fake) => configureReasoningModels(fake, models, "main-native", "medium"))
  const id = await client.newSession("/tmp/orchestrated-still-allowed")
  setOrchestration(id, {
    planner: { model: "planner-native", effort: "high" },
    worker: { model: "main-native", effort: "medium" }
  })
  try {
    await client.prompt(id, [{ type: "text", text: "build the report" }])
    expect(fake.prompts.some((text) => text.includes("分工模式·规划"))).toBe(true)
    expect(pendingPlanFor(id)).not.toBeNull()
  } finally {
    setOrchestration(id, null)
    setPendingPlan(id, null)
    vi.unstubAllGlobals()
  }
})

test("switching to a model the engine dropped hops to a live sibling and says so", async () => {
  // 设置 → 可用模型 keeps `gpt-6.1-terra` after the provider stops advertising it, and the picker
  // mirrors that list, so this write is reachable. The agent does not reject an unknown id — it
  // ignores it — so without this hop the chat would keep its old model while the trigger read
  // "6.1 Terra", and every answer would silently come from Sol.
  const { client } = await make((fake) => {
    configureReasoningModels(
      fake,
      [{ id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium"], defaultEffort: "low" }],
      "gpt-6.1-sol",
      "low"
    )
  })
  const id = await client.newSession("/tmp/dropped-model")
  const info = vi.mocked(toast.info)
  info.mockClear()

  await client.setConfig(id, "model", "gpt-6.1-terra")

  const current = client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue
  expect(current).toBe("gpt-6.1-sol")
  // The hop has to be announced: doing it quietly is what made the mismatch invisible.
  expect(info).toHaveBeenCalledTimes(1)
})

test("a prompt on a retired model falls back to a sibling and resends once", async () => {
  const { client, fake } = await make()
  const id = await client.newSession("/tmp/retired-model", "gpt-6.1-terra")
  let failed = false
  fake.promptError.current = () => {
    if (failed) return null
    failed = true
    return RequestError.invalidRequest(
      { reason: "unsupported_model" },
      "stream disconnected before completion: Unsupported model: 'gpt-6.1-terra'"
    )
  }
  await client.prompt(id, [{ type: "text", text: "hello" }])
  expect(failed).toBe(true)
  // The thread moved off the retired id onto a sibling the catalog still offers.
  const current = client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined
  expect(current).toBe("gpt-6.1-sol")
  // The same message was delivered on the retry, so the turn is not lost.
  expect(fake.prompts).toContain("hello")
})

test("several tombstones never leave the fallback with no candidate", async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear()
  })
  // Every live sibling has a tombstone. Filtering the whole set out at once used to leave the
  // fallback with zero candidates, so one refused model made every other model unusable.
  const ids = [
    "gpt-6.1-sol", "picked", "main-picked", "chosen-model", "another-model",
    "broken-model", "unavailable", "main-model", "chat-model"
  ]
  storage.set("alwith:retired-models", JSON.stringify(Object.fromEntries(ids.map((id) => [id, Date.now()]))))
  try {
    const { client, fake } = await make()
    const id = await client.newSession("/tmp/all-retired", "gpt-6.1-terra")
    let failed = false
    fake.promptError.current = () => {
      if (failed) return null
      failed = true
      return RequestError.invalidRequest(
        { reason: "unsupported_model" },
        "stream disconnected before completion: Unsupported model: 'gpt-6.1-terra'"
      )
    }
    await client.prompt(id, [{ type: "text", text: "hello" }])
    expect(failed).toBe(true)
    const current = client.session(id).configOptions.find((option) => option.configId === "model")
      ?.currentValue as string | undefined
    expect(current).toBe("gpt-6.1-sol")
    expect(fake.prompts).toContain("hello")
  } finally {
    vi.unstubAllGlobals()
  }
})

test("a turn that died without an idle update stops counting as busy once its clock is stale", async () => {
  const { client, fake } = await make()
  const id = await client.newSession("/tmp/ghost-turn")
  await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "running" })
  const probe = client as unknown as {
    sessionBusy: (id: string) => boolean
    stalledTurn: (id: string) => boolean
  }
  expect(probe.sessionBusy(id)).toBe(true)
  // Two minutes pass with no tokens and no final update. The old code trusted `state === "running"`
  // unconditionally and parked every later model pick behind a turn that had already ended.
  const clock = vi.spyOn(Date, "now")
  clock.mockReturnValue(Date.now() + 2 * 60_000)
  try {
    expect(probe.sessionBusy(id)).toBe(false)
    expect(probe.stalledTurn(id)).toBe(true)
  } finally {
    clock.mockRestore()
  }
})

test("a live turn stays busy even when neither clock moves", async () => {
  const { client, fake } = await make()
  const id = await client.newSession("/tmp/long-tool-turn")
  // The prompt is accepted at once (receipt resolves); only the terminal `idle` is withheld —
  // the real shape of a long silent turn. The live-turn heartbeat must survive that receipt.
  fake.promptHoldIdle.current = () => true
  const receipt = await client.prompt(id, [{ type: "text", text: "long turn" }])
  expect(typeof receipt).toBe("string")
  await vi.waitFor(() => expect(client.session(id).state).toBe("running"))
  const probe = client as unknown as {
    sessionBusy: (id: string) => boolean
    stalledTurn: (id: string) => boolean
  }

  // Real Runtime behaviour: `version` is monotonic per *state*, not per activity. A turn that
  // streams for minutes republishes with a fresh `lastActivityAt` but the same version, same
  // state and same task count, so the run-row signature never changes. `session.clock` is also
  // frozen: text chunks append to an existing item instead of creating a new one.
  const started = Date.now()
  const since = started - 6 * 60_000
  const row = (lastActivityAt: number): Parameters<typeof client.applyRunStates>[0][number] => ({
    sessionId: id,
    state: "running",
    reusableDraft: false,
    owner: "stdio",
    cwd: "/tmp/long-tool-turn",
    title: "Long turn",
    since,
    lastActivityAt,
    version: 1,
    interruption: null,
    tasks: [],
    listeningPorts: [],
    executionId: null,
    executionRole: null
  })
  client.applyRunStates([row(started)])
  expect(probe.sessionBusy(id)).toBe(true)

  const clock = vi.spyOn(Date, "now")
  const future = started + 5 * 60_000
  clock.mockReturnValue(future)
  try {
    client.applyRunStates([row(future)])
    // Both change-detector clocks are stale now. Only the unsettled prompt keeps this turn busy;
    // without that guard a parked model write would land and cancel the healthy stream.
    expect(probe.sessionBusy(id)).toBe(true)
    expect(probe.stalledTurn(id)).toBe(false)
  } finally {
    clock.mockRestore()
  }
})

test("an accepted turn is not misjudged stale after a long silent stretch", async () => {
  const { client, fake } = await make()
  const id = await client.newSession("/tmp/silent-stretch")
  fake.promptHoldIdle.current = () => true
  // The receipt has resolved; from here on the turn emits nothing at all (one long tool call).
  const receipt = await client.prompt(id, [{ type: "text", text: "silent" }])
  expect(typeof receipt).toBe("string")
  await vi.waitFor(() => expect(client.session(id).state).toBe("running"))
  const probe = client as unknown as {
    sessionBusy: (id: string) => boolean
    stalledTurn: (id: string) => boolean
  }
  // Both change-detector clocks go stale during the silence. Only the heartbeat that survived the
  // receipt keeps this turn busy; ending it at acceptance would read as a ghost and cancel the
  // healthy stream to land a parked model switch.
  const clock = vi.spyOn(Date, "now")
  clock.mockReturnValue(Date.now() + 10 * 60_000)
  try {
    expect(probe.sessionBusy(id)).toBe(true)
    expect(probe.stalledTurn(id)).toBe(false)
    expect(fake.cancels).not.toContain(id)
  } finally {
    clock.mockRestore()
  }
})

test("a prompt rejected with the runtime's catalog sentence still recovers", async () => {
  // The Runtime words a refused pick differently from the adapter: it lists every model it does
  // serve and ends with `"x" is not one of them`. That shape used to slip past the recovery check,
  // so a saved 可用模型 row for a retired id killed the turn with a wall of English instead.
  const { client, fake } = await make()
  const id = await client.newSession("/tmp/catalog-rejects")
  let failed = false
  fake.promptError.current = () => {
    if (failed) return null
    failed = true
    return RequestError.invalidRequest(
      { reason: "unknown_model" },
      'model offers gpt-6.1-sol, gpt-5.6-terra, gateway:hakimi:claude-sonnet-5-5; "gpt-6.1-terra" is not one of them'
    )
  }
  await client.prompt(id, [{ type: "text", text: "hello" }])
  expect(failed).toBe(true)
  expect(fake.prompts).toContain("hello")
  // Remembered, so the same pick never reaches the agent a second time…
  const writes = fake.configChanges.length
  await client.setConfig(id, "model", "gpt-6.1-terra")
  const after = fake.configChanges.slice(writes)
  expect(after).not.toContain("gpt-6.1-terra")
  // …and lands on a live sibling from the same family rather than an unrelated vendor.
  expect(after.at(-1)).toBe("gpt-6.1-sol")
})

test("a reopened chat stops replaying a model the provider already dropped", async () => {
  // `adapter-route.log` shows the same chat writing `gpt-6.1-terra` at 02:03 and again at 02:16:
  // the saved per-chat record outlived the refusal, so every open re-sent an id the catalog no
  // longer served and the reader met the same English wall after each restart.
  const model: SelectOption = {
    configId: "model",
    category: "model",
    name: "Model",
    type: "select",
    currentValue: "gpt-6.1-sol",
    options: [
      {
        groupId: "chatgpt",
        name: "ChatGPT",
        options: [
          { value: "gpt-6.1-sol", name: "6.1 Sol" },
          { value: "gpt-6-luna", name: "6 Luna" }
        ]
      }
    ]
  }
  const storage = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear()
  })
  localStorage.setItem(
    "alwith:session-models",
    JSON.stringify({ h1: { model: "gpt-6.1-terra", effort: null } })
  )
  const writes: string[] = []
  // `value` is `unknown` on the SDK request; the adapter narrows it per config id, so do the same.
  const refuse = (request: { configId: string; value: unknown }) => {
    if (request.configId === "model") {
      const wanted = String(request.value)
      writes.push(wanted)
      if (wanted === "gpt-6.1-terra")
        throw RequestError.invalidRequest(
          { reason: "unknown_model" },
          'model offers gpt-6.1-sol, gpt-6-luna; "gpt-6.1-terra" is not one of them'
        )
      model.currentValue = wanted
    }
    return { configOptions: [model] }
  }
  try {
    const first = await make((fake) => {
      fake.sessionOptions.current = () => [model]
      fake.configResponse.current = refuse
    })
    await first.client.open("h1", "/tmp/one")
    await vi.waitFor(() => expect(model.currentValue).toBe("gpt-6.1-sol"))
    // The record now names the live model, so the next launch has nothing to retry.
    await vi.waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("alwith:session-models") ?? "{}") as Record<
        string,
        { model?: string | null }
      >
      expect(stored.h1?.model).not.toBe("gpt-6.1-terra")
    })
    const before = writes.length
    const second = await make((fake) => {
      fake.sessionOptions.current = () => [model]
      fake.configResponse.current = refuse
    })
    await second.client.open("h1", "/tmp/one")
    await vi.waitFor(() => expect(second.client.session("h1")).toBeTruthy())
    expect(writes.slice(before)).not.toContain("gpt-6.1-terra")
  } finally {
    localStorage.removeItem("alwith:session-models")
    vi.unstubAllGlobals()
  }
})

test("a turn that never becomes idle is cancelled by the watchdog instead of pinning the agent", async () => {
  const { client, fake } = await make()
  const id = await client.newSession("/tmp/hang")
  const other = await client.newSession("/tmp/other")
  // The engine accepts the prompt but never reports the terminal `idle` (a misconfigured gateway,
  // dropped provider). Without the watchdog this pins the shared agent forever.
  fake.promptHoldIdle.current = () => true
  vi.useFakeTimers()
  const probe = client as unknown as { sessionBusy: (id: string) => boolean }
  try {
    // Acceptance resolves `client.prompt` at once; the heartbeat and watchdogs keep watching.
    const receipt = await client.prompt(id, [{ type: "text", text: "hang" }])
    expect(typeof receipt).toBe("string")
    expect(probe.sessionBusy(id)).toBe(true)
    // A `max` effort reasoning model can be silent for a minute or two before its first token;
    // a healthy `gpt-6.1-sol` thread stayed silent for 309s between tool results, so 400s must
    // still be waited out.
    await vi.advanceTimersByTimeAsync(400_000)
    expect(probe.sessionBusy(id)).toBe(true)
    expect(fake.cancels).not.toContain(id)
    // The idle cutoff sits just above the bridge's own 600s read timeout: a dead socket is reported
    // there with a concrete reason, and this timer only catches an agent that stopped talking.
    await vi.advanceTimersByTimeAsync(850_000)
    expect(fake.cancels).toContain(id)
    // The watchdog settled the heartbeat, so the ghost turn no longer reads busy.
    expect(probe.sessionBusy(id)).toBe(false)
  } finally {
    vi.useRealTimers()
  }
  // The agent is freed: a follow-up prompt on another session still completes.
  fake.promptHoldIdle.current = null
  const sending2 = client.prompt(other, [{ type: "text", text: "hello" }])
  await sending2
  await vi.waitFor(() => expect(client.session(other).items.some((item) => item.kind === "assistant")).toBe(true))
})

test("queued send mode holds the next message until the running turn settles", async () => {
  const { client, fake } = await make()
  const id = await client.newSession("/tmp/queue-mode")
  // An accepted turn with no terminal `idle` keeps the session non-idle without timing luck.
  fake.promptHoldIdle.current = () => true
  void client.prompt(id, [{ type: "text", text: "first" }]).catch(() => {})
  await vi.waitFor(() => expect(client.session(id).state).toBe("running"))

  setQueueSendMode("queued")
  void client.prompt(id, [{ type: "text", text: "second" }]).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 80))
  // Nothing reached the agent: the queued message is still waiting for the turn to end.
  expect(fake.prompts).toEqual(["first"])

  // Immediate mode is the built-in steering: the message goes out inside the running turn.
  setQueueSendMode("immediate")
  await client.prompt(id, [{ type: "text", text: "third" }])
  expect(fake.prompts).toEqual(["first", "third"])
})

test("a queued message goes out on its own once the session falls idle", async () => {
  const { client } = await make()
  const id = await client.newSession("/tmp/queue-release")
  const internals = client as unknown as {
    holds: (sessionId: string) => boolean
    session: (sessionId: string) => Session
    sendPrompt: (sessionId: string, prompt: unknown[]) => Promise<string>
  }
  // Drive the session state by hand: the wait loop polls it every 500ms.
  vi.spyOn(internals, "holds").mockReturnValue(true)
  const real = client.session(id)
  const state = { value: "running" }
  vi.spyOn(internals, "session").mockImplementation(() => ({ ...real, state: state.value }) as Session)
  const send = vi.spyOn(internals, "sendPrompt").mockResolvedValue("released")

  setQueueSendMode("queued")
  const pending = client.prompt(id, [{ type: "text", text: "held" }])
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(send).not.toHaveBeenCalled()

  state.value = "idle"
  await expect(pending).resolves.toBe("released")
  expect(send).toHaveBeenCalledTimes(1)
  setQueueSendMode("immediate")
})

test("immediate send mode inserts a supplement while the first turn is still running", async () => {
  const { client, fake } = await make()
  const id = await client.newSession("/tmp/immediate-steer")
  fake.promptHoldIdle.current = (text) => text === "first"
  setQueueSendMode("immediate")
  try {
    const first = client.prompt(id, [{ type: "text", text: "first" }]).catch(() => undefined)
    await vi.waitFor(() => expect(client.session(id).state).toBe("running"))
    const receipt = await client.prompt(id, [{ type: "text", text: "supplement" }])
    expect(receipt).toBe("u2")
    expect(fake.prompts).toEqual(["first", "supplement"])
    expect(client.session(id).state).toBe("running")
    expect(client.session(id).items.some((item) => item.kind === "user" && textOf(item.content) === "supplement")).toBe(
      true
    )
    await client.cancel(id)
    await first
  } finally {
    setQueueSendMode("immediate")
  }
})

test("a non-steerable refusal is classified so the caller can queue the supplement", () => {
  expect(turnNotSteerable(new Error("turn_not_steerable"))).toBe(true)
  expect(turnNotSteerable({ error: { activeTurnNotSteerable: {} } })).toBe(true)
  expect(turnNotSteerable(new Error("server overloaded"))).toBe(false)
})

test("a non-steerable refusal hands the supplement to the queue instead of dropping it", async () => {
  const { client } = await make()
  const internals = client as unknown as {
    sendPrompt: (id: string, prompt: unknown[], options?: unknown) => Promise<string>
    waitForIdleThenPrompt: (id: string, prompt: unknown[], options?: unknown) => Promise<string>
    sendImmediate: (id: string, prompt: unknown[], options?: unknown) => Promise<string>
  }
  vi.spyOn(internals, "sendPrompt").mockRejectedValueOnce(new Error("turn_not_steerable"))
  const queued = vi.spyOn(internals, "waitForIdleThenPrompt").mockResolvedValue("queued-receipt")
  const prompt = [{ type: "text" as const, text: "supplement" }]
  await expect(internals.sendImmediate("session", prompt)).resolves.toBe("queued-receipt")
  expect(queued).toHaveBeenCalledWith("session", prompt, undefined)
})

test("cancelling a queued message rejects without sending and clears the chip", async () => {
  const { client } = await make()
  const id = await client.newSession("/tmp/queue-cancel")
  const internals = client as unknown as {
    holds: (sessionId: string) => boolean
    session: (sessionId: string) => Session
    sendPrompt: (sessionId: string, prompt: unknown[]) => Promise<string>
  }
  vi.spyOn(internals, "holds").mockReturnValue(true)
  const real = client.session(id)
  vi.spyOn(internals, "session").mockImplementation(() => ({ ...real, state: "running" }) as Session)
  const send = vi.spyOn(internals, "sendPrompt")

  setQueueSendMode("queued")
  const pending = client.prompt(id, [{ type: "text", text: "不要发了" }])
  await vi.waitFor(() => expect(queuedPromptCount(id)).toBe(1))
  expect(queuedPromptText(id)).toBe("不要发了")

  cancelQueuedPrompt(id)
  await expect(pending).rejects.toBeInstanceOf(QueueCancelledError)
  expect(send).not.toHaveBeenCalled()
  expect(queuedPromptCount(id)).toBe(0)
  setQueueSendMode("immediate")
})

test("an isolated turn runs on the reviewer's model and leaves no session behind", async () => {
  const { client, fake } = await make()
  const text = await client.runIsolatedTurn("/tmp/review", "deepseek-flash", "评审这段方案")

  expect(text.startsWith("reply:")).toBe(true)
  // The reviewer must never become a conversation: its draft is deleted the moment it settles.
  expect([...fake.deleted]).toHaveLength(1)
  expect(fake.modelHints.get([...fake.deleted][0] ?? "")).toBe("deepseek-flash")
  expect(fake.prompts).toContain("评审这段方案")
})

test("an isolated turn still deletes its session when the reviewer fails", async () => {
  const { client, fake } = await make((agent) => {
    agent.promptError.current = () => new Error("reviewer exploded")
  })
  await expect(client.runIsolatedTurn("/tmp/review", "deepseek-flash", "评审")).rejects.toThrow()
  expect([...fake.deleted]).toHaveLength(1)
})

test("a group discussion runs the roster in order and the moderator closes", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low"], defaultEffort: "low" },
    { id: "architect", groupId: "chatgpt", efforts: ["low"], defaultEffort: "low" },
    { id: "critic", groupId: "chatgpt", efforts: ["low"], defaultEffort: "low" }
  ]
  const { client, fake } = await make((agent) => {
    configureReasoningModels(agent, models, "main-native", "low")
  })
  const id = await client.newSession("/tmp/group")
  await client.runGroupDiscussion(
    id,
    [
      { id: "r1", name: "架构师", model: "architect", effort: null, instruction: "看架构", moderator: false },
      { id: "r2", name: "评审", model: "critic", effort: null, instruction: "挑错", moderator: false },
      { id: "r3", name: "主持人", model: "architect", effort: null, instruction: "定稿", moderator: true }
    ],
    2,
    "# 群说明\n支付告警收敛。",
    "结论：\n待办："
  )

  const countOf = (name: string): number => fake.prompts.filter((text) => text.includes(`你是「${name}」`)).length
  // Two rounds of the roster, and the moderator closes each round (not only the last one).
  expect(countOf("架构师")).toBe(2)
  expect(countOf("评审")).toBe(2)
  expect(countOf("主持人")).toBe(2)
  // The document every member reads.
  expect(fake.prompts.every((text) => text.includes("支付告警收敛。"))).toBe(true)
  // Each member spoke on its own model, and the user's model is back afterwards.
  const modelWrites = fake.events.flatMap((event) =>
    event.type === "config" && event.request.configId === "model" ? [String(event.request.value)] : []
  )
  // The moderator's summary leaves the session on its model, so round 2's first speaker (same
  // model) writes nothing; the sequence is unchanged from a single closing turn.
  expect(modelWrites).toEqual(["architect", "critic", "architect", "critic", "architect", "main-native"])
  const model = client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as
    | string
    | undefined
  expect(model).toBe("main-native")
})

test("a paused discussion holds, then runs the roster once resumed", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low"], defaultEffort: "low" },
    { id: "architect", groupId: "chatgpt", efforts: ["low"], defaultEffort: "low" }
  ]
  const { client, fake } = await make((agent) => {
    configureReasoningModels(agent, models, "main-native", "low")
  })
  const id = await client.newSession("/tmp/group")
  const turns = [
    { id: "r1", name: "架构师", model: "architect", effort: null, instruction: "看架构", moderator: false }
  ]

  setGroupPaused(id, true)
  const pending = client.runGroupDiscussion(id, turns, 1, "# 群说明", "")
  // Nothing is dispatched while the brake is on: a pause takes effect before the next speaker.
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(fake.prompts.filter((text) => text.includes("你是「架构师」"))).toHaveLength(0)

  setGroupPaused(id, false)
  await expect(pending).resolves.toMatchObject({ outcome: "done" })
  expect(fake.prompts.filter((text) => text.includes("你是「架构师」"))).toHaveLength(1)
})

test("a stopped discussion dispatches no speaker at all", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low"], defaultEffort: "low" },
    { id: "architect", groupId: "chatgpt", efforts: ["low"], defaultEffort: "low" }
  ]
  const { client, fake } = await make((agent) => {
    configureReasoningModels(agent, models, "main-native", "low")
  })
  const id = await client.newSession("/tmp/group")
  requestGroupStop(id)
  const outcome = await client.runGroupDiscussion(
    id,
    [{ id: "r1", name: "架构师", model: "architect", effort: null, instruction: "看架构", moderator: false }],
    2,
    "# 群说明",
    ""
  )
  clearGroupControl(id)
  expect(outcome.outcome).toBe("stopped")
  expect(fake.prompts.filter((text) => text.includes("你是「架构师」"))).toHaveLength(0)
})

test("a group's conversations stay out of the project list and reach the group panel", async () => {
  // This suite runs without a DOM: `groups.ts` reads localStorage, so give it one for this test.
  const memory = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear()
  })
  const { client, fake } = await make()
  // The client normalizes a session's cwd (macOS `/tmp` is a symlink), so the group has to be
  // registered under the same path the list will report.
  const directory = client.projectPath("/tmp/ALWith/groups/波动分析")
  setGroup({
    id: "group-test",
    name: "波动分析",
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
    fake.listSessions.current = () => ({
      sessions: [
        {
          sessionId: "project-1",
          cwd: "/tmp/project",
          _meta: { codex: { nativeSessionId: "project-1", forkedFromId: null } }
        },
        {
          sessionId: "group-1",
          cwd: directory,
          _meta: { codex: { nativeSessionId: "group-1", forkedFromId: null } }
        }
      ]
    })
    await client.listSessions({ reset: true })
    // The sidebar list reads `sessionList` directly; a group's chat must not look like a project.
    expect(client.state.sessionList.map((row) => row.sessionId)).toEqual(["project-1"])
    // "继续上次" in the 群聊 panel reads the diverted rows, so the conversation stays reachable.
    expect(groupSessionRows().map((row) => row.sessionId)).toContain("group-1")
    expect(groupSessionRows().find((row) => row.sessionId === "group-1")?.cwd).toBe(directory)
  } finally {
    removeGroup("group-test")
    vi.unstubAllGlobals()
  }
})

test("scheduled codex exec runs are listed under 自动化运行, not under the project", async () => {
  const { client, fake } = await make()
  replaceAutomationSessionRows([])
  fake.listSessions.current = () => ({
    sessions: [
      {
        sessionId: "typed-1",
        cwd: "/tmp/project",
        title: "帮我看下这笔交易",
        _meta: { codex: { nativeSessionId: "typed-1", forkedFromId: null } }
      },
      {
        sessionId: "run-1",
        cwd: "/tmp/project",
        title: "# 提额监控表盘每日更新任务",
        _meta: { codex: { nativeSessionId: "run-1", forkedFromId: null } }
      },
      {
        sessionId: "run-2",
        cwd: "/tmp/project",
        title: "# 提额监控表盘每日更新任务\n\n按昨天的口径跑一遍",
        _meta: { codex: { nativeSessionId: "run-2", forkedFromId: null } }
      }
    ]
  })
  try {
    await client.listSessions({ reset: true })
    // One row per run would bury the project's real conversations in the sidebar.
    expect(client.state.sessionList.map((row) => row.sessionId)).toEqual(["typed-1"])
    expect(automationSessionRows().map((row) => row.sessionId).toSorted()).toEqual(["run-1", "run-2"])
  } finally {
    replaceAutomationSessionRows([])
    vi.unstubAllGlobals()
  }
})

test("a model-switch note names the destination and the timing", () => {
  expect(
    withoutModelSwitchNotes("模型已从 GPT-6.1 Terra 更改为 GPT-6.1-Sol（新会话才会使用 GPT-6.1-Sol 的身份说明）")
  ).toBe("—— 模型切换到 GPT-6.1-Sol 下次会话开始生效 ——")
})

test("the English form says the same thing", () => {
  expect(
    withoutModelSwitchNotes("Model switched from GPT-6.1 Terra to GPT-6.1-Sol (new sessions use Sol's persona)")
  ).toBe("—— switched to GPT-6.1-Sol; takes effect next session ——")
})

test("ordinary plan lines are left alone", () => {
  expect(withoutModelSwitchNotes("1. 打开设置\n2. 切换模型")).toBe("1. 打开设置\n2. 切换模型")
})

test("a scheduled run drops an effort and a speed switch the model does not publish", async () => {
  const { client, fake } = await make()
  const models: ReasoningModelFixture[] = [
    { id: "gpt-6.1-sol", groupId: "chatgpt", efforts: ["low", "medium"], defaultEffort: "medium" }
  ]
  configureReasoningModels(fake, models, "gpt-6.1-sol", "medium")
  const id = await client.newSession("/tmp/scheduled run")
  await new Promise((resolve) => setTimeout(resolve, 0))
  fake.events.length = 0

  // The task was saved while pointed at a model with `high` and acceleration, then re-pointed at
  // Sol. Writing either one now would make the agent reject it and the whole run would fail.
  await client.applyRunOverrides(id, "high", true)
  expect(fake.events.filter((event) => event.type === "config")).toEqual([])

  // A level the model does publish still lands, so the clamp is not a blanket skip.
  await client.applyRunOverrides(id, "low", false)
  expect(
    fake.events
      .filter((event) => event.type === "config")
      .map((event) => `${event.request.configId}=${String(event.request.value)}`)
  ).toEqual(["reasoning_effort=low"])
})

test("explicit native draft recovery bypasses a saved unavailable account model", async () => {
  const resolve = vi.fn(async (model: string | null) => {
    if (model?.startsWith("gateway:finture-enterprise:")) throw new Error("Account model unavailable")
    return "gateway:deepseek:deepseek-flash"
  })
  const { client, fake } = await make(undefined, undefined, { resolveModel: resolve })
  client.setModelSelections({ main: "gateway:finture-enterprise:company", chat: null })
  await expect(client.prepareDraft("main", "/tmp/recovery")).rejects.toThrow("Account model unavailable")
  const id = await client.prepareDraft("main", "/tmp/recovery", null, true)
  expect(fake.modelHints.get(id)).toBeNull()
  expect(resolve).toHaveBeenCalledTimes(1)
})

test.each(["main", "chat"] as const)(
  "%s drafts replace revoked account models without reusing the revoked session",
  async (owner) => {
    const accountModel = "gateway:finture-enterprise:company"
    let available = true
    const resolve = vi.fn(async (model: string | null, purpose?: string) => {
      if (model === accountModel && !available) {
        if (purpose === "draft") return null
        throw new Error("Account model unavailable")
      }
      return model
    })
    const { client, fake, port } = await make(undefined, undefined, { resolveModel: resolve })
    await registerGateway(port, {
      id: "finture-enterprise",
      name: "Enterprise",
      baseUrl: "https://gateway.example",
      bearerToken: "fake-token",
      models: [{ id: accountModel }],
      config: {}
    })
    client.setModelSelections({ main: accountModel, chat: accountModel })
    const previous = await client.prepareDraft(owner, "/tmp/enterprise-logout")
    available = false
    await unregisterGateway(port, "finture-enterprise")
    client.markAccountModelsUnavailable([previous])
    const confirmed = vi.fn()
    client.onConfirmedModel(confirmed)
    const replacement = await client.prepareDraft(owner, "/tmp/enterprise-logout")
    expect(replacement).not.toBe(previous)
    expect(fake.modelHints.get(replacement)).toBeNull()
    expect(fake.deleted.has(previous)).toBe(true)
    expect(client.session(replacement).readOnly).toBe(false)
    expect(confirmed).toHaveBeenCalledWith(owner, "gpt-6.1-sol")
    const next = await client.prepareDraft(owner, "/tmp/enterprise-next")
    expect(fake.modelHints.get(next)).not.toBe(accountModel)
  }
)

test("a refused replay is remembered instead of replayed on every attempt", async () => {
  let resumes = 0
  const { client } = await make((fake) => {
    fake.resumeResponse.current = () => {
      resumes += 1
      return Promise.reject(new Error("thread not loaded: 01a1e9e4"))
    }
  })
  const id = await client.newSession("/tmp/refused-replay")
  // A stopped session is the shape a restart leaves behind: the conversation exists, the engine
  // does not hold it. Reopening it is the only path that replays the rollout.
  await client.stopSession(id)
  // The agent wraps the app-server reason on the way out, so the test asserts "this replay failed"
  // and the replay count, not the wording — the wording is what `describeError` renders.
  const failure = await client.open(id, "/tmp/refused-replay", "main").catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(resumes).toBe(1)
  // `prepareDraft` replays whenever a session is not attached, and a store change is enough to run
  // it again. The second ask must be answered, not replayed: the rollout cannot become replayable.
  const again = await client.open(id, "/tmp/refused-replay", "main").catch((error: unknown) => error)
  expect((again as Error).message).toBe((failure as Error).message)
  expect(resumes).toBe(1)
  expect(client.state.sessions[id]?.restoring).toBe(false)
  // Leaving the chat is the reopen the recovery card asks for, so the next attempt is real.
  const other = await client.newSession("/tmp/refused-replay-other")
  await client.open(other, "/tmp/refused-replay-other", "main")
  const reopened = await client.open(id, "/tmp/refused-replay", "main").catch((error: unknown) => error)
  expect(reopened).toBeInstanceOf(Error)
  expect(resumes).toBe(2)
})

test("the reader's explicit retry replays for real instead of echoing the cached refusal", async () => {
  let resumes = 0
  let refuse = true
  const { client } = await make((fake) => {
    fake.resumeResponse.current = () => {
      resumes += 1
      if (refuse) return Promise.reject(new Error("thread not loaded: 01a1ea2a"))
      return Promise.resolve({ configOptions: [], availableCommands: [] }) as never
    }
  })
  const id = await client.newSession("/tmp/retry-replay")
  await client.stopSession(id)
  const failure = await client.open(id, "/tmp/retry-replay", "main").catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(resumes).toBe(1)
  // Automatic re-ask: still the cached answer, no new replay.
  await client.open(id, "/tmp/retry-replay", "main").catch(() => {})
  expect(resumes).toBe(1)
  // The card's 「重试」 marks the slot; the next open is a real attempt and can succeed.
  refuse = false
  client.retryReplay("main")
  await client.open(id, "/tmp/retry-replay", "main")
  expect(resumes).toBe(2)
  expect(client.state.sessions[id]?.attached).toBe(true)
})

test("a draft whose rollout the engine lost is replaced by a fresh draft, not stranded", async () => {
  const { client } = await make((fake) => {
    // The adapter answers a missing rollout with a resource-not-found RequestError, whose message
    // survives the runtime wrapper; a bare Error would be flattened to "Internal error".
    fake.resumeResponse.current = () => {
      throw RequestError.resourceNotFound("Session not found: 01a1ea2a")
    }
  })
  const first = await client.prepareDraft("main", "/tmp/dead-draft")
  await client.stopSession(first)
  // prepareDraft re-asks the unattached draft; the missing rollout must not strand the slot.
  const next = await client.prepareDraft("main", "/tmp/dead-draft")
  expect(next).not.toBe(first)
  expect(client.state.draftSessions[next]).toBe("main")
  expect(client.state.sessions[first]).toBeUndefined()
})

/**
 * 拉会、分工这类特殊模式在**同一条会话**上按角色轮换模型，所以它们与普通聊天共用一份引擎
 * 状态。下面几条锁住"角色写的东西不能变成读者的选择"这条边界：会话记录、跨厂商判定和
 * 恢复动作都必须以读者为准。
 */
function stubModelStorage(): Map<string, string> {
  const storage = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear()
  })
  return storage
}

test("a roster speaker never becomes the conversation's own recorded model", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low"], defaultEffort: "low" },
    { id: "architect", groupId: "chatgpt", efforts: ["low"], defaultEffort: "low" }
  ]
  const storage = stubModelStorage()
  const { client, fake } = await make((agent) => {
    configureReasoningModels(agent, models, "main-native", "low")
  })
  // 最终总纪要这一步故意失败：它是唯一一处把会话切回读者模型的地方，失败后若没有作用域隔离，
  // 记录里留下的就是最后一位发言人的模型，下次打开这条会话会直接用它。
  fake.promptError.current = (text) => (text.includes("最终总纪要") ? new Error("summary failed") : null)
  const id = await client.newSession("/tmp/group-record")
  try {
    await client.runGroupDiscussion(
      id,
      [
        { id: "r1", name: "架构师", model: "architect", effort: "low", instruction: "看架构", moderator: false },
        { id: "r2", name: "主持人", model: "architect", effort: "low", instruction: "定稿", moderator: true }
      ],
      1,
      "# 群说明",
      ""
    )
    const stored = JSON.parse(storage.get("alwith:session-models") ?? "{}") as Record<
      string,
      { model?: string | null }
    >
    expect(stored[id]?.model).toBe("main-native")
  } finally {
    vi.unstubAllGlobals()
  }
})

test("a role's model write never cancels the turn it is waiting behind", async () => {
  const models: ReasoningModelFixture[] = [
    { id: "main-native", groupId: "chatgpt", efforts: ["low"], defaultEffort: "low" },
    { id: "architect", groupId: "chatgpt", efforts: ["low"], defaultEffort: "low" }
  ]
  stubModelStorage()
  const { client, fake } = await make((agent) => {
    configureReasoningModels(agent, models, "main-native", "low")
  })
  const id = await client.newSession("/tmp/role-write")
  const respond = must(fake.configResponse.current, "missing config handler")
  // 引擎在上一轮收尾期间拒绝任何模型写入——正是这里最容易被误判成"读者在抢模型"。
  fake.configResponse.current = (request) => {
    if (request.configId === "model")
      throw RequestError.invalidRequest({ sessionId: request.sessionId }, "Wait for the current turn to finish")
    return respond(request)
  }
  try {
    await fake.pushUpdate(id, { sessionUpdate: "state_update", state: "running" })
    const internals = client as unknown as { writeRoleModel: (id: string, model: string) => Promise<void> }
    // 一直没等到 idle：角色切换等满一个窗口后如实失败，交上层记成"该角色缺席"。
    // 走读者的 setConfig 则会 force cancel 或 park——那会截断上一位的发言，或事后偷偷换模型。
    await expect(internals.writeRoleModel(id, "architect")).rejects.toThrow(/Wait for the current turn/)
    expect(fake.cancels).toEqual([])
    expect(client.pendingModelFor(id)).toBeNull()
    expect(
      client.session(id).configOptions.find((option) => option.configId === "model")?.currentValue as string | undefined
    ).toBe("main-native")
  } finally {
    vi.unstubAllGlobals()
  }
})

test("a role's hand-back prefers the reader's newest pick over the pair captured earlier", async () => {
  stubModelStorage()
  const { client } = await make()
  const id = await client.newSession("/tmp/group-handback")
  try {
    const internals = client as unknown as {
      sessionModels: Map<string, { model: string | null; effort: string | null }>
      pendingModelSwitches: Map<string, string>
      userWantedSelection: (
        id: string,
        fallback: { model: string; effort: string | null; fastMode: boolean }
      ) => { model: string; effort: string | null; fastMode: boolean }
    }
    const captured = { model: "main-native", effort: "low", fastMode: false }
    // 读者没动过：捕获的那一对就是答案。
    internals.sessionModels.set(id, { model: "main-native", effort: "low" })
    expect(internals.userWantedSelection(id, captured)).toEqual(captured)
    // 读者改了模型：记录里的 level 属于记录里的模型，跟着它一起回去。
    internals.sessionModels.set(id, { model: "user-pick", effort: "low" })
    expect(internals.userWantedSelection(id, captured)).toEqual({
      model: "user-pick",
      effort: "low",
      fastMode: false
    })
    // 读者在角色发言期间改的（引擎当时拒绝写入，选择被 park）比记录更新。
    internals.pendingModelSwitches.set(id, "parked-pick")
    // 被 park 的选择没有自己的 level：不能把上一个模型那一档带过去。
    expect(internals.userWantedSelection(id, captured)).toEqual({
      model: "parked-pick",
      effort: null,
      fastMode: false
    })
  } finally {
    vi.unstubAllGlobals()
  }
})
