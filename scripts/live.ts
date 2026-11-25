#!/usr/bin/env bun
// Live check against a real Codex login: two read-only conversations run
// concurrently and stay isolated; attach and a fresh agent both replay the original history.
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  isBooleanOption,
  isFormElicitation,
  isStringProperty,
  isText,
  type Session,
  WebSocketRuntimeClient
} from "@alwith/api"
import { ProcessRuntimeClient } from "@alwith/api/node"
import {
  asyncQuestionId,
  asyncQuestions,
  questionReplies,
  questionReplyEnvelope
} from "@alwith/module-chat/async-question-card"

import { CodexClient } from "../src/agent/client"
import { nativeGroupModels, selectedModelId } from "../src/agent/native-models"
import { codexTurnId, codexTurnStartedAt } from "@nyssance/codex-acp-v2/client"
import { computerRuntimeEnv } from "../src/features/computer/runtime-config"
import { completedRun } from "../src/features/automation/run-outcome"
import { setActivePreview } from "../src/lib/active-preview"
import { startModelProbe } from "./lib/live-model-router"
import { staged, stagedCodexEngine, startRuntime } from "./lib/runtime"

function isNotice(item: Session["items"][number]): boolean {
  if (item.kind !== "assistant") return false
  const codex = item._meta?.codex
  return typeof codex === "object" && codex !== null && (codex as { notice?: unknown }).notice === true
}

// Notices (warnings, reroutes) are not part of the persisted transcript, so replay omits them.
function assistantText(session: Session): string {
  return session.items
    .filter((item) => item.kind === "assistant" && !isNotice(item))
    .flatMap((item) => (item.kind === "assistant" ? item.content : []))
    .filter(isText)
    .map((block) => block.text)
    .join("")
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

async function verifyHistory(client: CodexClient, directory: string, replies: Map<string, string>): Promise<void> {
  await client.listSessions({ reset: true })
  const projectThreads = await client.listProjectSessions(directory)
  if (projectThreads.some((sessionRow) => sessionRow.cwd !== directory))
    throw new Error("Project list includes another directory")
  for (const [id, original] of replies) {
    const exported = await client.exportHistory(id, () => {})
    const messages = exported
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; message: { content: unknown } })
    const exportedText = messages
      .filter((message) => message.type === "assistant")
      .flatMap((message) => message.message.content as { type: string; text: string }[])
      .map((block) => block.text)
      .join("")
    if (exportedText.trim() !== original.trim() || messages.filter((message) => message.type === "user").length !== 1)
      throw new Error(`Read-only export of ${id} differs from the live transcript`)
    if (!projectThreads.some((sessionRow) => sessionRow.sessionId === id))
      throw new Error(`Thread ${id} missing from project list`)
    if (!client.state.sessionList.some((sessionRow) => sessionRow.sessionId === id))
      throw new Error(`Thread ${id} missing from session/list`)
    await client.open(id, directory)
    if (!client.session(id).commands.some((command) => command.name === "status"))
      throw new Error("Resumed session has no status command")
    // WebSocket history notifications can arrive after open resolves, in separate batches.
    await until(
      () =>
        client.session(id).items.some((item) => item.kind === "user") &&
        assistantText(client.session(id)).trim() === original.trim(),
      10_000,
      `complete history replay for ${id}`
    )
    const replayed = client.session(id)
    const users = replayed.items.filter((item) => item.kind === "user").length
    if (users !== 1) throw new Error(`Expected one user message in ${id}, saw ${users}`)
    if (assistantText(replayed).trim() !== original.trim())
      throw new Error(`Replay of ${id} differs from the live transcript`)
  }
}

