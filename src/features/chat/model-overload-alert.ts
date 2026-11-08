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

/** A turn executing a local tool has no upstream request open, so it cannot be stalling upstream. */
function isRunningLocally(session: Session): boolean {
  return activeTool(session) !== null
}

function runningSession(model: string): Session | null {
  for (const session of Object.values(client.state.sessions)) {
    if (session === undefined) continue
    const active =
      session.state === "running" ||
      session.state === "requires_action" ||
      client.state.runStates[session.id]?.state === "running"
    if (active && selectedModelId(session.configOptions) === model) return session
  }
  return null
}

/** Subscribe once at startup. Returns the unsubscribe handle. */
export async function startModelOverloadAlerts(): Promise<() => void> {
  return listen<StallEvent>("model:stalled", (event) => {
    const { model, retryAfter } = event.payload
    const reason: StallReason = event.payload.reason === "no_ack" ? "no_ack" : "overloaded"
    if (typeof model !== "string" || model === "") return
    // A `retry-after` of a few seconds is the engine's own retry loop doing its job: the turn keeps
    // streaming, so a "model is at capacity" row would contradict the transcript right above it.
    // Only a wait the reader would actually feel deserves a notice.
    if (reason === "overloaded" && retryAfter !== null && retryAfter < 30) return
    // The engine retries the same turn several times; one notice per minute is plenty.
    const now = Date.now()
    if (now - (lastShown.get(model) ?? 0) < 60_000) return
    const session = runningSession(model)
    if (session === null) return
    // The bridge only sends `no_ack` while a request is open upstream. If the turn has since moved
    // on to a local tool, that request is gone and the turn is not stalled — drop the notice.
    if (reason === "no_ack" && isRunningLocally(session)) return
    lastShown.set(model, now)
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
