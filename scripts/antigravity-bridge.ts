import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Readable, Writable } from "node:stream"

import * as acp from "@agentclientprotocol/sdk/unstable"

import { AntigravityUsageReader } from "./lib/antigravity-usage"

type Agent = { context: acp.ClientContext; ready: acp.InitializeResponse; usage: AntigravityUsageReader }
type Turn = { requestId: string; abort: AbortController; hasText: boolean; openingText: string }
type Message =
  | { type: "initialize" | "logout" }
  | { type: "login"; methodId: string }
  | { type: "usage"; readId: string }
  | {
      type: "turn"
      requestId: string
      model: string
      effort: string | null
      prompt: acp.ContentBlock[]
      /** Real project directory for an Agent turn. Absent keeps the legacy text-only temp dir. */
      cwd?: string
      /** Stable key to reuse one ACP session across turns. Absent keeps one-shot sessions. */
      sessionKey?: string
    }
  | { type: "cancel"; requestId: string }
  | { type: "permission_answer"; requestId: string; optionId: string | null }

type PermissionWaiter = { resolve: (optionId: string | null) => void }

const binary = process.argv[process.argv.indexOf("--binary") + 1]
if (!process.argv.includes("--binary") || !binary) throw new Error("Antigravity ACP binary was not supplied")

const turns = new Map<string, Turn>()
const sessions = new Map<string, Turn>()
/** Stable caller key -> ACP session id, so an Agent conversation survives across turns. */
const sessionKeys = new Map<string, string>()
/** requestId -> pending permission decision. */
const permissions = new Map<string, PermissionWaiter>()
let child: ReturnType<typeof spawn> | null = null
let starting: Promise<Agent> | null = null
const regionError = "User location is not supported for the API use."

function send(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function reportError(error: unknown, requestId?: string): void {
  send({ type: "error", requestId, message: (error instanceof Error ? error.message : String(error)).slice(0, 1000) })
}

function sendText(turn: Turn, text: string): void {
  if (text.trim() === "") return
  turn.hasText = true
  send({ type: "delta", requestId: turn.requestId, text })
}

function receiveText(turn: Turn, text: string): void {
  if (turn.hasText) {
    send({ type: "delta", requestId: turn.requestId, text })
    return
  }
  turn.openingText += text
  if (turn.openingText.length <= 256 && regionError.startsWith(turn.openingText.trim())) return
  sendText(turn, turn.openingText)
  turn.openingText = ""
}

function startAgent(): Promise<Agent> {
  if (starting !== null) return starting
  const processHandle = spawn(binary!, [], {
    cwd: process.env.ANTIGRAVITY_WORKDIR ?? homedir(),
    env: {
      ...process.env,
      NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(","),
      no_proxy: [process.env.no_proxy, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(",")
    },
    stdio: ["pipe", "pipe", "pipe"]
  })
  child = processHandle
  processHandle.stderr.on("data", (data: Buffer) => process.stderr.write(data))
  const stdout = Readable.toWeb(processHandle.stdout) as unknown as ReadableStream<Uint8Array>
  const stream = acp.ndJsonStream(Writable.toWeb(processHandle.stdin), stdout)
  const usage = new AntigravityUsageReader()
  const connection = acp
    .client({ name: "alwith-u-antigravity-bridge" })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      const turn = sessions.get(params.sessionId)
      // Legacy text-only turns have no Agent surface and no user to ask: keep cancelling them.
      // Only Agent turns carry a requestId that the host registered a permission waiter for.
      if (turn === undefined || turn.abort.signal.aborted) {
        return Promise.resolve({ outcome: { outcome: "cancelled" } })
      }
      const requestId = turn.requestId
      if (!permissions.has(requestId)) {
        return Promise.resolve({ outcome: { outcome: "cancelled" } })
      }
      const waiter = permissions.get(requestId)!
      return new Promise<{ outcome: acp.RequestPermissionOutcome }>((resolve) => {
        waiter.resolve = (optionId) =>
          resolve({ outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId } })
        const tool = params.toolCall as Record<string, unknown>
        send({
          type: "permission_request",
          requestId,
          toolCall: {
            toolCallId: tool.toolCallId ?? null,
            kind: tool.kind ?? "other",
            title: tool.title ?? null,
            status: tool.status ?? "pending"
          },
          options: (params.options ?? []).map((option) => ({
            optionId: option.optionId,
            name: option.name,
            kind: option.kind
          }))
        })
      })
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const update = params.update
      if (update.sessionUpdate === "available_commands_update") {
        usage.commands(
          params.sessionId,
          update.availableCommands.some((command) => command.name === "usage")
        )
        return
      }
      const turn = sessions.get(params.sessionId)
      if (turn === undefined || turn.abort.signal.aborted) return
      // Agent turns forward tool activity so the host can render tool cards. Legacy callers ignore
      // unknown event types, making this inert when no Agent surface consumes it.
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        const tool = update as unknown as Record<string, unknown>
        send({
          type: update.sessionUpdate,
          requestId: turn.requestId,
          toolCall: {
            toolCallId: tool.toolCallId ?? tool.id ?? null,
            kind: tool.kind ?? "other",
            title: tool.title ?? tool.name ?? null,
            status: tool.status ?? "pending"
          }
        })
        return
      }
      if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return
      const text = update.content.text
      if (typeof text !== "string" || text === "") return
      usage.text(params.sessionId, text)
      receiveText(turn, text)
    })
    .connect(stream)
  const ended = (error: Error): void => {
    if (child !== processHandle) return
    child = null
    starting = null
    for (const waiter of permissions.values()) waiter.resolve(null)
    permissions.clear()
    sessionKeys.clear()
    sessions.clear()
    connection.close(error)
    void usage.clear()
    send({ type: "exit" })
  }
  processHandle.once("error", ended)
  processHandle.once("close", (code) => ended(new Error(`Antigravity ACP exited (${code ?? "signal"})`)))
  const context = connection.agent
  starting = context
    .request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { auth: { terminal: true } }
    })
    .then((ready) => ({ context, ready, usage }))
    .catch((error: unknown) => {
      ended(new Error("Antigravity initialization failed"))
      processHandle.kill()
      throw error
    })
  return starting
}

