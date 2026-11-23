// @ts-nocheck
/**
 * Local bridge between ALWith U⁺ and Google's official Antigravity ACP server.
 *
 * The official binary speaks ACP v1 over stdio. U⁺ speaks a small NDJSON command channel to this
 * process, which keeps the product-side integration independent of the official ACP version. The
 * bridge never reads or writes Google credentials; the official binary owns its own OAuth flow.
 */
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Readable, Writable } from "node:stream"

import * as acp from "@agentclientprotocol/sdk"

const args = process.argv.slice(2)
const argValue = (name: string): string | null => {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? null) : null
}

const binary =
  argValue("--binary") ??
  join(homedir(), "Library/Application Support/ai.alwith.u/antigravity/agy_acp_server.par")

let child: ReturnType<typeof spawn> | null = null
let context: any = null
let active: any = null
let initialized: any = null
let starting: Promise<any> | null = null

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function writeLog(line: string): void {
  process.stderr.write(`[antigravity-bridge] ${line}\n`)
}

async function startAgent(): Promise<any> {
  if (initialized !== null) return initialized
  if (starting !== null) return starting
  starting = (async () => {
    // The official local harness writes beside its process. A GUI app can start the bridge with
    // the bundle (or `/`) as its cwd, which makes session/new fail before the first prompt. Keep
    // the harness in a writable user directory; the project cwd is still sent in session/new.
    child = spawn(binary, [], {
      cwd: process.env.ANTIGRAVITY_WORKDIR ?? homedir(),
      // The official local harness uses a loopback WebSocket for its own tools. macOS system proxy
      // settings make Python's stack try SOCKS even for 127.0.0.1; keep loopback direct while
      // leaving the user's proxy available for Google's HTTPS endpoints.
      env: {
        ...process.env,
        NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(","),
        no_proxy: [process.env.no_proxy, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(",")
      },
      stdio: ["pipe", "pipe", "pipe"]
    })
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim()
      if (text !== "") writeLog(text)
    })
    child.on("exit", (code, signal) => {
      writeLog(`official ACP exited code=${code} signal=${signal}`)
      send({ type: "exit", code, signal })
      child = null
      context = null
      active = null
      initialized = null
      starting = null
    })
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout)
    )
    const connected = new Promise<any>((resolve, reject) => {
      acp
        .client({ name: "alwith-u-antigravity-bridge" })
        .onRequest(acp.methods.client.session.requestPermission, (request: any) => {
          const options = Array.isArray(request.params?.options) ? request.params.options : []
          const option = options.find((entry: any) => entry.kind === "allow_once") ?? options[0]
          return option === undefined
            ? { outcome: { outcome: "cancelled" } }
            : { outcome: { outcome: "selected", optionId: option.optionId } }
        })
        .onRequest(acp.methods.client.fs.readTextFile, () => ({ content: "" }))
        .onRequest(acp.methods.client.fs.writeTextFile, () => ({}))
        .connectWith(stream, async (ctx: any) => {
          context = ctx
          const response = await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
              auth: { terminal: true }
            }
          })
          initialized = response
          resolve(response)
          await new Promise<void>(() => {})
        })
        .catch(reject)
    })
    const response = await connected
    writeLog(`official ACP ready ${response.agentInfo?.name ?? "unknown"} ${response.agentInfo?.version ?? ""}`)
    return response
  })().catch((error) => {
    starting = null
    throw error
  })
  return starting
}

async function prompt(text: string): Promise<void> {
  const session = active
  if (session === null) throw new Error("Gemini session is not ready")
  send({ type: "running" })
  const result = session.prompt(text)
  try {
    for (;;) {
      const message = await session.nextUpdate()
      if (message.kind === "stop") {
        send({ type: "done", response: message.response })
        break
      }
      send({ type: "update", update: message.update })
    }
    await result
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) })
  }
}

async function handle(line: string): Promise<void> {
  const message = JSON.parse(line) as { type?: string; [key: string]: unknown }
  try {
    switch (message.type) {
      case "initialize": {
        const response = await startAgent()
        send({
          type: "ready",
          agentInfo: response.agentInfo ?? null,
          authMethods: response.authMethods ?? []
        })
        return
      }
      case "login": {
        await startAgent()
        const response = await context.request(acp.methods.agent.authenticate, {
          methodId: String(message.methodId ?? "oauth-personal")
        })
        send({ type: "logged_in", tier: response?._meta?.antigravity?.tier ?? null })
        return
      }
      case "session.new": {
        await startAgent()
        const cwd = typeof message.cwd === "string" && message.cwd !== "" ? message.cwd : homedir()
        const session = await context.buildSession(cwd).start()
        active = session
        send({
          type: "session",
          sessionId: session.sessionId,
          configOptions: session.newSessionResponse.configOptions ?? []
        })
        return
      }
      case "prompt":
        await prompt(String(message.text ?? ""))
        return
      case "cancel":
        if (active !== null) await context.notify(acp.methods.agent.session.cancel, { sessionId: active.sessionId })
        return
      case "config": {
        if (active !== null) {
          await context.request(acp.methods.agent.session.setConfigOption, {
            sessionId: active.sessionId,
            configId: String(message.configId ?? ""),
            value: String(message.value ?? "")
          })
          send({ type: "config_applied", configId: message.configId, value: message.value })
        }
        return
      }
      case "logout":
        if (context !== null) await context.request(acp.methods.agent.logout, {})
        active = null
        send({ type: "logged_out" })
        return
      case "shutdown":
        child?.kill()
        process.exit(0)
      default:
        throw new Error(`Unknown bridge command: ${String(message.type)}`)
    }
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) })
  }
}

const lines = createInterface({ input: process.stdin })
let queue = Promise.resolve()
lines.on("line", (line) => {
  if (line.trim() === "") return
  queue = queue.then(() => handle(line)).catch((error) => writeLog(String(error)))
})

process.on("SIGTERM", () => {
  child?.kill()
  process.exit(0)
})

send({ type: "bridge_ready", binary })
