import type { Session } from "@alwith/api"
import { listen } from "@tauri-apps/api/event"

import { commands } from "@/bindings"

/**
 * Native Agent turns for Gemini sessions.
 *
 * The gateway path (Codex -> /responses -> text) stays untouched for every other model. When the
 * user sends a message on a Gemini session, `sendPrompt` routes it here: we call the official
 * Antigravity ACP binary directly with the session's real project directory, and stream its text,
 * tool and permission events back into the very same chat session.
 *
 * Text and tool items are built by `applyUpdate` — the canonical `@alwith/api` reducer — so tool
 * cards render exactly like Codex tools without modifying the shared message store.
 */

const EVENT = "antigravity:event"

export type AgentPermission = {
  requestId: string
  turnKey: string
  title: string
  kind: string
  options: Array<{ optionId: string; name: string; kind?: string }>
}

type Resolve = (receipt: string) => void
type Reject = (error: Error) => void

type PendingTurn = {
  sessionId: string
  receipt: string
  resolve: Resolve
  reject: Reject
  apply: (session: Session, update: Record<string, unknown>) => Session
  settled: boolean
  /** One messageId per turn keeps streamed text chunks in a single assistant bubble. */
  messageId: string
}

type AgentEvent = {
  type?: string
  turnKey?: string
  requestId?: string
  text?: string
  stopReason?: string
  message?: string
  toolCall?: Record<string, unknown>
  options?: Array<{ optionId: string; name: string; kind?: string }>
}

/** Maps ACP v1 `tool_call` fields onto the ACP v2 `SessionUpdate` shape `applyUpdate` expects. */
export function toolUpdate(update: Record<string, unknown>, status: "in_progress" | "completed") {
  const tool = (update.toolCall ?? {}) as Record<string, unknown>
  // The canonical reducer creates/updates tool items on `tool_call_update`; `tool_call` alone is
  // a no-op for item building. Emit the update form so tool cards actually appear.
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: String(tool.toolCallId ?? tool.id ?? "agent-tool"),
    kind: tool.kind ?? "other",
    title: tool.title ?? "Tool",
    status,
    content: [],
    _meta: null
  }
}

/** Streamed text chunks share one messageId so they render as a single assistant bubble. */
export function textUpdate(text: string, messageId: string) {
  return { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } }
}

class AntigravityAgent {
  private pending = new Map<string, PendingTurn>()
  private applySession: ((sessionId: string, change: (session: Session) => Session) => void) | null = null
  private onPermission: ((permission: AgentPermission) => void) | null = null
  private listening: Promise<() => void> | null = null

  configure(
    applySession: (sessionId: string, change: (session: Session) => Session) => void,
    onPermission: (permission: AgentPermission) => void
  ): void {
    this.applySession = applySession
    this.onPermission = onPermission
    this.listening ??= listen<string>(EVENT, (event) => this.handle(event.payload))
  }

  private handle(payload: string): void {
    let event: AgentEvent
    try {
      event = JSON.parse(payload) as AgentEvent
    } catch {
      return
    }
    if (event.type === "permission_request") {
      if (event.turnKey === undefined || event.requestId === undefined) return
      const tool = event.toolCall ?? {}
      this.onPermission?.({
        requestId: event.requestId,
        turnKey: event.turnKey,
        title: String(tool.title ?? "Tool"),
        kind: String(tool.kind ?? "other"),
        options: Array.isArray(event.options) ? event.options : []
      })
      return
    }
    const key = event.turnKey
    if (key === undefined) return
    const turn = this.pending.get(key)
    if (turn === undefined) return
    const apply = this.applySession
    if (apply !== null) {
      let update: Record<string, unknown> | null = null
      if (event.type === "delta" && typeof event.text === "string") {
        update = textUpdate(event.text, turn.messageId)
      } else if (event.type === "tool_call" || event.type === "tool_call_update") {
        update = toolUpdate(event, event.type === "tool_call" ? "in_progress" : "completed")
      }
      if (update !== null) apply(turn.sessionId, (session) => turn.apply(session, update!))
    }
    if (event.type === "done") this.settle(key, null)
    else if (event.type === "error") this.settle(key, new Error(event.message ?? "Antigravity turn failed"))
  }

  private settle(key: string, error: Error | null): void {
    const turn = this.pending.get(key)
    if (turn === undefined || turn.settled) return
    turn.settled = true
    this.pending.delete(key)
    if (error === null) turn.resolve(turn.receipt)
    else turn.reject(error)
  }

  async run(options: {
    sessionId: string
    turnKey: string
    receipt: string
    cwd: string
    model: string
    effort: string | null
    prompt: Array<{ type: string; [key: string]: unknown }>
    apply: (session: Session, update: Record<string, unknown>) => Session
  }): Promise<string> {
    if (this.listening === null) throw new Error("Antigravity Agent is not configured")
    const turn: PendingTurn = {
      sessionId: options.sessionId,
      receipt: options.receipt,
      resolve: () => {},
      reject: () => {},
      apply: options.apply,
      settled: false,
      messageId: `agent-msg-${options.turnKey}`
    }
    const settled = new Promise<string>((resolve, reject) => {
      turn.resolve = resolve
      turn.reject = reject
    })
    this.pending.set(options.turnKey, turn)
    try {
      await commands.antigravityAgentTurn({
        turnKey: options.turnKey,
        model: options.model,
        effort: options.effort,
        prompt: options.prompt as never,
        cwd: options.cwd,
        sessionKey: options.sessionId
      })
    } catch (error) {
      this.settle(options.turnKey, error instanceof Error ? error : new Error(String(error)))
    }
    return settled
  }

  async answer(requestId: string, optionId: string | null): Promise<void> {
    await commands.antigravityPermissionAnswer({ requestId, optionId })
  }

  async cancel(requestId: string): Promise<void> {
    await commands.antigravityAgentCancel({ requestId })
  }
}

export const antigravityAgent = new AntigravityAgent()
