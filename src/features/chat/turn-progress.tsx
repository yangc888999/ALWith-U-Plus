// What the running turn is doing, docked above the composer.
//
// The visible row is deliberately one short line: "<model> <state>···". The state set is
// configurable — connecting / thinking / replying / tool / planning / compacting / waiting for
// confirmation — but every one of them is the same short phrase, never a sentence. Effort, the
// precise step, tool counts and long explanations used to turn an ordinary long reasoning turn
// into something that read like an error. They now live off the row: the precise step and the
// explanation are hover titles, and the clock carries the timing.
//
// One rule holds the whole file together: **this component may only describe what it can see.**
// Silence in the store has several possible causes — the model is thinking, the gateway is queuing,
// a local tool is running, the user has not answered — and the renderer is not in a position to
// tell them apart. Only the bridge sees the upstream, so amber rows and stall wording come from
// its `model:stalled` notice; everything else is a plain timer with one gentle action.
//

import type { Session } from "@alwith/api"
import { AlertTriangleIcon, CircleHelpIcon, Loader2Icon } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { useStore } from "zustand"

import { selectedModelId } from "@/agent/native-models"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { autoNudgeEnabled, subscribeAutoNudge } from "@/lib/auto-nudge"
import { getQueueSendMode, subscribeChatDisplayPreferences } from "@/lib/chat-display-preferences"
import { client } from "@/lib/client"
import { subscribeGroupSpeaker } from "@/lib/group-runtime"
import { displayModelLabel } from "@/lib/providers"
import { orchestrationFor, subscribeOrchestration } from "@/lib/session-orchestration"
import { cn } from "@/lib/utils"

import { dismissOverload, matchesReportedModel, overloadNotice, subscribeOverload } from "./model-overload-alert"
import { nudgeTurn } from "./nudge-turn"
import { activeTool, awaitingUser } from "./turn-activity"

/** Per-session turn clock. `last` only moves when the store reports new work, so it doubles as
 *  the "how long has it been quiet" anchor. */
type Turn = {
  start: number
  last: number
  clock: number
  /** The model this turn is actually running on, captured when it started. A mid-turn switch only
   *  affects the NEXT turn, so reading the live config here would name a model that is not running. */
  model: string | null
  /** The id behind `model`. A stall notice raised for model A must never be drawn on a turn that
   *  is running B — the two used to share one module-level notice and one session id. */
  modelId: string | null
}

const turns = new Map<string, Turn>()
/** Past this much silence the row stops implying progress and states how long the step has run.
 *  Ninety seconds is past the point where a reader starts wondering, and still short enough that a
 *  two-minute reasoning step looks like what it is: one step, not a fault. */
const QUIET_MS = 90_000
/** A notice older than this is stale even if the turn never moved: the engine has moved on. */
const OVERLOAD_TTL_MS = 120_000
/** How long the row may sit with nothing new before an upstream notice is worth showing. */
const NUDGE_MS = 30_000
/** Past this much silence the row states the silence inside its one line — long before the ninety
 *  seconds that make it worth acting on. Stated, not accused: no cause is implied. */
const QUIET_TEXT_MS = 45_000
/** The auto-nudge threshold. Long enough that a reasoning step is not interrupted, short enough that
 *  a genuinely stalled turn does not sit there for the rest of the afternoon. */
const AUTO_NUDGE_MS = 90_000
/** At most two per turn. A third would be a loop, and a turn that ignores two nudges is not helped
 *  by a third — that is when the reader stops it. */
const AUTO_NUDGE_MAX = 2

/** The turn currently in flight, or null when the session is not running. */
function trackTurn(session: Session): Turn | null {
  const running = session.state === "running" || session.state === "requires_action"
  if (!running) {
    turns.delete(session.id)
    return null
  }
  const now = Date.now()
  const previous = turns.get(session.id)
  if (previous === undefined) {
    const lastUser = [...session.items].reverse().find((item) => item.kind === "user")
    // The package's `clock` is an epoch timestamp of the last applied update, so a strip mounted
    // mid-turn starts from the real last activity instead of pretending the turn just began.
    const observed = session.clock > 0 && session.clock <= now ? session.clock : now
    const start =
      lastUser !== undefined && lastUser.at <= now && now - lastUser.at < 6 * 60 * 60_000 ? lastUser.at : observed
    const turn = {
      start,
      last: Math.max(start, observed),
      clock: session.clock,
      model: modelLabel(session),
      modelId: selectedModelId(session.configOptions)
    }
    turns.set(session.id, turn)
    return turn
  }
  // `clock` ticks on every update the package applies to this session, including thought chunks
  // and tool output — the cheapest "the agent is alive" signal available.
  if (previous.clock !== session.clock) {
    previous.clock = session.clock
    previous.last = now
  }
  return previous
}

