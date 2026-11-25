import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { patchAdapter } from "../adapter-patch"

const original = readFileSync(new URL("../../../node_modules/@nyssance/codex-acp-v2/dist/index.js", import.meta.url), "utf8")
const source = patchAdapter(original)
function method(start: string, end: string, dependencies: Record<string, unknown> = {}) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  return new Function(...Object.keys(dependencies), `return ({${source.slice(from, to)}})`)(...Object.values(dependencies))
}
const routingStart = source.indexOf("class ProviderRouting {")
const routingEnd = source.indexOf("function readHints", routingStart)
const ProviderRouting = new Function("isRecord3", "gatewayModelId", "RequestError", `${source.slice(routingStart, routingEnd)}; return ProviderRouting`)(
  (value: unknown) => value !== null && typeof value === "object", (gateway: string, model: string) => `gateway:${gateway}:${model}`,
  { invalidParams: () => new Error("unavailable") }
)
function catalog() {
  const routing = new ProviderRouting({}, null)
  routing.gateways.set("custom-enterprise", {
    id: "custom-enterprise", runtimeId: "alwith", baseUrl: "http://127.0.0.1:12345/alwith",
    name: "Enterprise", headers: {}, bearerToken: "in-memory-only", config: {}, mode: "catalog",
    models: [{ id: "DS4.1", name: "Internal" }], catalogEntries: new Map()
  })
  return routing
}
const requestErrors = {
  invalidParams: (_data: unknown, message: string) => new Error(message),
  invalidRequest: (_data: unknown, message: string) => new Error(message),
  internalError: (_data: unknown, message: string) => new Error(message)
}
const sessionRoute = method("  async sessionRoute(request) {", "  getCollaborationMode(", {
  isRecord3: (value: unknown) => !!value && typeof value === "object", appendFileSync() {}, RequestError: requestErrors
}).sessionRoute
const resumeSession = method("  async resumeSession(request, onSubscribed", "  async forkSession(", {
  readAdditionalDirectories: (_cwd: string, directories: string[]) => directories,
  hostThreadOptions: () => ({}), readSessionLineage: async () => null
}).resumeSession
const rebind = method("  async rebindSessionProvider(session, model, force", "  async enqueueProviderUpdate(", {
  ModelId: { fromString: (model: string) => ({ model }) }, RequestError: requestErrors,
  isMissingRolloutError: () => false, isThreadNotMaterializedError: () => false,
  // Exercise bounded retries without spending 1.5 seconds on each failure case.
  setTimeout: (callback: () => void) => callback()
}).rebindSessionProvider

function rebindFixture(currentModel = "gateway:custom-enterprise:DS4.1", authProvider = "alwith") {
  const routing = catalog()
  routing.gateways.set("other-enterprise", {
    ...routing.gateway("custom-enterprise"), id: "other-enterprise", name: "Other enterprise",
    baseUrl: "http://127.0.0.1:12345/other", config: { enterprise_policy: "other" }
  })
  const session = {
    sessionId: "same-thread", currentModelId: currentModel, authProvider,
    cwd: "/workspace", additionalDirectories: ["/extra"], mcpServers: [{ name: "tools" }],
    instructions: { text: "keep instructions" }, account: { id: "previous" }, authConfigured: false
  }
  const calls = { resumes: [] as any[], configs: [] as (string | null)[], unsubscribes: [] as any[],
    releases: 0, reservations: 0, authReads: [] as any[], restarts: 0, closed: 0 }
  const client: any = {
    providerCatalog: routing, sessionRoute, resumeSession,
    getModelProvider: () => null,
    codexClient: { threadRead: async () => ({ thread: { model: routing.upstreamModel(currentModel), modelProvider: authProvider } }) },
    resolveSessionInstructions: async (_request: any, previous: any) => previous,
    refreshSkills: async () => {},
    createSessionConfig: async (_cwd: string, _directories: string[], _servers: any[], gatewayId: string | null) => {
      calls.configs.push(gatewayId)
      return { config: client.providerCatalog.threadConfig(gatewayId), skippedMcpServers: [] }
    },
    resumeThreadWithInstructions: async (params: any) => {
      calls.resumes.push(params)
      return fixture.respond(params, calls.resumes.length)
    },
    fetchAvailableModels: async () => [],
    createModelId: (_models: any[], model: string) => model,
    getCollaborationMode: () => null,
    appServerClient: {
      threadTurnsList: async () => ({}),
      threadUnsubscribe: async (params: any) => { calls.unsubscribes.push(params) }
    }
  }
  const agent: any = {
    codexAcpClient: client, alwith: { predictions: { cancel() {} } }, activePrompts: new Map(),
    assertSessionWritable() {}, isSessionBusy: () => false,
    acquireTurnStartReservation: () => {
      calls.reservations++
      return { wait: Promise.resolve(), release() { calls.releases++ } }
    },
    getSessionGeneration: () => 1, sessionPublishIsCurrent: () => true,
    getAuthStateForProvider: async (provider: string) => {
      calls.authReads.push(provider)
      return { account: { id: "next" }, authConfigured: true }
    },
    restartCodexClient: async () => { calls.restarts++; throw new Error("Unexpected process restart") },
    closeSession: async () => { calls.closed++ }
  }
  const fixture = {
    routing, session, calls, client, agent,
    respond: (params: any, _attempt: number): any => ({
      thread: { id: params.threadId, status: "idle" }, model: params.model, modelProvider: params.modelProvider
    }),
    switch: (model: string, force = false, rollbackRouting = routing) => rebind.call(agent, session, model, force, rollbackRouting)
  }
  return fixture
}