async function verifyModelSwitch(
  client: CodexClient,
  directory: string,
  port: ProcessRuntimeClient | WebSocketRuntimeClient,
  probe?: ReturnType<typeof startModelProbe>
): Promise<void> {
  const id = await client.newSession(directory)
  try {
    const options = client.session(id).configOptions
    const current = selectedModelId(options)
    const models = nativeGroupModels(options)?.models.map((entry) => entry.id).filter((id) => /^gpt-/i.test(id)) ?? []
    const first = probe && models.includes("gpt-6.2-sol") ? "gpt-6.2-sol" : current !== null && models.includes(current) ? current : models[0]
    const second = models.find((model) => model !== first)
    if (!first || !second) throw new Error(`Model switch needs two advertised GPT models; found ${models.length}`)
    const turns = [[first, first], [second, second]] as [string, string][]
    const catalog: { models: { slug: string; multi_agent_reasoning_effort?: string }[] } | undefined = probe
      ? JSON.parse(Bun.spawnSync([staged("codex"), "debug", "models", "--bundled"]).stdout.toString()) : undefined
    if (probe) {
      const gatewayTurns: [string, string][] = []
      for (const gateway of ["probe-a", "probe-b"]) {
        await port.acpRequest("codex", "providers/set", {
          providerId: "openai", apiType: "openai", baseUrl: probe.url,
          _meta: { codex: { id: gateway, name: gateway, mode: "catalog", runtimeId: "alwith" }, alwith: { models: [{ id: first, label: first }] } }
        })
        gatewayTurns.push([`gateway:${gateway}:${first}`, `${gateway}/${first}`])
      }
      turns.unshift(...gatewayTurns)
    }
    const verifyTurn = async (sessionId: string, target: string, upstream: string, fastChoice = true) => {
      const marker = `ROUTE_${crypto.randomUUID().slice(0, 8)}`
      await client.setConfig(sessionId, "model", target)
      if (selectedModelId(client.session(sessionId).configOptions) !== target) throw new Error(`Switch did not land: ${target}`)
      const config = client.session(sessionId).configOptions
      const levels = nativeGroupModels(config)?.models.find((entry) => entry.id === target)?.efforts
      const effort = probe && levels?.length ? (fastChoice ? levels.at(-1) : levels[0]) : undefined
      const fast = probe && !target.startsWith("gateway:") && config.some((option) => option.configId === "fast-mode" && isBooleanOption(option)) ? fastChoice : undefined
      if (effort !== undefined) await client.setConfig(sessionId, "effort", effort)
      if (fast !== undefined) await client.setConfig(sessionId, "fast-mode", fast)
      const receipt = await client.prompt(sessionId, [{ type: "text", text: `Reply with exactly ${marker} and nothing else.` }])
      await until(() => {
        const session = client.session(sessionId)
        if (session.state !== "idle" || !Object.hasOwn(session.turnEndedAt, receipt)) return false
        if (session.error !== null) throw new Error(`Turn on ${target} failed: ${JSON.stringify(session.error)}`)
        if (!assistantText(session).includes(marker)) throw new Error(`Turn on ${target} did not return its marker`)
        return true
      }, 90_000, `reply on ${target}`)
      const wireEffort = effort === "ultra" ? catalog?.models.find((row) => row.slug === target)?.multi_agent_reasoning_effort : effort
      if (effort === "ultra" && !wireEffort) throw new Error(`Missing Ultra orchestration effort for ${target}`)
      probe?.assertModel(marker, upstream, wireEffort, fast, effort === "ultra")
      console.log(`model switch: received the turn marker on selected model ${target}`)
    }
    for (const [target, upstream] of turns) await verifyTurn(id, target, upstream)
    if (probe) {
      await verifyTurn(id, first, first, false)
      const before = `ROUTE_${crypto.randomUUID().slice(0, 8)}`
      const after = `ROUTE_${crypto.randomUUID().slice(0, 8)}`
      const release = probe.hold(before)
      const send = (marker: string) => client.prompt(id, [{ type: "text", text: `Reply with exactly ${marker} and nothing else.` }])
      const current = send(before)
      const target = `gateway:probe-b:${first}`
      try {
        await until(() => probe.received(before), 30_000, "held model request")
        await client.setConfig(id, "model", target)
        if (client.pendingModelFor(id) !== target || selectedModelId(client.session(id).configOptions) !== first)
          throw new Error("Mid-turn choice changed the active route or was not accepted")
      } finally {
        release()
      }
      const receipt = await current
      await until(() => Object.hasOwn(client.session(id).turnEndedAt, receipt) && assistantText(client.session(id)).includes(before), 30_000, "original answer completes")
      await send(after)
      await until(() => client.session(id).state === "idle" && assistantText(client.session(id)).includes(after), 30_000, "first answer after switch")
      probe.assertModel(before, first)
      probe.assertModel(after, `probe-b/${first}`)
      console.log("mid-turn switch: original answer finished; next request used the selected gateway")
      const sibling = await client.newSession(directory)
      try {
        await Promise.all([
          verifyTurn(id, `gateway:probe-a:${first}`, `probe-a/${first}`),
          verifyTurn(sibling, `gateway:probe-b:${first}`, `probe-b/${first}`)
        ])
        console.log("model isolation: concurrent sessions reached their own gateways")
      } finally {
        await client.delete(sibling)
      }
    }
  } finally {
    await client.delete(id)
  }
}