function modelLabel(session: Session): string | null {
  return labelForModelId(session, selectedModelId(session.configOptions))
}

/** Resolves a model id (the session's selected one, or an orchestration role's) to its display name,
 *  falling back to the raw id when the catalog no longer lists it. */
function labelForModelId(session: Session, id: string | null): string | null {
  if (id === null) return null
  // The thread catalogue was written when the thread was prepared; a rename in 设置 → 大模型 never
  // reaches it. The saved overrides are the source of truth for the name on every surface.
  const renamed = displayModelLabel(id)
  if (renamed !== null) return renamed
  const option = session.configOptions.find((entry) => entry.category === "model" && entry.type === "select")
  if (option === undefined || option.type !== "select") return id
  const choices: unknown[] = Array.isArray(option.options) ? option.options : []
  for (const entry of choices) {
    const nested = (entry as { options?: unknown }).options
    const list = Array.isArray(nested) ? nested : [entry]
    for (const item of list) {
      const choice = item as { value?: unknown; name?: unknown }
      if (choice.value === id && typeof choice.name === "string" && choice.name !== "") return choice.name
    }
  }
  return id
}

function short(text: string, limit = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
}

/** Precise step — kept for the hover title so support can still tell what the agent emitted last. */
type Stage = { key: string; name?: string; count?: number }

function stageOf(session: Session): Stage {
  if (session.state === "requires_action") return { key: "chat.turnProgress.confirm" }
  let index = session.items.length - 1
  while (index >= 0 && session.items[index]?.kind !== "user") index -= 1
  const done = session.items
    .slice(index + 1)
    .filter((item) => item.kind === "tool" && item.status === "completed").length
  const waiting = (): Stage =>
    done === 0 ? { key: "chat.turnProgress.waiting" } : { key: "chat.turnProgress.waitingAfterTools", count: done }
  const last = session.items[session.items.length - 1]
  if (last === undefined || index === session.items.length - 1) return waiting()
  switch (last.kind) {
    case "tool": {
      const running = last.status === "in_progress" || last.status === "pending"
      if (!running) return waiting()
      return { key: "chat.turnProgress.tool", name: short(last.title ?? last.name ?? "") }
    }
    case "assistant":
      return { key: "chat.turnProgress.writing" }
    case "thought":
      return { key: "chat.turnProgress.thinking" }
    case "compaction":
      return { key: "chat.turnProgress.compacting" }
    case "plan":
      return { key: "chat.turnProgress.planning" }
    default:
      return waiting()
  }
}

type ShortState =
  | "stateConnecting"
  | "stateThinking"
  | "stateReplying"
  | "stateTool"
  | "statePlanning"
  | "stateCompacting"
  | "stateConfirm"

/** Every precise step collapses into one short "<model> <state>···" phrase. Nothing is lost — the
 *  tool name, finished-tool count and exact step stay in the hover title — it just never becomes a
 *  sentence on screen. Add an entry here whenever a new step deserves its own wording; the row
 *  always stays one short line. */
const SHORT_STATE: Record<string, ShortState> = {
  "chat.turnProgress.waiting": "stateThinking",
  "chat.turnProgress.waitingAfterTools": "stateThinking",
  "chat.turnProgress.thinking": "stateThinking",
  "chat.turnProgress.writing": "stateReplying",
  "chat.turnProgress.tool": "stateTool",
  "chat.turnProgress.planning": "statePlanning",
  "chat.turnProgress.compacting": "stateCompacting",
  "chat.turnProgress.confirm": "stateConfirm"
}

