// What the bridge can prove about a turn that is producing nothing, and nothing else.
//
// `overloaded` — the backend said it is at capacity and asked us to wait (with a `retry-after`).
// `no_ack`    — the request was accepted by the transport and then not one byte came back for
//               two minutes. Both are upstream facts, which is why only these two may be reported
//               as a stall. A turn that is running a local tool has **no request in flight**, so
//               the bridge stays silent and the UI must not claim anything either.
//
// This module only holds the notice. It deliberately has no action: switching models lives in the
// composer's model picker, one entrance with one meaning. An earlier version offered a one-click
// "stop this turn and change the default model" from the status row, which cancelled work in flight
// and rewrote a setting from a progress bar.

import type { Session } from "@alwith/api"
import { listen } from "@tauri-apps/api/event"
import { info } from "@tauri-apps/plugin-log"

import { selectedModelId } from "@/agent/native-models"
import { client } from "@/lib/client"
import { activeTool } from "./turn-activity"
import { overloadRetryCount } from "@/lib/overload-retry-settings"

type StallReason = "overloaded" | "no_ack"
type StallEvent = { model: string; reason?: StallReason; retryAfter: number | null }
type Choice = { value: string; name: string }

export type OverloadNotice = {
  sessionId: string
  model: string
  modelName: string
  minutes: number | null
  /** Raw `retry-after` in seconds, so the row can count down instead of rounding to minutes. */
  retryAfter: number | null
  /** `overloaded` when the backend said so, `no_ack` when it never answered at all. */
  reason: StallReason
  at: number
}

const lastShown = new Map<string, number>()
const overloadAttempts = new Map<string, number>()
const listeners = new Set<() => void>()
let notice: OverloadNotice | null = null

/** The banner right above the composer subscribes here; no global toast is involved. */
export function subscribeOverload(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function overloadNotice(): OverloadNotice | null {
  return notice
}

export function dismissOverload(sessionId?: string): void {
  if (notice === null || (sessionId !== undefined && notice.sessionId !== sessionId)) return
  notice = null
  for (const listener of listeners) listener()
}

function emit(): void {
  for (const listener of listeners) listener()
}

/** Model selectors nest gateway choices one level deep, so flatten both shapes. */
function choices(session: Session): Choice[] {
  const option = session.configOptions.find((entry) => entry.category === "model" && entry.type === "select")
  if (option === undefined || option.type !== "select") return []
  const rows: unknown[] = Array.isArray(option.options) ? option.options : []
  const result: Choice[] = []
  for (const row of rows) {
    const nested = (row as { options?: unknown }).options
    for (const entry of Array.isArray(nested) ? nested : [row]) {
      const choice = entry as { value?: unknown; name?: unknown }
      if (typeof choice.value === "string" && choice.value !== "") {
        result.push({ value: choice.value, name: typeof choice.name === "string" ? choice.name : choice.value })
      }
    }
  }
  return result
}

function label(session: Session, value: string): string {
  return choices(session).find((choice) => choice.value === value)?.name ?? value
}

function turnKey(session: Session, model: string): string | null {
  const user = [...session.items].reverse().find((item) => item.kind === "user")
  return user === undefined ? null : `${session.id}:${model}:${user.id}`
}

/** A turn executing a local tool has no upstream request open, so it cannot be stalling upstream. */
function isRunningLocally(session: Session): boolean {
  return activeTool(session) !== null
}

/**
 * The bridge names a gateway model `deepseek/deepseek-flash`; the session config names the same
 * model `gateway:deepseek:deepseek-flash`. Both shapes must resolve to one turn, or a real stall is
 * dropped while a notice raised for another conversation keeps being shown.
 */
export function matchesReportedModel(selected: string | null, reported: string): boolean {
  if (selected === null) return false
  if (selected === reported) return true
  if (!selected.startsWith("gateway:")) return false
  const rest = selected.slice("gateway:".length)
  const separator = rest.indexOf(":")
  if (separator < 0) return false
  try {
    return `${decodeURIComponent(rest.slice(0, separator))}/${decodeURIComponent(rest.slice(separator + 1))}` === reported
  } catch {
    return false
  }
}

function runningSession(model: string): Session | null {
  // Object.values order is not a contract. Two chats can run the same model, and "the first one"
  // used to put the notice on an idle-by-observation window while the real turn sat elsewhere.
  // The most recently updated matching session is the best available evidence.
  let best: Session | null = null
  for (const session of Object.values(client.state.sessions)) {
    if (session === undefined) continue
    const active =
      session.state === "running" ||
      session.state === "requires_action" ||
      client.state.runStates[session.id]?.state === "running"
    if (!active || !matchesReportedModel(selectedModelId(session.configOptions), model)) continue
    if (best === null || session.clock > best.clock) best = session
  }
  return best
}

/** Subscribe once at startup. Returns the unsubscribe handle. */
export async function startModelOverloadAlerts(): Promise<() => void> {
  return listen<StallEvent>("model:stalled", (event) => {
    const { model, retryAfter } = event.payload
    // An unknown or missing reason is not evidence of an overload. Defaulting every unexpected
    // payload to `overloaded` used to turn a malformed event into 「当前模型已满负荷」.
    const reason = event.payload.reason
    if (reason !== "overloaded" && reason !== "no_ack") return
    if (typeof model !== "string" || model === "") return
    // A `retry-after` of a few seconds is the engine's own retry loop doing its job: the turn keeps
    // streaming, so a "model is at capacity" row would contradict the transcript right above it.
    // Only a wait the reader would actually feel deserves a notice.
    if (reason === "overloaded" && typeof retryAfter === "number" && retryAfter < 30) return
    // Resolve the session *before* throttling. The engine retries the same turn several times and
    // one notice per minute is plenty — but that budget belongs to one conversation, not to the
    // model name: two chats on the same model are separate turns, and a global per-model stamp
    // silently swallowed the second chat's real stall.
    const session = runningSession(model)
    if (session === null) return
    const now = Date.now()
    const shownKey = turnKey(session, model)
    if (shownKey === null) return
    // Count only overload retries: the configured budget means "stay silent for N automatic
    // retries". The (N+1)th stall is the first one the reader is told about. A `no_ack` event is
    // not a retry and must be reported immediately.
    if (reason === "overloaded") {
      const attempt = (overloadAttempts.get(shownKey) ?? 0) + 1
      overloadAttempts.set(shownKey, attempt)
      if (attempt <= overloadRetryCount()) {
        void info(`[stall] automatic retry session=${session.id} model=${model} attempt=${attempt}`)
        return
      }
    }
    if (now - (lastShown.get(shownKey) ?? 0) < 60_000) return
    // Tokens are still being billed and the store is still applying updates: output is flowing, so
    // this turn is not stalled. A retry notice from an earlier request must not stick to it — that
    // is what made every later turn open with the same "at capacity" line.
    if (session.clock > 0 && now - session.clock < 5_000) return
    // The bridge only sends `no_ack` while a request is open upstream. If the turn has since moved
    // on to a local tool, that request is gone and the turn is not stalled — drop the notice.
    if (reason === "no_ack" && isRunningLocally(session)) return
    lastShown.set(shownKey, now)
    const minutes = typeof retryAfter === "number" && retryAfter > 0 ? Math.max(1, Math.round(retryAfter / 60)) : null
    notice = {
      sessionId: session.id,
      model,
      modelName: label(session, model),
      minutes,
      retryAfter: typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : null,
      reason,
      at: now
    }
    emit()
    void info(`[stall] notice session=${session.id} model=${model} reason=${reason} retryAfter=${String(retryAfter)}`)
  })
}