async function check(transport: "stdio" | "ws", probe?: ReturnType<typeof startModelProbe>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `alwith-u-live-${transport}-`)))
  await writeFile(join(directory, "README.md"), "# live check\n")
  console.log(`project: ${directory}`)

  const engine = stagedCodexEngine()
  if (probe) {
    const home = join(directory, "home")
    const codexHome = join(home, ".codex")
    await mkdir(codexHome, { recursive: true })
    Object.assign(engine.env, { HOME: home, CODEX_HOME: codexHome, ALWITH_U_ROUTER_BASE: probe.url,
      ALWITH_U_ROUTER_TOKEN: "local-probe", OPENAI_BASE_URL: probe.url, OPENAI_API_KEY: "local-probe", ALWITH_U_MODEL_CATALOG: "" })
  }
  const runtime = transport === "ws" ? await startRuntime(join(directory, "journal"), engine) : null
  const port = runtime
    ? new WebSocketRuntimeClient(runtime.url, runtime.token)
    : new ProcessRuntimeClient({
        binary: staged("alwith-runtime"),
        engines: { codex: engine },
        journalRoot: join(directory, "journal"),
        env: { ALWITH_RUNTIME_ATTENTION: join(directory, "attention") }
      })
  console.log(`runtime: ${runtime?.url ?? "stdio"}`)
  const client = new CodexClient(() => Promise.resolve(port), {
    agentId: "codex",
    launch: { engine: "codex", env: { ...computerRuntimeEnv, INITIAL_AGENT_MODE: "read-only" } }
  })
  let second: CodexClient | undefined
  try {
    await client.connect()
    console.log(`agent: ${client.state.agent?.info.name} ${client.state.agent?.info.version}`)
    if (probe && process.env.ALWITH_LIVE_FOCUS === "automation-local") {
      const id = await client.newSession(directory, { draft: false })
      try {
        const initial = await client.prepareAutomationModel(id, null, true)
        const other = nativeGroupModels(client.session(id).configOptions)?.models.find((entry) => entry.id !== initial && entry.id.startsWith("gpt-"))
        if (!other) throw new Error("Expected a second advertised model")
        for (const [setting, expected] of [[other.id, other.id], [null, initial]] as const) {
          const model = await client.prepareAutomationModel(id, setting, false)
          const marker = `ROUTE_${crypto.randomUUID().slice(0, 8)}`
          const receipt = await client.promptAndWait(id, [{ type: "text", text: `Reply with exactly ${marker} and nothing else.` }], {}, model)
          const result = completedRun(client.session(id), receipt)
          if (result.status !== "success" || result.summary.trim() !== marker) throw new Error(`Unexpected scheduled result: ${JSON.stringify(result)}`)
          probe.assertModel(marker, expected)
        }
        const marker = `ROUTE_${crypto.randomUUID().slice(0, 8)}`
        probe.fail(marker, "model_not_found", "The 'deepseek-flash' model is not supported when using Codex with a ChatGPT account.")
        const receipt = await client.promptAndWait(id, [{ type: "text", text: `Reply with exactly ${marker} and nothing else.` }], {}, initial)
        const failed = completedRun(client.session(id), receipt)
        if (failed.status !== "failed" || failed.failureKind !== "model" || failed.summary) throw new Error(`Model refusal reached reporting: ${JSON.stringify(failed)}`)
        console.log("scheduled monitor: refused model classified as a local failure, no report body")
      } finally {
        await client.delete(id)
      }
      return
    }
    if (probe && process.env.ALWITH_LIVE_FOCUS === "compact-local") {
      const id = await client.newSession(directory)
      try {
        async function turn(marker: string): Promise<void> {
          const receipt = await client.prompt(id, [{ type: "text", text: `Reply with exactly ${marker} and nothing else.` }])
          await until(() => Object.hasOwn(client.session(id).turnEndedAt, receipt) && assistantText(client.session(id)).includes(marker), 30_000, marker)
        }
        await turn("ROUTE_abc123")
        setActivePreview({ root: directory, path: join(directory, "README.md"), title: "README.md" })
        const compact = await client.prompt(id, [{ type: "text", text: "/compact" }])
        await until(() => {
          const session = client.session(id)
          if (session.error) throw new Error(JSON.stringify(session.error))
          return Object.hasOwn(session.turnEndedAt, compact) && session.items.some((item) => item.kind === "compaction" && item.status === "completed")
        }, 30_000, "completed compaction event")
        await turn("ROUTE_def456")
        console.log("context: compact completed with a preview open and the same thread answered again")
      } finally {
        setActivePreview(null)
        await client.delete(id)
      }
      return
    }
    if (process.env.ALWITH_LIVE_FOCUS === "models" || probe) {
      await verifyModelSwitch(client, directory, port, probe)
      return
    }

    const draft = await client.prepareDraft("main", directory)
    if (!client.session(draft).configOptions.some((option) => option.category === "model"))
      throw new Error("Precreated draft has no model selector")
    if (!client.session(draft).commands.some((command) => command.name === "status"))
      throw new Error("Precreated draft has no status command")
    if ((await client.listProjectSessions(directory)).filter((sessionRow) => sessionRow.sessionId === draft).length !== 1)
      throw new Error("Precreated draft must appear exactly once in its project")
    await client.discardDraft("main")
    if (client.state.sessions[draft]) throw new Error("Discarded draft is still attached")
    if ((await client.listProjectSessions(directory)).some((sessionRow) => sessionRow.sessionId === draft))
      throw new Error("Discarded draft is still in the project index")
    console.log("draft: real model options before sending; empty session cleaned up")

    const [a, b] = await Promise.all([client.prepareDraft("main", directory), client.prepareDraft("chat", directory)])
    const fast = client.session(a).configOptions.find((option) => option.configId === "fast-mode")
    if (!fast || !isBooleanOption(fast)) throw new Error("Native model did not expose fast mode")
    if (fast.currentValue) throw new Error("New native session enabled fast mode by default")
    await client.setConfig(a, "fast-mode", true)
    const enabledFast = client.session(a).configOptions.find((option) => option.configId === "fast-mode")
    if (!enabledFast || !isBooleanOption(enabledFast) || !enabledFast.currentValue)
      throw new Error("Fast mode did not become enabled")
    await Promise.all([
      client.prompt(a, [
        {
          type: "text",
          text: "Reply with exactly the word ALPHA and nothing else."
        }
      ]),
      client.prompt(b, [
        {
          type: "text",
          text: "Reply with exactly the word BRAVO and nothing else."
        }
      ])
    ])
    if (client.state.draftSessions[a] || client.state.draftSessions[b])
      throw new Error("Accepted prompts did not materialize the drafts")
    await client.discardDraft("main")
    if (!client.state.sessions[a]) throw new Error("Discard removed a submitted conversation")
    await until(
      () => client.session(a).state === "idle" && client.session(b).state === "idle",
      120_000,
      "both turns to finish"
    )
    const replyA = assistantText(client.session(a))
    const replyB = assistantText(client.session(b))
    console.log(`A: ${replyA.trim()}`)
    console.log(`B: ${replyB.trim()}`)
    if (!replyA.includes("ALPHA") || replyA.includes("BRAVO"))
      throw new Error("Session A did not receive its own reply")
    if (!replyB.includes("BRAVO") || replyB.includes("ALPHA"))
      throw new Error("Session B did not receive its own reply")

    // A second client on the same Runtime attaches to the running agent instead of restarting it,
    // and replays the initialize response without a second handshake.
    second = new CodexClient(() => Promise.resolve(port), { agentId: "codex", launch: { engine: "codex" } })
    client.disconnect()
    await until(() => client.state.connection === "disconnected", 10_000, "disconnect")
    await second.connect()
    if (second.state.agent?.info.name !== "@nyssance/codex-acp-v2") throw new Error("initialize state was not replayed")
    const replies = new Map([
      [a, replyA],
      [b, replyB]
    ])
    await verifyHistory(second, directory, replies)
    console.log("attach: replay matches live transcripts")

    second.disconnect()
    await port.stop("codex")
    // The raw stop command acknowledges the request; registry removal confirms actual exit.
    await until(async () => !(await port.agents()).some((agent) => agent.agentId === "codex"), 10_000, "agent exit")
    second = new CodexClient(() => Promise.resolve(port), {
      agentId: "codex",
      launch: { engine: "codex", env: { ...computerRuntimeEnv, INITIAL_AGENT_MODE: "read-only" } }
    })
    await second.connect()
    await verifyHistory(second, directory, replies)
    const restoredFast = second.session(a).configOptions.find((option) => option.configId === "fast-mode")
    if (!restoredFast || !isBooleanOption(restoredFast))
      throw new Error("Resumed native model did not expose fast mode")
    await second.setConfig(a, "fast-mode", true)
    await second.setConfig(a, "fast-mode", false)
    const disabledFast = second.session(a).configOptions.find((option) => option.configId === "fast-mode")
    if (!disabledFast || !isBooleanOption(disabledFast) || disabledFast.currentValue)
      throw new Error("Fast mode did not become disabled")
    console.log("fresh agent: native history matches live transcripts; fast mode remains available and can be disabled")
    const boundary = second.session(a).items.find((item) => item.kind === "assistant" && !isNotice(item))
    const turnId = codexTurnId(boundary?._meta)
    if (turnId === null) throw new Error("Restored answer is missing its Codex turn id")
    const originalTime = codexTurnStartedAt(boundary?._meta)
    if (originalTime === null) throw new Error("Restored answer is missing its original turn time")
    await second.prompt(a, [{ type: "text", text: "Reply with exactly AFTER_FORK_BOUNDARY" }])
    await until(
      () => second!.session(a).state === "idle" && assistantText(second!.session(a)).includes("AFTER_FORK_BOUNDARY"),
      120_000,
      "later source turn"
    )
    const sourceTitle = `Fork title ${crypto.randomUUID()}`
    await second.renameSession(a, sourceTitle)
    const forked = await second.fork(a, directory, turnId)
    try {
      if (!second.session(forked).commands.some((command) => command.name === "status"))
        throw new Error("Forked session has no status command")
      await until(
        () =>
          second!.session(forked).items.some((item) => item.kind === "user") &&
          assistantText(second!.session(forked)).trim() === replyA.trim(),
        10_000,
        "fork history updates"
      )
      const forkSession = second.session(forked)
      if (forkSession.title !== `${sourceTitle} (2)` || second.session(a).title !== sourceTitle)
        throw new Error("Fork did not persist a distinct inherited title")
      if (second.state.forkOrigins[forked]?.boundaryTurnId !== turnId)
        throw new Error("Fork did not identify the inherited turn boundary")
      if (
        forkSession.items.some(
          (item) => codexTurnId(item._meta) === turnId && codexTurnStartedAt(item._meta) !== originalTime
        )
      )
        throw new Error("Fork changed the original turn time")
      if (
        forkSession.items.filter((item) => item.kind === "user").length !== 1 ||
        assistantText(forkSession).trim() !== replyA.trim()
      )
        throw new Error("Fork did not stop at the selected answer")
      const branches = await second.listProjectSessions(directory)
      if (![a, forked].every((id) => branches.some((sessionRow) => sessionRow.sessionId === id)))
        throw new Error("Native branch index is missing the source or fork")
      if (branches.find((sessionRow) => sessionRow.sessionId === forked)?.forkedFromId !== a)
        throw new Error("Fork lineage does not point to the source")
      await second.close(forked)
      // A fork must survive a full agent restart before the user sends anything in it.
      second.disconnect()
      await port.stop("codex")
      await until(
        async () => !(await port.agents()).some((agent) => agent.agentId === "codex"),
        10_000,
        "new fork agent exit"
      )
      second = new CodexClient(() => Promise.resolve(port), {
        agentId: "codex",
        launch: { engine: "codex", env: { ...computerRuntimeEnv, INITIAL_AGENT_MODE: "read-only" } }
      })
      await second.connect()
      const immediatelySaved = await second.readSessionSummary(forked)
      if (immediatelySaved?.title !== `${sourceTitle} (2)`)
        throw new Error("Fork or title was not saved before the first child prompt")
      await second.open(forked, directory)
      await until(() => assistantText(second!.session(forked)).trim().length > 0, 10_000, "reopened fork updates")
      if (assistantText(second.session(forked)).trim() !== replyA.trim())
        throw new Error("Fork history changed after reopening")
      await second.prompt(forked, [{ type: "text", text: "Reply with exactly FORK_CONTINUED" }])
      await until(
        () =>
          second!.session(forked).state === "idle" && assistantText(second!.session(forked)).includes("FORK_CONTINUED"),
        120_000,
        "fork continuation"
      )
      await second.open(a, directory)
      if (assistantText(second.session(a)).includes("FORK_CONTINUED"))
        throw new Error("Fork response leaked into the source")
      await second.close(forked)
      second.disconnect()
      await port.stop("codex")
      await until(
        async () => !(await port.agents()).some((agent) => agent.agentId === "codex"),
        10_000,
        "fork agent exit"
      )
      second = new CodexClient(() => Promise.resolve(port), {
        agentId: "codex",
        launch: { engine: "codex", env: { ...computerRuntimeEnv, INITIAL_AGENT_MODE: "read-only" } }
      })
      await second.connect()
      if (!(await second.listProjectSessions(directory)).some((sessionRow) => sessionRow.sessionId === forked))
        throw new Error("Continued fork is missing from the persisted native list")
      await second.open(forked, directory)
      await until(
        () => assistantText(second!.session(forked)).includes("FORK_CONTINUED"),
        10_000,
        "persisted fork updates"
      )
      if (!assistantText(second.session(forked)).includes("FORK_CONTINUED"))
        throw new Error("Fork continuation was not persisted across agent restart")
      if (
        second.state.forkOrigins[forked]?.boundaryTurnId !== turnId ||
        second.session(forked).title !== `${sourceTitle} (2)`
      )
        throw new Error("Fork origin or title changed after continuation and restart")
      if (
        second
          .session(forked)
          .items.some((item) => codexTurnId(item._meta) === turnId && codexTurnStartedAt(item._meta) !== originalTime)
      )
        throw new Error("Fork history time changed after restart")
      console.log(
        "fork: immediate persistence, counted title, inherited boundary, isolated continuation and restart verified"
      )
    } finally {
      await second.delete(forked)
    }
    if (process.env.ALWITH_LIVE_FOCUS === "fork") return
    const events = await port.sessionEvents(a)
    if (events.length === 0) throw new Error("the Runtime journal has no frames for session A")
    console.log(`journal: ${events.length} frames for A, last sequence ${events.at(-1)!.sequence}`)
    const states = await port.runStates()
    console.log(`run states: ${states.map((state) => `${state.sessionId.slice(0, 8)}=${state.state}`).join(", ")}`)
    // Session close must retire only its Runtime record, including when the session is idle.
    // Unsent native drafts have no persisted rollout to reopen; use materialized conversations.
    const closeTarget = a
    const survivor = b
    await second.open(closeTarget, directory)
    await second.open(survivor, directory)
    const retainedText = assistantText(second.session(closeTarget))
    await second.stopSession(closeTarget)
    if (second.session(closeTarget).attached || assistantText(second.session(closeTarget)) !== retainedText)
      throw new Error("Stopping a session did not retain its detached transcript")
    await until(
      async () => !(await port.runStates()).some((state) => state.sessionId === closeTarget),
      10_000,
      "idle session removal"
    )
    if (!(await port.runStates()).some((state) => state.sessionId === survivor))
      throw new Error("Closing one session removed its sibling")
    await second.open(closeTarget, directory)
    await Promise.all([
      second.prompt(closeTarget, [{ type: "text", text: "Count from 1 to 1000, one number per line." }]),
      second.prompt(survivor, [{ type: "text", text: "Reply with exactly CLOSE_SURVIVOR." }])
    ])
    await second.stopSession(closeTarget)
    await until(
      async () => !(await port.runStates()).some((state) => state.sessionId === closeTarget),
      10_000,
      "running session removal"
    )
    await until(
      () =>
        second!.session(survivor).state === "idle" &&
        assistantText(second!.session(survivor)).includes("CLOSE_SURVIVOR"),
      120_000,
      "sibling completion after close"
    )
    if (!(await port.agents()).some((agent) => agent.agentId === "codex"))
      throw new Error("Session close killed the shared agent")
    await second.open(closeTarget, directory)
    if (!second.session(closeTarget).attached) throw new Error("Closed session could not reopen")
    await second.close(closeTarget)
    await second.close(survivor)
    console.log("close: idle and running sessions retire independently; sibling completes and closed history reopens")
    if (process.env.ALWITH_LIVE_FOCUS === "lifecycle") return
    await verifyUserInput(second, directory)
    await verifyAsyncUserInput(second, directory)
  } finally {
    client.disconnect()
    second?.disconnect()
    const exited =
      port instanceof ProcessRuntimeClient
        ? new Promise<void>((resolve) => port.onProcessExit(() => resolve()))
        : runtime
          ? new Promise<void>((resolve) => runtime.process.once("exit", () => resolve()))
          : Promise.resolve()
    port.close()
    runtime?.stop()
    await exited
    if (probe) await rm(directory, { recursive: true, force: true })
  }
}