function stateOf(session: Session, parked: boolean): ShortState {
  // Waiting on the user is not the upstream's fault, however long it takes: never call it a stall.
  if (parked) return "stateConfirm"
  // No wall-clock override. "Quiet for three minutes ⇒ reconnecting" was a guess about the
  // upstream made from a stopwatch, and it fired on every slow reasoning step; when the upstream
  // really is stuck the bridge says so, and that notice owns the wording.
  return SHORT_STATE[stageOf(session).key] ?? "stateReplying"
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function duration(ms: number): { key: string; values: Record<string, number> } {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return { key: "chat.turnProgress.seconds", values: { value: total } }
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (seconds === 0) return { key: "chat.turnProgress.minutes", values: { value: minutes } }
  return { key: "chat.turnProgress.minutesSeconds", values: { minutes, seconds } }
}

/**
 * The automatic nudge: says 「继续」 into a turn that has been silent for ninety seconds.
 *
 * It is the manual button's effect on a timer, and it is deliberately conservative:
 *
 *   * never in queued-send mode (`steering === false`) — the nudge would arrive after the turn
 *     settles and open a *second* turn, which is the opposite of pushing this one along;
 *   * never while a local tool or a compaction pass is running, or while the reader is being asked
 *     something — those are not the model failing to answer;
 *   * never while the bridge is replaying an overload (`blocked`): a nudge cannot reach an upstream
 *     that is already retrying, it would just queue behind it;
 *   * at most twice per turn, ninety seconds apart.
 *
 * The silence it acts on is measured from the later of "the last output this turn produced" and
 * "the moment this row started watching". A strip that mounts on a turn which went quiet two
 * minutes ago therefore waits for its own ninety seconds — otherwise every window reload would fire
 * a nudge for silence nobody was watching, and a reader who refocuses the app would find a stray
 * 「继续」 in their transcript.
 *
 * It renders nothing; the count it reports is what the row prints.
 */
function AutoNudger({
  session,
  turnStart,
  turnLast,
  enabled,
  steering,
  localBusy,
  parked,
  blocked,
  silentSeconds,
  onCountChange
}: {
  session: Session
  /** Stable per turn: identifies which turn the count belongs to. */
  turnStart: number
  turnLast: number
  enabled: boolean
  steering: boolean
  localBusy: boolean
  parked: boolean
  blocked: boolean
  /** Whole seconds of silence. Doubles as the throttle: the effect re-runs once per second, never
   *  several times inside the same one. */
  silentSeconds: number
  onCountChange: (count: number) => void
}): ReactNode {
  const watch = useRef({ start: 0, count: 0, watchedFrom: 0, nudgedAt: 0 })

  useEffect(() => {
    const now = Date.now()
    if (watch.current.start !== turnStart) {
      watch.current = { start: turnStart, count: 0, watchedFrom: now, nudgedAt: 0 }
      onCountChange(0)
    }
    if (!enabled || !steering || localBusy || parked || blocked) return
    if (watch.current.count >= AUTO_NUDGE_MAX) return
    const since = Math.max(turnLast, watch.current.watchedFrom)
    if (now - since < AUTO_NUDGE_MS) return
    // The first nudge does not necessarily move `turn.last` (a refused nudge leaves no item), so the
    // spacing is tracked here as well instead of trusting the silence to reset.
    if (watch.current.nudgedAt !== 0 && now - watch.current.nudgedAt < AUTO_NUDGE_MS) return
    watch.current.count += 1
    watch.current.nudgedAt = now
    onCountChange(watch.current.count)
    void nudgeTurn(session)
  }, [session, turnStart, turnLast, enabled, steering, localBusy, parked, blocked, silentSeconds, onCountChange])

  return null
}

/**
 * The turn sentence scrolls only when it genuinely cannot fit.
 *
 * The row is one line by design; at a narrow composer the vendor + model + state used to be cut
 * mid-word, hiding the part the row exists to explain. A single copy stays still when it fits;
 * when it does not, two copies use the shared marquee keyframes for a seamless loop. Measuring the
 * first copy's natural width (not the animated track) means resizing back to a wide window stops
 * the motion instead of leaving a permanently looping row.
 */
function StateMarquee({ text }: { text: string }): ReactNode {
  const box = useRef<HTMLSpanElement>(null)
  const copy = useRef<HTMLSpanElement>(null)
  const [looping, setLooping] = useState(false)

  useEffect(() => {
    const host = box.current
    const first = copy.current
    if (host === null || first === null) return
    const check = (): void => setLooping(first.offsetWidth > host.clientWidth + 2)
    check()
    if (typeof ResizeObserver !== "function") return
    const observer = new ResizeObserver(check)
    observer.observe(host)
    return () => observer.disconnect()
  }, [text])

  return (
    <span
      ref={box}
      className="relative min-w-0 shrink overflow-hidden"
      data-turn-state-marquee={looping ? "" : undefined}
    >
      <span className={cn("inline-flex w-max whitespace-nowrap", looping && "alwith-marquee")}>
        <span ref={copy} className={looping ? "pe-4" : undefined}>
          {text}
        </span>
        {looping && (
          <span className="pe-4" aria-hidden="true">
            {text}
          </span>
        )}
      </span>
    </span>
  )
}

export function TurnProgressBar({ session }: { session: Session }): ReactNode {
  const { t } = useTranslation()
  const running = session.state === "running" || session.state === "requires_action"
  const notice = useSyncExternalStore(subscribeOverload, overloadNotice, overloadNotice)
  // A model picked mid-turn is parked until the turn settles, so the session's `configOptions`
  // still name the OLD model for the rest of the turn. Reading only those made a stalled GPT turn
  // keep its amber "at capacity" row after the reader had already chosen DeepSeek — the exact
  // "switched away and it still says overloaded" report. The pending choice is what the picker
  // shows, so it is also what the row must respect.
  const pendingModel = useStore(client.store, (state) => state.pendingModels?.[session.id])
  const chosenModel = pendingModel ?? selectedModelId(session.configOptions)
  // In a group discussion the floor moves between roles, each on its own model. The session's
  // configured model is not what is answering, so the row names the member holding the floor.
  const [speaker, setSpeaker] = useState<string | null>(null)
  useEffect(() => subscribeGroupSpeaker((next) => setSpeaker(next)), [])
  const [, tick] = useState(0)

  useEffect(() => {
    if (!running) return
    // 350ms drives the cycling dots; the MM:SS clock only changes once a second.
    const timer = setInterval(() => tick((value) => value + 1), 350)
    return () => clearInterval(timer)
  }, [running])
  // The notice lives in a module store, so a turn that ends OR resumes output while overloaded
  // must clear it — otherwise the next turn opens with a stale "at capacity" line. `session.clock`
  // moves on every applied update, the cheapest proof that tokens are still flowing.
  useEffect(() => {
    if (!running) dismissOverload(session.id)
    else if (
      notice !== null &&
      notice.sessionId === session.id &&
      // Output resumed, or the reader picked a different model: either way A's notice is over.
      (session.clock > notice.at || !matchesReportedModel(chosenModel, notice.model))
    )
      dismissOverload(session.id)
  }, [running, session.id, session.clock, session.configOptions, notice, chosenModel])

  // Every hook must run on every render. `trackTurn` returns null the moment a turn ends, and the
  // early return below would then skip the two subscriptions underneath — flipping the hook count
  // between renders, which React rejects outright ("rendered fewer/more hooks than expected",
  // #300 / #310) and shows as the app-wide error page. Both subscriptions are independent of
  // `turn`, so they belong with the other hooks, above the bail-out.
  const orchestration = useSyncExternalStore(
    subscribeOrchestration,
    () => orchestrationFor(session.id),
    () => orchestrationFor(session.id)
  )
  const phase = useSyncExternalStore(
    client.subscribeOrchestrationPhase.bind(client),
    () => client.orchestrationPhaseFor(session.id),
    () => client.orchestrationPhaseFor(session.id)
  )
  // Sending mid-turn only steers when the chat surface is set to do that. In "queued" mode the
  // composer holds messages until the turn settles, so a nudge from the row would not reach the
  // model at all — it would arrive afterwards as a stray "继续" turn. Whether it is offered is
  // decided below, but the subscription has to sit with the other hooks, above the bail-out.
  const steering = useSyncExternalStore(
    subscribeChatDisplayPreferences,
    () => getQueueSendMode() === "immediate",
    () => getQueueSendMode() === "immediate"
  )
  // 设置 → 大模型 → 长时间无输出自动催一句. On by default; a reader who turns it off keeps the
  // manual button and nothing else changes.
  const autoNudgeOn = useSyncExternalStore(subscribeAutoNudge, autoNudgeEnabled, autoNudgeEnabled)

  const turn = trackTurn(session)
  // The count is keyed to the turn it belongs to, so a finished turn's "自动催了 1 次" can never
  // show up over the next one: the key mismatch already reads as zero, without a reset effect.
  const [autoNudge, setAutoNudge] = useState<{ turn: number; count: number }>({ turn: 0, count: 0 })
  const reportAutoNudge = useCallback(
    (count: number) => {
      setAutoNudge({ turn: turn === null ? 0 : turn.start, count })
    },
    [turn]
  )
  if (turn === null) return null
  const now = Date.now()
  const silent = now - turn.last
  const stage = stageOf(session)
  // Local work: a tool still executing, or a compaction pass. The upstream has no request in flight
  // during either, so a quiet spell there is the machine working — never the model failing to
  // answer. Only upstream evidence (overload / no-ack) or a long plain wait may suggest switching.
  const runningTool = activeTool(session)
  const localBusy = runningTool !== null || stage.key === "chat.turnProgress.compacting"
  const parked = awaitingUser(session)
  // In an orchestrated turn the session's selected id is only swapped to the active role partway
  // through, so the captured `turn.model` can still read as the other role. The phase the client
  // records is the source of truth: name the planner or worker model the turn is actually on.
  let rolePrefix: string | null = null
  let roleModel: string | null = null
  if (orchestration !== null && phase !== null) {
    const roleModelId = phase === "planner" ? orchestration.planner.model : orchestration.worker.model
    roleModel = labelForModelId(session, roleModelId) ?? roleModelId
    rolePrefix = phase === "planner" ? t("chat.turnProgress.rolePlanner") : t("chat.turnProgress.roleWorker")
  }
  // One row carries both facts: an upstream overload IS the reason the turn is silent, so showing a
  // separate banner above this one repeated the same model name and the same wait twice.
  // "At capacity" is only true while the overload is what is holding the turn. The moment the
  // session applies another update, output resumed and the row must go back to 回复中/正在思考.
  // How long the upstream asked us to wait, counted down in place. When the estimate runs out the
  // row goes back to the plain "reconnecting" state; the engine is already retrying on its own.
  const remainingMs = notice?.retryAfter == null ? 0 : Math.max(0, notice.at + notice.retryAfter * 1000 - now)
  const overload =
    notice !== null &&
    notice.sessionId === session.id &&
    turn.last <= notice.at &&
    // One model's capacity is not another model's. The notice is a module singleton, so without
    // this a GPT model that stalled once kept every later turn on every sibling model amber.
    matchesReportedModel(turn.modelId, notice.model) &&
    // ...and a mid-turn pick is already a decision: the parked model is what the picker shows, so
    // the amber row must not survive the reader switching away from the stalled one.
    matchesReportedModel(chosenModel, notice.model) &&
    // The event can arrive after two seconds of a retry loop; the reader only needs to hear about
    // it once the wait is long enough to act on.
    silent >= NUDGE_MS &&
    (notice.retryAfter === null ? now - notice.at < OVERLOAD_TTL_MS : remainingMs > 0)
      ? notice
      : null
  const quiet = !localBusy && !parked && silent >= QUIET_MS && overload === null
  // Amber is evidence, not a mood: only the bridge can prove the upstream is the one not answering.
  const alerting = overload !== null
  const state = stateOf(session, parked)
  // The row's one action is a nudge, offered together with the silence badge: it is cheap and
  // reversible, so it does not need a separate, later threshold. A turn running a tool or parked on
  // a prompt is busy elsewhere or waiting on the reader — nudging either would be noise, and while
  // the bridge is replaying an overload, a nudge cannot reach it.
  const canNudge = quiet && steering && !localBusy && !parked && overload === null
  // Whole seconds of silence, stated inside the row's one line — the same line, not a second card.
  // A running tool or a parked prompt is not silence, so neither states one.
  const quietSeconds = !localBusy && !parked && silent >= QUIET_TEXT_MS ? Math.floor(silent / 1000) : null
  // Only this turn's count is shown; a previous turn's number can never leak onto the next one.
  const autoNudged = autoNudge.turn === turn.start ? autoNudge.count : 0
  // `·` → `··` → `···` on the same 350ms beat as the re-render, so the row reads as alive
  // instead of ending in a static ellipsis that looks like truncated text.
  const dots = "·".repeat((Math.floor(now / 350) % 3) + 1)
  // Locked to the model the turn started on; null falls back to the live picker.
  const liveModel = modelLabel(session)
  const model = speaker ?? (roleModel !== null ? roleModel : turn.model) ?? liveModel
  const baseTitle = t(stage.key, { name: stage.name, count: stage.count })
  const stateTitle =
    rolePrefix === null ? baseTitle : `${baseTitle} · ${t("chat.turnProgress.roleActive", { role: rolePrefix })}`
  const quietFor = duration(silent)
  const eta = duration(remainingMs)
  // The explanation rides on the badge and the "?" as a native hover title. A floating toast said
  // the same thing over the top of whatever the reader was looking at — the row already sits beside
  // the wait it describes, so the copy belongs there, not on top of the document.
  const slowHelp = t("chat.turnProgress.slowModel")
  // An at-capacity upstream is the one case where the row is reporting a fact, so its hover carries
  // the fact plus where the remedy lives: the model picker under the composer, the single place a
  // model is switched from.
  const stallHelp =
    overload === null
      ? null
      : overload.retryAfter === null
        ? t("chat.overload.descriptionUnknown")
        : t("chat.overload.description", { minutes: overload.minutes ?? 1 })
  const turnStateText =
    overload !== null
      ? overload.reason === "no_ack"
        ? t("chat.overload.titleNoAck", {
            model: overload.modelName,
            duration: t(quietFor.key, quietFor.values)
          })
        : overload.retryAfter === null
          ? t("chat.overload.titleUnknown", { model: overload.modelName })
          : t("chat.overload.titleRecover", {
              model: overload.modelName,
              duration: t(eta.key, eta.values)
            })
      : t(`chat.turnProgress.${state}`, {
          name: model ?? t("chat.turnProgress.stateModelFallback")
        })

  return (
    <div className="w-full min-w-0" data-turn-progress="">
      {/* Renders nothing: it owns the auto-nudge timer so the row itself stays a pure render. */}
      <AutoNudger
        session={session}
        turnStart={turn.start}
        turnLast={turn.last}
        enabled={autoNudgeOn}
        steering={steering}
        localBusy={localBusy}
        parked={parked}
        blocked={overload !== null}
        silentSeconds={Math.floor(silent / 1000)}
        onCountChange={reportAutoNudge}
      />
      <div
        className={cn(
          "relative flex min-w-0 items-center gap-2 overflow-hidden text-[11px]",
          // Healthy turns get no box at all: the row is part of the composer card, and a second
          // bordered slab above it was exactly the "layer cake" the composer did not need.
          alerting ? "h-8 rounded-lg border border-amber-500/35 bg-amber-500/[0.07] px-2.5" : "h-7 px-0.5"
        )}
      >
        {/* An indeterminate hairline says "still alive" without another line of copy. Only the
            alert state draws one; a healthy turn is just text. */}
        {alerting && (
          <span className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden" aria-hidden="true">
            <span className="block h-full w-1/3 animate-pulse bg-gradient-to-r from-transparent via-amber-500/60 to-transparent" />
          </span>
        )}
        {overload !== null ? (
          <AlertTriangleIcon className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
        ) : (
          <Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        )}
        <span
          className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden font-medium text-foreground/85"
          title={stallHelp ?? stateTitle}
          data-turn-state=""
        >
          {rolePrefix !== null && (
            <span className="shrink-0 rounded bg-primary/12 px-1 py-px text-[10px] leading-tight font-semibold text-primary">
              {rolePrefix}
            </span>
          )}
          <StateMarquee text={turnStateText} />
          {(overload !== null || state !== "stateConfirm") && (
            <span className="inline-block w-[1.5em] shrink-0 text-left" aria-hidden="true">
              {dots}
            </span>
          )}
          {overload === null &&
            (autoNudged > 0 ? (
              <span className="shrink-0 text-muted-foreground" data-turn-auto-nudged="">
                {t("chat.turnProgress.autoNudged", { count: autoNudged })}
              </span>
            ) : (
              quietSeconds !== null && (
                <span className="shrink-0 text-muted-foreground/80" data-turn-quiet-for="">
                  {t("chat.turnProgress.quietFor", { seconds: quietSeconds })}
                </span>
              )
            ))}
        </span>
        {quiet && (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground tabular-nums"
            title={slowHelp}
            data-turn-quiet=""
          >
            {t("chat.turnProgress.quiet", { duration: t(quietFor.key, quietFor.values) })}
          </span>
        )}
        <span className="shrink-0 text-muted-foreground/70 tabular-nums">{clock(now - turn.start)}</span>
        {quiet && (
          <TooltipProvider delay={0}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={t("chat.turnProgress.details")}
                    className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                  />
                }
              >
                <CircleHelpIcon className="size-3" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent role="tooltip" side="top" className="max-w-[280px] text-left leading-relaxed">
                {slowHelp}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {canNudge && (
          <button
            type="button"
            title={t("chat.turnProgress.nudgeHint")}
            className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            onClick={() => void nudgeTurn(session)}
          >
            {t("chat.turnProgress.nudge")}
          </button>
        )}
      </div>
    </div>
  )
}