const logger = { log() {} }
const restart = method("  async restartEngineForProvider(provider) {", "  async waitForProviderUpdate()", {
  appendFileSync() {}, logger,
  toToml: (entry: Record<string, string>) => `{${Object.entries(entry).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",")}}`
}).restartEngineForProvider
const resume = method("  async resumeThread(params, allowReadOnly", "  async resumeSession(", {
  appendFileSync() {}, logger, AgentMode: { fromThread: () => "default" },
  providerResolutionOf: (error: any) => error.provider ? { provider: error.provider, missing: false } : null,
  errorText: String, isThreadActiveWriterError: () => false, isMissingRolloutError: () => false
}).resumeThread

async function isolatedConfig(run: () => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "adapter-restart-"))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = directory
  writeFileSync(join(directory, "config.toml"), "# No provider declarations\n")
  try { await run() } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    rmSync(directory, { recursive: true, force: true })
  }
}

test("staging applies all pinned fixes and refuses mismatched adapter sources", () => {
  expect(source).not.toContain("!this.providerCatalog?.hasGateway?.(provider)")
  expect(() => patchAdapter("unexpected bundle")).toThrow("anchor")
  for (const anchor of [
    "    const gatewayOf = (id) => {",
    "    if (!force && target === current && target !== null)",
    "        const authProvider = metadata.modelProvider ?? null;"
  ]) {
    expect(() => patchAdapter(original.replace(anchor, "changed anchor"))).toThrow("anchor")
  }
  expect(() => patchAdapter(`${original}\n${original}`)).toThrow("anchor")
})