function closeSession(agent: Agent, sessionId: string): void {
  const capabilities = agent.ready.agentCapabilities?.sessionCapabilities
  if (capabilities?.close !== undefined)
    void agent.context.request(acp.methods.agent.session.close, { sessionId }).catch(() => {})
  if (capabilities?.delete !== undefined)
    void agent.context.request(acp.methods.agent.session.delete, { sessionId }).catch(() => {})
}

async function selectOption(
  context: acp.ClientContext,
  sessionId: string,
  options: acp.SessionConfigOption[],
  category: string,
  value: string,
  signal: AbortSignal
): Promise<acp.SessionConfigOption[]> {
  const option = options.find((entry) => entry.type === "select" && entry.category === category)
  if (!option || option.type !== "select") {
    if (category !== "model") return options
    throw new Error("Antigravity did not publish its model choices. Check your Google sign-in in Settings → Models.")
  }
  if (option.currentValue === value) return options
  const choices = option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]))
  if (!choices.some((entry) => entry.value === value)) {
    throw new Error(`Antigravity does not offer ${value} for ${category} on this account.`)
  }
  const result = await context.request(
    acp.methods.agent.session.setConfigOption,
    {
      sessionId,
      configId: "configId" in option && typeof option.configId === "string" ? option.configId : option.id,
      value
    },
    { cancellationSignal: signal }
  )
  return result.configOptions ?? options
}