async function verifyUserInput(client: CodexClient, directory: string): Promise<void> {
  const id = await client.newSession(directory)
  try {
    await client.setConfig(id, "collaboration_mode", "default")
    await client.prompt(id, [
      {
        type: "text",
        text: 'UI integration test: use the request_user_input tool now, in Default mode. Ask exactly one question with id "choice", header "Scope", question "Which implementation should be used?", and two options labelled "Alpha" and "Beta" with short descriptions. Do not write the question as a prose message. Wait for my answer, then reply with exactly CHOICE_BETA if I chose Beta. Do not use other tools or change files.'
      }
    ])
    await until(
      () => client.state.actions.some((action) => action.sessionId === id),
      120_000,
      "Default-mode structured question"
    )
    const action = client.state.actions.find((action) => action.sessionId === id)
    if (action?.kind !== "elicitation" || !isFormElicitation(action.params))
      throw new Error(`Expected a structured question in Default mode, received: ${assistantText(client.session(id))}`)
    const choice = action.params.requestedSchema.properties?.choice
    if (!choice || !isStringProperty(choice) || !choice.oneOf?.some((option) => option.const === "Beta"))
      throw new Error("The structured question is missing its selectable Beta answer")
    // Default-mode questions may be non-blocking; the pending request owns the form,
    // independently of whether Runtime keeps the turn running while awaiting input.
    client.respond(action.id, { action: "accept", content: { choice: "Beta" } })
    await until(
      () => client.session(id).state === "idle" && assistantText(client.session(id)).includes("CHOICE_BETA"),
      120_000,
      "structured answer completion"
    )
    console.log("question: Default mode emits an ACP form and receives the selected answer")
  } finally {
    await client.delete(id)
  }
}