/** Extracts top-level declarations from the patched bundle so they can be executed for real. */
function declarations(start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  expect(from).toBeGreaterThan(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

const toolNames = new Function(
  `${declarations("function functionToolName(name, namespace) {", "function commandToolName(source) {")}; return { functionToolName, normalizeCommandToolName }`
)() as {
  functionToolName: (name: string, namespace?: string) => string
  normalizeCommandToolName: (raw: string) => string
}
const normalizeResponsesFrame = new Function(
  `${declarations("function normalizeResponsesFrame(raw) {", "function normalizeWsFrame(data) {")}; return normalizeResponsesFrame`
)() as (raw: unknown) => unknown

test("legacy exec tool calls are normalized without touching the exec literals that are metadata", () => {
  expect(source).toContain("normalizeCommandToolName")
  expect(toolNames.normalizeCommandToolName("exec")).toBe("exec_command")
  for (const untouched of ["exec_command", "write_stdin", "request_permissions", "foo", "nsexec", ""]) {
    expect(toolNames.normalizeCommandToolName(untouched)).toBe(untouched)
  }
  // A bare legacy name becomes the registry name; a namespaced one is left alone.
  expect(toolNames.functionToolName("exec")).toBe("exec_command")
  expect(toolNames.functionToolName("exec", "mcp__server__")).toBe("mcp__server__exec")
  expect(toolNames.functionToolName("exec_command")).toBe("exec_command")
  // `"exec"` is also session metadata and a human-readable guardian label. Those strings are not
  // tool names, so they must survive the patch byte-for-byte.
  for (const metadata of [
    'var SOURCES = new Set(["cli", "vscode", "exec", "appServer", "unknown"]);',
    '    sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],',
    '    case "unifiedExec":\n      return "exec";'
  ]) {
    expect(source).toContain(metadata)
    expect(original).toContain(metadata)
  }
})

test("streamed Responses frames only rename tool-call items named exec", () => {
  const frame = (item: Record<string, unknown>) => JSON.stringify({ type: "response.output_item.added", item })
  const rename = (item: Record<string, unknown>) => JSON.parse(normalizeResponsesFrame(frame(item)) as string).item.name
  expect(rename({ type: "function_call", name: "exec", arguments: "{}", call_id: "c1" })).toBe("exec_command")
  expect(rename({ type: "custom_tool_call", name: "exec", input: "", call_id: "c2" })).toBe("exec_command")
  // Only the name changes; every other field is preserved for the engine.
  const rewritten = JSON.parse(normalizeResponsesFrame(frame({ type: "function_call", name: "exec", call_id: "c1" })) as string)
  expect(rewritten.item).toEqual({ type: "function_call", name: "exec_command", call_id: "c1" })
  expect(rewritten.type).toBe("response.output_item.added")
  // Non tool-call items and non-exact names pass through untouched.
  expect(rename({ type: "function_call_output", name: "exec", output: "ok" })).toBe("exec")
  expect(rename({ type: "message", name: "exec" })).toBe("exec")
  expect(rename({ type: "function_call", name: "exec_command" })).toBe("exec_command")
  expect(rename({ type: "function_call", name: "nsexec" })).toBe("nsexec")
  // Fast path and malformed input return the original value, never a re-serialized frame.
  for (const passthrough of ['{"type":"response.created"}', "not json at all", "", 42, null, undefined, ['"exec"']]) {
    expect(normalizeResponsesFrame(passthrough) as unknown).toBe(passthrough)
  }
  expect(normalizeResponsesFrame('{"item":"exec"') as string).toBe('{"item":"exec"')
  // The relay actually uses the helper for upstream -> downstream frames.
  expect(source).toContain("downstream.send(binary ? data : normalizeWsFrame(data), { binary }, (error) => {")
})

test("different logical gateways on alwith resume the same thread with the target config, without restarting", async () => {
  const fixture = rebindFixture()
  await fixture.switch("gateway:other-enterprise:DS4.1")
  expect(fixture.calls.resumes).toHaveLength(1)
  expect(fixture.calls.resumes[0]).toMatchObject({
    threadId: "same-thread", cwd: "/workspace", model: "other-enterprise/DS4.1", modelProvider: "alwith",
    developerInstructions: undefined,
    config: { enterprise_policy: "other", model_providers: { alwith: { base_url: "http://127.0.0.1:12345/other" } } }
  })
  expect(fixture.calls.configs).toEqual(["other-enterprise"])
  expect(fixture.calls.unsubscribes).toEqual([{ threadId: "same-thread" }])
  expect(fixture.calls.authReads).toEqual(["alwith"])
  expect(fixture.session.account).toEqual({ id: "next" })
  expect(fixture.calls.releases).toBe(1)
  expect(fixture.calls.restarts).toBe(0)
})

test("same logical gateway is a no-op unless forced", async () => {
  const fixture = rebindFixture()
  await fixture.switch(fixture.session.currentModelId)
  expect(fixture.calls.resumes).toHaveLength(0)
  expect(fixture.calls.reservations).toBe(0)
  await fixture.switch(fixture.session.currentModelId, true)
  expect(fixture.calls.resumes).toHaveLength(1)
  expect(fixture.calls.releases).toBe(1)
  expect(fixture.calls.restarts).toBe(0)
})

test("native alwith to enterprise applies enterprise overrides to the same session", async () => {
  const fixture = rebindFixture("gpt-native")
  await fixture.switch("gateway:other-enterprise:DS4.1")
  expect(fixture.calls.resumes).toHaveLength(1)
  expect(fixture.calls.resumes[0]).toMatchObject({
    threadId: "same-thread", modelProvider: "alwith", model: "other-enterprise/DS4.1",
    config: { enterprise_policy: "other" }
  })
  expect(fixture.calls.restarts).toBe(0)
})

test("an idle native thread switches even before its first turn without resuming or closing it", async () => {
  for (const provider of ["alwith", "openai"]) {
    const fixture = rebindFixture("native-first", provider)
    fixture.respond = () => { throw new Error("thread not materialized") }
    await fixture.switch("native-first")
    await fixture.switch("DS4.1")
    expect(fixture.calls.unsubscribes).toHaveLength(0)
    expect(fixture.calls.closed).toBe(0)
    fixture.agent.activePrompts.set(fixture.session.sessionId, {})
    await expect(fixture.switch("native-second")).rejects.toThrow("Wait for the current turn")
  }
})

test("explicit native and qualified picks sharing a slug resolve to distinct routes", async () => {
  const fixture = rebindFixture()
  const route = (model: string, sessionId?: string) => fixture.client.sessionRoute({ sessionId, _meta: { alwith: { model } } })
  expect(await route("DS4.1")).toEqual({ gatewayId: null, model: "DS4.1", modelProvider: null })
  expect(await route("DS4.1", "same-thread")).toEqual({ gatewayId: null, model: "DS4.1", modelProvider: "alwith" })
  expect(await route("gateway:other-enterprise:DS4.1")).toEqual({ gatewayId: "other-enterprise", model: "other-enterprise/DS4.1", modelProvider: "alwith" })
  await expect(route("gateway:removed:DS4.1")).rejects.toThrow("unavailable")
  await fixture.switch("DS4.1")
  expect(fixture.calls.configs).toEqual([null])
  expect(fixture.calls.resumes[0]).toMatchObject({ threadId: "same-thread", model: "DS4.1", modelProvider: "alwith", config: {} })
  const pinned = rebindFixture(undefined, "custom-enterprise")
  await expect(pinned.switch("DS4.1")).rejects.toThrow("pinned")
  expect(pinned.calls.unsubscribes).toHaveLength(0)
})

test("reopening a shared thread restores only its recorded logical route", async () => {
  for (const [model, gatewayId] of [["gateway:other-enterprise:DS4.1", "other-enterprise"], ["DS4.1", null]] as const) {
    const fixture = rebindFixture(model)
    expect(await fixture.client.sessionRoute({ sessionId: "same-thread" })).toMatchObject({ gatewayId, modelProvider: "alwith" })
  }
})

test("a removed recorded provider is never replaced by a different seller of the same model", async () => {
  const fixture = rebindFixture("DS4.1", "removed-service")
  expect(await fixture.client.sessionRoute({ sessionId: "same-thread" })).toEqual({ gatewayId: null, modelProvider: "removed-service" })
})

test("resume failure restores the previous selection and routing without publishing auth", async () => {
  const fixture = rebindFixture()
  const previousRouting = catalog()
  const observedRouting: unknown[] = []
  fixture.respond = (params, attempt) => {
    observedRouting.push(fixture.client.providerCatalog)
    if (attempt === 1) throw new Error("target resume failed")
    return { thread: { id: params.threadId }, model: params.model, modelProvider: params.modelProvider }
  }
  await expect(fixture.switch("gateway:other-enterprise:DS4.1", false, previousRouting)).rejects.toThrow("target resume failed")
  expect(fixture.calls.resumes.map((params) => params.model)).toEqual(["other-enterprise/DS4.1", "custom-enterprise/DS4.1"])
  expect(observedRouting).toEqual([fixture.routing, previousRouting])
  expect(fixture.client.providerCatalog).toBe(fixture.routing)
  expect(fixture.calls.authReads).toEqual([])
  expect(fixture.session.account).toEqual({ id: "previous" })
  expect(fixture.session.authConfigured).toBe(false)
  expect(fixture.calls.closed).toBe(0)
  expect(fixture.calls.releases).toBe(1)
})

test("failed rollback closes the session and still releases the reservation", async () => {
  const fixture = rebindFixture()
  fixture.respond = () => { throw new Error("resume failed") }
  await expect(fixture.switch("gateway:other-enterprise:DS4.1")).rejects.toThrow("Provider selection and rollback failed; session closed")
  expect(fixture.calls.resumes).toHaveLength(2)
  expect(fixture.calls.closed).toBe(1)
  expect(fixture.calls.releases).toBe(1)
  expect(fixture.client.providerCatalog).toBe(fixture.routing)
  expect(fixture.calls.authReads).toEqual([])
})

test("busy sessions and active prompts reject cross-gateway switches before resuming", async () => {
  for (const busy of [true, false]) {
    const fixture = rebindFixture()
    fixture.agent.isSessionBusy = () => busy
    if (!busy) fixture.agent.activePrompts.set(fixture.session.sessionId, {})
    await expect(fixture.switch("gateway:other-enterprise:DS4.1")).rejects.toThrow("Wait for the current turn")
    expect(fixture.calls.resumes).toHaveLength(0)
    expect(fixture.calls.reservations).toBe(0)
    expect(fixture.calls.restarts).toBe(0)
  }
})

test("legacy provider pinning still rejects vendor changes unless forced", async () => {
  const fixture = rebindFixture(undefined, "custom-enterprise")
  await expect(fixture.switch("gateway:other-enterprise:DS4.1")).rejects.toThrow('pinned to the "custom-enterprise" provider')
  expect(fixture.calls.resumes).toHaveLength(0)
  await fixture.switch("gateway:other-enterprise:DS4.1", true)
  expect(fixture.calls.resumes).toHaveLength(1)
  expect(fixture.session.authProvider).toBe("alwith")
})

test("persistent mismatched or missing provider metadata exhausts bounded retries and rolls back without false success", async () => {
  for (const modelProvider of ["wrong-provider", undefined]) {
    const fixture = rebindFixture()
    fixture.respond = (params) => ({ thread: { id: params.threadId }, model: params.model,
      modelProvider: params.model === "custom-enterprise/DS4.1" ? "alwith" : modelProvider })
    await expect(fixture.switch("gateway:other-enterprise:DS4.1")).rejects.toThrow("did not match the selected runtime after resume retries")
    expect(fixture.calls.resumes.map((params) => params.model)).toEqual([
      ...Array(4).fill("other-enterprise/DS4.1"), "custom-enterprise/DS4.1"
    ])
    expect(fixture.calls.authReads).toEqual([])
    expect(fixture.session.authProvider).toBe("alwith")
    expect(fixture.session.account).toEqual({ id: "previous" })
    expect(fixture.session.authConfigured).toBe(false)
    expect(fixture.calls.releases).toBe(1)
    expect(fixture.calls.restarts).toBe(0)
  }
})

test("a provider that settles within the retry bound publishes auth only after matching", async () => {
  const fixture = rebindFixture()
  fixture.respond = (params, attempt) => {
    expect(fixture.calls.authReads).toEqual([])
    return { thread: { id: params.threadId }, model: params.model, modelProvider: attempt < 3 ? "old-runtime" : "alwith" }
  }
  await fixture.switch("gateway:other-enterprise:DS4.1")
  expect(fixture.calls.resumes).toHaveLength(3)
  expect(fixture.calls.authReads).toEqual(["alwith"])
  expect(fixture.calls.releases).toBe(1)
})

test("a shared runtime acknowledging the old logical model cannot confirm a switch", async () => {
  const fixture = rebindFixture()
  fixture.respond = (params) => ({ thread: { id: params.threadId }, model: "custom-enterprise/DS4.1", modelProvider: "alwith" })
  fixture.agent.activePrompts.set("unrelated-thread", { completion: new Promise(() => {}) })
  await expect(fixture.switch("gateway:other-enterprise:DS4.1")).rejects.toThrow("did not match")
  expect(fixture.calls.resumes.map((call) => call.model)).toEqual([
    ...Array(4).fill("other-enterprise/DS4.1"), "custom-enterprise/DS4.1"
  ])
  expect(fixture.calls.authReads).toEqual([])
  expect(fixture.calls.closed).toBe(0)
})

test("an unconfirmed rollback closes the session rather than accepting a prompt on an unknown route", async () => {
  const fixture = rebindFixture()
  fixture.respond = (params, attempt) => {
    if (attempt === 1) throw new Error("target rejected")
    return { thread: { id: params.threadId }, model: "other-enterprise/DS4.1", modelProvider: "alwith" }
  }
  await expect(fixture.switch("gateway:other-enterprise:DS4.1")).rejects.toThrow("rollback failed")
  expect(fixture.calls.closed).toBe(1)
  expect(fixture.calls.authReads).toEqual([])
})

test("registered restart hook resumes legacy enterprise using a process-only alias and qualified model", async () => {
  await isolatedConfig(async () => {
    const routing = catalog()
    let resumed: any
    let starts = 0
    const replacement: any = {
      providerCatalog: routing,
      codexClient: {
        threadRead: async () => ({ thread: { model: "DS4.1" } }),
        threadResume: async (params: any) => {
          resumed = params
          return { thread: {}, model: params.model, modelProvider: params.modelProvider }
        }
      },
      resumeThread: resume, initialize: async () => {}
    }
    const agent: any = {
      codexAcpClient: { providerCatalog: routing }, initializeRequest: {},
      codexProcessState: { appServerStartupArgs: ["app-server", "-c", 'model_provider="alwith"'], modelProvider: "alwith" },
      recovery: { completeReplacement() {} },
      restartCodexClient: async () => { starts++; return replacement },
      installCodexClient(client: any) { this.codexAcpClient = client }, restartEngineForProvider: restart
    }
    // Execute the bundle's actual hook registration, rather than a test-only restart callback.
    const registration = source.match(/this\.codexAcpClient\.restartForProvider = \(provider\) => this\.restartEngineForProvider\(provider\);/)![0]
    new Function(registration).call(agent)
    const client = agent.codexAcpClient
    client.codexClient = { threadResume: async () => { throw Object.assign(new Error("provider unavailable"), { provider: "custom-enterprise" }) } }
    const result = await resume.call(client, { threadId: "legacy", config: {} })
    expect(starts).toBe(1)
    expect(result.modelProvider).toBe("custom-enterprise")
    expect(resumed.model).toBe("custom-enterprise/DS4.1")
    expect(resumed.config.model_providers["custom-enterprise"].base_url).toBe("http://127.0.0.1:12345/alwith")
    const args = agent.codexProcessState.appServerStartupArgs.join(" ")
    expect(args).toContain("model_providers.custom-enterprise=")
    expect(args).toContain('model_provider="custom-enterprise"')
    expect(args).not.toContain("in-memory-only")
    expect(readFileSync(join(process.env.CODEX_HOME!, "config.toml"), "utf8")).toBe("# No provider declarations\n")
  })
})

test("missing gateways do not spawn a provider and missing hooks preserve the original error", async () => {
  await isolatedConfig(async () => {
    let starts = 0
    const agent: any = {
      codexAcpClient: { providerCatalog: catalog() }, codexProcessState: {}, recovery: {}, initializeRequest: {},
      restartCodexClient: async () => { starts++ }
    }
    expect(await restart.call(agent, "removed-enterprise")).toBeNull()
    expect(starts).toBe(0)
    const error = Object.assign(new Error("provider unavailable"), { provider: "custom-enterprise" })
    await expect(resume.call({ codexClient: { threadResume: async () => { throw error } } }, { threadId: "legacy" })).rejects.toBe(error)
  })
})

test("runtime selection preserves shared alwith and qualifies a legacy logical provider", async () => {
  const sessionRoute = method("  async sessionRoute(request) {", "  getCollaborationMode(", { isRecord3: (v: unknown) => !!v && typeof v === "object", appendFileSync() {} }).sessionRoute
  const routing = catalog()
  const client: any = { providerCatalog: routing, codexClient: { threadRead: async () => ({ thread: { model: "DS4.1", modelProvider: "custom-enterprise" } }) } }
  expect(await sessionRoute.call(client, { sessionId: "old" })).toEqual({ gatewayId: "custom-enterprise", modelProvider: "custom-enterprise", model: "custom-enterprise/DS4.1" })
  const selected = await sessionRoute.call(client, { _meta: { alwith: { model: "gateway:custom-enterprise:DS4.1" } } })
  expect(selected).toEqual({ gatewayId: "custom-enterprise", modelProvider: "alwith", model: "custom-enterprise/DS4.1" })
  client.codexClient.threadRead = async () => ({ thread: { model: "custom-enterprise/DS4.1", modelProvider: "custom-enterprise" } })
  expect((await sessionRoute.call(client, { sessionId: "old" })).model).toBe("custom-enterprise/DS4.1")
})
