// Tells the user, once, that a turn has been retrying silently for a while — and lets them jump to
// the conversation that owns it.
//
// The bridge only knows the model, never the session. It emits `model:retrying` a single time per
// request, the first time that request's silent retries cross the threshold (see `RETRY_ALERT_AFTER`
// in `bridge.rs`). That is deliberate: a dead upstream with the retry switch on would otherwise
// raise a toast every few seconds for the rest of the retry window. So this module's job is small —
// one notice per request, with a button to open the matching session.
//
// "Multiple alerts at once, shown in order" is a queue, not Sonner's default stack. Sonner would
// paint every pending toast simultaneously; the user asked for them one after another, so we hold
// one at a time and only release the next when the current is dismissed (by timeout or by click).

import type { Session } from "@alwith/api"
import { listen } from "@tauri-apps/api/event"
import { info } from "@tauri-apps/plugin-log"
import { toast } from "sonner"

import { selectedModelId } from "@/agent/native-models"
import { client } from "@/lib/client"
import i18n from "@/lib/i18n"

import { label, matchesReportedModel, runningSession } from "./model-overload-alert"
import { jumpToSession, summaryOf } from "./session-jump"

type RetryingEvent = {
  model: string
  retries: number
  requestId?: string
}

type PendingAlert = {
  model: string
  retries: number
  requestId?: string
  at: number
  /** Resolved at event time; `null` only when no running session matches the model at all. */
  session: Session | null
}

const queue: PendingAlert[] = []
let showing = false
// One notice per upstream request. The bridge already emits once per request, but a reconnect or a
// second window could re-deliver the same `requestId`; dedupe so the user is not nagged twice.
const seen = new Set<string>()

/**
 * The strict resolver can return `null` when more than one running session shares the model — it
 * refuses to blame the wrong conversation. For a jump button that is too strict: a stuck turn is
 * real, so fall back to the most recently updated matching session rather than offering no jump.
 */
function bestEffortSession(model: string): Session | null {
  const strict = runningSession(model)
  if (strict !== null) return strict
  let best: Session | null = null
  for (const session of Object.values(client.state.sessions)) {
    if (session === undefined) continue
    const active =
      session.state === "running" ||
      session.state === "requires_action" ||
      client.state.runStates[session.id]?.state === "running"
    if (!active || !matchesReportedModel(selectedModelId(session.configOptions), model)) continue
    if (best === null || (session.updatedAt ?? "") > (best.updatedAt ?? "")) best = session
  }
  return best
}

function enqueue(alert: PendingAlert): void {
  const key = alert.requestId && alert.requestId !== "" ? alert.requestId : `${alert.model}:${alert.at}`
  if (seen.has(key)) return
  seen.add(key)
  queue.push(alert)
  queue.sort((a, b) => a.at - b.at)
  pump()
}

function pump(): void {
  if (showing || queue.length === 0) return
  showing = true
  const alert = queue.shift()
  if (alert === undefined) {
    showing = false
    return
  }
  showToast(alert)
}

function showToast(alert: PendingAlert): void {
  const modelName = alert.session ? label(alert.session, alert.model) : alert.model
  const title = i18n.t("chat.retryAlertTitle", { model: modelName, count: alert.retries })
  const description = i18n.t("chat.retryAlertDescription")
  const jumpLabel = i18n.t("chat.retryAlertJump")
  const id = toast(title, {
    description,
    duration: 9_000,
    // One button, one job: open the conversation that owns this turn. After jumping, close this
    // toast so the next queued alert can take its place instead of piling up.
    action:
      alert.session === null
        ? undefined
        : {
            label: jumpLabel,
            onClick: () => {
              jumpToSession(summaryOf(alert.session as Session))
              toast.dismiss(id)
            }
          },
    // Sonner calls this on both manual and timeout dismissal. Releasing `showing` here — and only
    // here — is what turns the stack into a queue: the next alert waits for this one to leave.
    onDismiss: () => {
      showing = false
      pump()
    }
  })
  void info(`[retry-alert] toast model=${alert.model} retries=${alert.retries} session=${alert.session?.id ?? "none"}`)
}

/** Subscribe once at startup. Returns the unsubscribe handle. */
export async function startModelRetryingAlerts(): Promise<() => void> {
  return listen<RetryingEvent>("model:retrying", (event) => {
    const { model, retries, requestId } = event.payload
    if (typeof model !== "string" || model === "") return
    if (typeof retries !== "number" || retries <= 0) return
    // The strict resolver only uses freshness when it identifies one exact running session.
    // bestEffortSession is too permissive here: with two chats on the same model it can pick a
    // healthy sibling that is streaming and suppress a real retry alert from the stalled chat.
    const strict = runningSession(model)
    const now = Date.now()
    if (strict !== null && strict.clock > 0 && strict.clock <= now && now - strict.clock < 5_000) return
    const session = strict ?? bestEffortSession(model)
    enqueue({
      model,
      retries,
      requestId: typeof requestId === "string" ? requestId : undefined,
      at: now,
      session
    })
  })
}