async function verifyAsyncUserInput(client: CodexClient, directory: string): Promise<void> {
  const id = await client.newSession(directory)
  try {
    await client.prompt(id, [
      {
        type: "text",
        text: 'UI integration test: call request_user_input_async now with one question titled "Which async implementation?" and options ["Alpha", "Beta"]. Do not ask in prose and do not use request_user_input. After asking, run the read-only shell command sleep 10 to leave time for the answer. Continue the same turn; when the asynchronous answer is Beta, reply with exactly ASYNC_BETA. Do not modify files.'
      }
    ])
    await until(
      () => client.session(id).items.some((item) => item.kind === "assistant" && asyncQuestions(item._meta).length > 0),
      120_000,
      "asynchronous question metadata"
    )
    const item = client
      .session(id)
      .items.find((entry) => entry.kind === "assistant" && asyncQuestions(entry._meta).length > 0)
    if (!item) throw new Error("Missing asynchronous question")
    if (item.replayed || codexTurnId(item._meta) === null)
      throw new Error("Live asynchronous question is missing its active turn identity")
    const question = asyncQuestions(item._meta)[0]
    if (client.session(id).state === "idle" || client.state.actions.some((action) => action.sessionId === id))
      throw new Error("Asynchronous question blocked or ended the turn")
    const reply = { questionItemId: asyncQuestionId(item.id, 0), question: question.title, answer: "Beta" }
    await client.prompt(id, [
      { type: "text", text: questionReplyEnvelope(reply), _meta: { codex: { questionReply: reply } } }
    ])
    await until(
      () => client.session(id).state === "idle" && assistantText(client.session(id)).includes("ASYNC_BETA"),
      120_000,
      "asynchronous answer completion"
    )
    await client.close(id)
    await client.open(id, directory)
    await until(
      () =>
        client.session(id).items.some((entry) => entry.kind === "assistant" && asyncQuestions(entry._meta).length > 0),
      10_000,
      "asynchronous question replay"
    )
    await until(
      () =>
        client
          .session(id)
          .items.some(
            (entry) =>
              entry.kind === "user" &&
              [
                ...questionReplies(entry._meta),
                ...entry.content.filter(isText).flatMap((block) => questionReplies(block._meta))
              ].some((answer) => answer.questionItemId === reply.questionItemId && answer.answer === "Beta")
          ),
      10_000,
      "asynchronous answer replay"
    )
    if (client.state.actions.some((action) => action.sessionId === id))
      throw new Error("History replay reopened a question")
    console.log("async question: non-blocking metadata, correlated steering answer and history replay")
  } finally {
    await client.delete(id)
  }
}

const probe = ["models-local", "compact-local", "automation-local"].includes(process.env.ALWITH_LIVE_FOCUS ?? "") ? startModelProbe() : undefined
try {
  for (const transport of ["stdio", "ws"] as const) await check(transport, probe)
} finally {
  await probe?.close()
}