async function runTurn(message: Extract<Message, { type: "turn" }>): Promise<void> {
  const { requestId, model, effort, prompt, cwd, sessionKey } = message
  const isAgent = typeof cwd === "string" && cwd.trim() !== ""
  const turn: Turn = { requestId, abort: new AbortController(), hasText: false, openingText: "" }
  turns.set(requestId, turn)
  // Register the permission channel before any prompt: the ACP agent may ask while the turn runs.
  if (isAgent) permissions.set(requestId, { resolve: () => {} })
  const { signal } = turn.abort
  let directory: string | undefined
  let sessionId: string | undefined
  let agent: Agent | undefined
  let oneShot = true
  try {
    agent = await startAgent()
    signal.throwIfAborted()
    directory = isAgent ? cwd! : await mkdtemp(join(tmpdir(), "alwith-gemini-chat-"))
    const { context } = agent
    const reused = sessionKey === undefined ? undefined : sessionKeys.get(sessionKey)
    let fresh = false
    let options: acp.SessionConfigOption[] = []
    if (reused !== undefined) {
      // A resumed Agent session keeps its model/thought_level from the first turn; the host sends
      // the same ids and they are already selected, so re-applying them is unnecessary.
      sessionId = reused
      oneShot = false
    } else {
      const opened = await context.request(
        acp.methods.agent.session.new,
        { cwd: directory, mcpServers: [] },
        { cancellationSignal: signal }
      )
      sessionId = opened.sessionId
      options = opened.configOptions ?? []
      fresh = true
      if (sessionKey !== undefined) {
        sessionKeys.set(sessionKey, sessionId)
        oneShot = false
      }
    }
    signal.throwIfAborted()
    if (fresh) {
      options = await selectOption(context, sessionId, options, "model", model, signal)
      if (effort !== null) await selectOption(context, sessionId, options, "thought_level", effort, signal)
      signal.throwIfAborted()
    }
    sessions.set(sessionId, turn)
    const cancel = () => void context.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {})
    signal.addEventListener("abort", cancel, { once: true })
    try {
      const result = await context.request(
        acp.methods.agent.session.prompt,
        { sessionId, prompt },
        { cancellationSignal: signal }
      )
      signal.throwIfAborted()
      if (turn.openingText.trim() === regionError)
        throw new Error(
          "Google Antigravity 当前地区不支持 API 调用。 Google does not support Antigravity API access from the current location."
        )
      sendText(turn, turn.openingText)
      if (!turn.hasText) throw new Error(`Antigravity returned no chat text (${result.stopReason}).`)
      send({ type: "done", requestId, stopReason: result.stopReason })
    } finally {
      signal.removeEventListener("abort", cancel)
    }
  } catch (error) {
    if (!signal.aborted) reportError(error, requestId)
  } finally {
    turns.delete(requestId)
    const waiter = permissions.get(requestId)
    if (waiter !== undefined) {
      permissions.delete(requestId)
      waiter.resolve(null)
    }
    if (sessionId !== undefined) {
      sessions.delete(sessionId)
      // Reused Agent sessions stay alive for the next turn; only one-shot text sessions close.
      if (oneShot && agent !== undefined) closeSession(agent, sessionId)
    }
    // Never delete the caller's real project directory — only our own temp dirs are disposable.
    if (directory !== undefined && oneShot) await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

function accountTier(meta: Record<string, unknown> | null | undefined): unknown {
  return (meta?.antigravity as { tier?: unknown } | undefined)?.tier ?? null
}

async function readUsage(readId: string): Promise<void> {
  try {
    const agent = await startAgent()
    const { context, usage } = agent
    const result = await usage.read(
      {
        open: async (cwd, signal) => {
          const opened = await context.request(
            acp.methods.agent.session.new,
            { cwd, mcpServers: [] },
            { cancellationSignal: signal }
          )
          return { sessionId: opened.sessionId, tier: accountTier(opened._meta) }
        },
        prompt: (sessionId, text, signal) =>
          context.request(
            acp.methods.agent.session.prompt,
            {
              sessionId,
              prompt: [{ type: "text", text }]
            },
            { cancellationSignal: signal }
          ),
        close: (sessionId) => closeSession(agent, sessionId)
      },
      AbortSignal.timeout(15_000)
    )
    send({ type: "usage", readId, ...result })
  } catch {
    send({ type: "usage", readId, usage: { status: "error" } })
  }
}

async function account(message: Exclude<Message, { type: "turn" | "cancel" | "permission_answer" }>): Promise<void> {
  if (message.type === "usage") return readUsage(message.readId)
  const { context, ready, usage } = await startAgent()
  if (message.type === "initialize") {
    send({ type: "ready", agentInfo: ready.agentInfo ?? null, authMethods: ready.authMethods ?? [] })
  } else if (message.type === "login") {
    const response = await context.request(acp.methods.agent.authenticate, { methodId: message.methodId })
    send({ type: "logged_in", tier: accountTier(response?._meta) })
  } else {
    await context.request(acp.methods.agent.logout, {})
    await usage.clear()
    send({ type: "logged_out" })
  }
}

const lines = createInterface({ input: process.stdin })
let accountQueue = Promise.resolve()
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line) as Message
    if (message.type === "turn") void runTurn(message)
    else if (message.type === "cancel") turns.get(message.requestId)?.abort.abort()
    else if (message.type === "permission_answer") {
      const waiter = permissions.get(message.requestId)
      if (waiter !== undefined) {
        permissions.delete(message.requestId)
        waiter.resolve(message.optionId)
      }
    } else if (
      message.type === "initialize" ||
      message.type === "login" ||
      message.type === "logout" ||
      message.type === "usage"
    ) {
      accountQueue = accountQueue.then(() => account(message)).catch((error: unknown) => reportError(error))
    }
  } catch (error) {
    reportError(error)
  }
})

function stop(): void {
  const agent = starting
  child?.kill()
  void Promise.resolve(agent)
    .then((ready) => ready?.usage.clear())
    .catch(() => {})
    .finally(() => process.exit(0))
}

lines.on("close", stop)
process.on("SIGTERM", stop)
