import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type AntigravityUsage, parseAntigravityUsage } from "../../src/features/antigravity/usage"

type UsageTransport = {
  open: (directory: string, signal: AbortSignal) => Promise<{ sessionId: string; tier?: unknown }>
  prompt: (sessionId: string, prompt: "/usage", signal: AbortSignal) => Promise<{ stopReason: string }>
  close: (sessionId: string) => void
}

type UsageSession = { sessionId: string; tier?: unknown; supported: boolean; dispose: () => Promise<void> }

export class AntigravityUsageReader {
  private session: UsageSession | null = null
  private announcements: Map<string, boolean> | null = null
  private onCommands: ((sessionId: string, supported: boolean) => void) | null = null
  private output: { sessionId: string; text: string } | null = null

  commands(sessionId: string, supported: boolean): void {
    this.announcements?.set(sessionId, supported)
    this.onCommands?.(sessionId, supported)
  }

  text(sessionId: string, chunk: string): void {
    if (this.output?.sessionId === sessionId && this.output.text.length < 32_768) {
      this.output.text += chunk.slice(0, 32_768 - this.output.text.length)
    }
  }

  async clear(): Promise<void> {
    const session = this.session
    this.session = null
    await session?.dispose()
  }

  async read(transport: UsageTransport, signal: AbortSignal): Promise<{ tier?: unknown; usage: AntigravityUsage }> {
    try {
      const session = (this.session ??= await this.open(transport, signal))
      if (!session.supported) return { tier: session.tier, usage: { status: "unavailable" } }
      const output = { sessionId: session.sessionId, text: "" }
      this.output = output
      const result = await transport.prompt(session.sessionId, "/usage", signal)
      signal.throwIfAborted()
      return {
        tier: session.tier,
        usage: result.stopReason === "end_turn" ? parseAntigravityUsage(output.text) : { status: "error" }
      }
    } catch (error) {
      await this.clear()
      throw error
    } finally {
      this.output = null
    }
  }

  private async open(transport: UsageTransport, signal: AbortSignal): Promise<UsageSession> {
    const directory = await mkdtemp(join(tmpdir(), "alwith-antigravity-usage-"))
    const announcements = new Map<string, boolean>()
    this.announcements = announcements
    let opened: Awaited<ReturnType<UsageTransport["open"]>> | undefined
    const dispose = async (): Promise<void> => {
      if (opened !== undefined) transport.close(opened.sessionId)
      await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
    try {
      opened = await transport.open(directory, signal)
      signal.throwIfAborted()
      const supported = announcements.get(opened.sessionId) ?? (await this.waitForCommands(opened.sessionId, signal))
      return { ...opened, supported, dispose }
    } catch (error) {
      await dispose()
      throw error
    } finally {
      this.announcements = null
    }
  }

  private async waitForCommands(sessionId: string, signal: AbortSignal): Promise<boolean> {
    const { promise, resolve, reject } = Promise.withResolvers<boolean>()
    const timer = setTimeout(() => reject(new Error("Antigravity did not publish session commands")), 2_000)
    const abort = () => reject(signal.reason)
    this.onCommands = (id, supported) => {
      if (id === sessionId) resolve(supported)
    }
    signal.addEventListener("abort", abort, { once: true })
    try {
      signal.throwIfAborted()
      return await promise
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      this.onCommands = null
    }
  }
}
