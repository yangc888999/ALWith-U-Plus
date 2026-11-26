/**
 * The one model control a chat surface may render.
 *
 * A conversation has three different pickers because it has three different states, and the
 * choice between them used to live in each surface: `draft-chat` carried its own ternary for the
 * pre-session case, `chat-view` carried `showFallbackPicker`, and the composer's package fell back
 * to a fourth menu of its own whenever a surface passed nothing. Two of those decisions going out
 * of sync is exactly how the same screen ended up with two model controls (2026-11-17).
 *
 * Nothing here is new behaviour — every branch is the branch that surface used to take — but the
 * decision now has one home, and a surface can only ask for "my model entry", never for a
 * particular picker.
 */
import type { Session } from "@alwith/api"
import { ModelMenu } from "@alwith/module-chat/conversation"
import { useStore } from "zustand"

import { selectedModelId } from "@/agent/native-models"
import { client } from "@/lib/client"
import { resolveModelOptions } from "@/lib/model-options"
import { displayModelLabel, getProviderSnapshot, type ProviderSnapshot } from "@/lib/providers"

import { DraftModelSelect } from "./draft-model-select"
import { chatModelMenu } from "./model-catalog"
import { RecoveryModelSelect } from "./recovery-model-select"
import { selectSessionModel } from "./select-session-model"

/** Which control the entry renders; `none` keeps the slot empty on purpose. */
export type ModelEntryKind = "menu" | "recovery" | "draft" | "none"

/**
 * Why the model control cannot be used right now. Only `ready` enables it, but naming the reason
 * keeps six independent booleans from drifting apart — the caller used to spell them out as one
 * `||` chain per surface, and a seventh condition was easy to add to one and forget on the other.
 */
export type ModelGate = "ready" | "preparing" | "failed" | "offline" | "detached" | "restoring" | "read-only"

type ConfigOption = Session["configOptions"][number]
export type PendingEffort = { model: string; effort: string }
type SelectShape = {
  type?: string
  configId?: string
  category?: string | null
  currentValue?: unknown
  options?: unknown
}
type SelectEntry = { value?: unknown; name?: unknown; options?: unknown; _meta?: unknown }

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
  persistent: "Persistent"
}

function selectEntries(option: SelectShape): SelectEntry[] {
  const entries = Array.isArray(option.options) ? (option.options as SelectEntry[]) : []
  return entries.flatMap((entry) =>
    Array.isArray(entry.options) ? (entry.options as SelectEntry[]) : [entry]
  )
}

function selectChoices(option: SelectShape): Array<{ value: string; name: string }> {
  return selectEntries(option).filter(
    (entry): entry is { value: string; name: string } =>
      typeof entry.value === "string" && typeof entry.name === "string"
  )
}

/** The session's own catalog carries the ladder for every model, including a parked one. */
function sessionEffortProfile(
  options: readonly ConfigOption[],
  model: string
): { efforts: string[]; defaultEffort: string | null } | null {
  const modelOption = options.find((option) => option.category === "model" && option.type === "select") as
    | (ConfigOption & SelectShape)
    | undefined
  if (modelOption === undefined) return null
  const choice = selectEntries(modelOption).find((entry) => entry.value === model)
  const alwith = (choice?._meta as { alwith?: { supportedReasoningEfforts?: unknown; defaultReasoningEffort?: unknown } } | undefined)
    ?.alwith
  const efforts = Array.isArray(alwith?.supportedReasoningEfforts)
    ? alwith.supportedReasoningEfforts.filter((entry): entry is string => typeof entry === "string")
    : []
  if (efforts.length === 0) return null
  return {
    efforts,
    defaultEffort: typeof alwith?.defaultReasoningEffort === "string" ? alwith.defaultReasoningEffort : null
  }
}

/**
 * While a model switch is parked, the session still describes the old model's effort ladder.
 * Replace it with the pending model's ladder so Effort stays editable during the running turn;
 * the choice itself is parked by the client and lands with the model on the next turn.
 */
export function pickerOptionsWithPendingEffort(
  options: readonly ConfigOption[],
  pendingModel: string | null,
  pendingEffort: PendingEffort | null
): ConfigOption[] {
  const thought = options.find((option) => option.category === "thought_level" && option.type === "select") as
    | (ConfigOption & SelectShape)
    | undefined
  if (thought === undefined) return [...options]
  const model = pendingModel ?? selectedModelId([...options])
  if (model === null) return [...options]

  if (pendingModel === null) {
    if (pendingEffort?.model !== model) return [...options]
    if (!selectChoices(thought).some((choice) => choice.value === pendingEffort.effort)) return [...options]
    return options.map((option) =>
      option === thought ? ({ ...option, currentValue: pendingEffort.effort } as unknown as ConfigOption) : option
    )
  }

  const withoutFastMode = options.filter((option) => option.configId !== "fast-mode")
  const sessionProfile = sessionEffortProfile(options, pendingModel)
  const catalogProfile = sessionProfile === null ? resolveModelOptions({ providerSnapshot: getProviderSnapshot() }).byId(pendingModel) : null
  const efforts = sessionProfile?.efforts ?? catalogProfile?.efforts ?? []
  if (efforts.length === 0) {
    return withoutFastMode.filter((option) => option !== thought)
  }
  const names = new Map(selectChoices(thought).map((choice) => [choice.value, choice.name]))
  const levels = efforts.map((value) => ({
    value,
    name: names.get(value) ?? EFFORT_LABELS[value] ?? value
  }))
  const requested =
    pendingEffort?.model === pendingModel && efforts.includes(pendingEffort.effort)
      ? pendingEffort.effort
      : null
  const defaultEffort = sessionProfile?.defaultEffort ?? catalogProfile?.defaultEffort ?? null
  const fallback =
    defaultEffort !== null && efforts.includes(defaultEffort) ? defaultEffort : efforts[0]!
  return withoutFastMode.map((option) =>
    option === thought
      ? ({ ...option, currentValue: requested ?? fallback, options: levels } as unknown as ConfigOption)
      : option
  )
}

export function modelGateOf(
  session: Session | null,
  surface: { preparing?: boolean; failure?: unknown; connected?: boolean } = {}
): ModelGate {
  if (surface.preparing === true) return "preparing"
  if (surface.failure !== null && surface.failure !== undefined) return "failed"
  if (surface.connected === false) return "offline"
  // A draft has no session yet, and a conversation whose replay never attached is the same thing
  // from the picker's point of view: there is nothing to write a choice to.
  if (session === null || !session.attached) return "detached"
  if (session.restoring) return "restoring"
  if (session.readOnly) return "read-only"
  return "ready"
}

/**
 * - `menu` — the session publishes a `model` config option (the normal case).
 * - `recovery` — it does not, because an account model was revoked: the shared menu renders
 *   nothing at all there, so the recovery picker has to take its place.
 * - `draft` — no session yet and preparation failed: a model must be chosen before retrying.
 * - `none` — nothing to offer (a draft still preparing its first session).
 */
export function modelEntryKind(
  session: Session | null,
  surface: "session" | "draft",
  state: { failure?: unknown; preparing?: boolean } = {}
): ModelEntryKind {
  if (surface === "draft") {
    if (session !== null) return "menu"
    return state.failure !== null && state.failure !== undefined && state.preparing !== true ? "draft" : "none"
  }
  if (session === null) return "none"
  const options = session.configOptions ?? []
  const hasModelOption = options.some((option) => option.configId === "model")
  // `configOptions: []` is how every chat starts: the engine fills the list in during the replay.
  // Reading that gap as "model revoked" flashed the recovery picker on every chat as it opened.
  const stillLoading = options.length === 0 && session.restoring
  return hasModelOption || stillLoading ? "menu" : "recovery"
}

type DraftModelEntry = {
  surface: "draft"
  /** The draft's session, or `null` while preparation has not produced one. */
  session: Session | null
  snapshot: ProviderSnapshot | null
  /** The draft's own selection, used when no session exists to read a value from. */
  model: string | null
  preparing: boolean
  /** The preparation failure, if any. */
  failure: unknown
  connected: boolean
  /** A model pick, or `null` for the native default. */
  onChange: (model: string | null) => void
}

type SessionModelEntry = {
  surface: "session"
  session: Session
}

/**
 * Rendering the slot is all a surface does; which control appears is decided here.
 *
 * Draft surfaces pass their own change handler because a draft's pick re-prepares the session
 * rather than writing a config option. Conversations keep the menu's default handler.
 */
export function ModelEntry(props: DraftModelEntry | SessionModelEntry) {
  // Read once, before any branch: hooks cannot sit behind an early return. A revoked account model
  // is the only reason a live conversation loses its `model` option, so it steers the recovery
  // picker's action (`resumeAccountModel`) instead of a plain config write that would be refused.
  const sessionId = props.session?.id ?? null
  const recovering = useStore(client.store, (state) =>
    sessionId === null ? false : (state.accountModelRecovery?.[sessionId] ?? false)
  )
  const pending = useStore(client.store, (state) => sessionId === null ? null : (state.pendingModels?.[sessionId] ?? null))
  const pendingEffort = useStore(client.store, (state) =>
    sessionId === null ? null : (state.pendingEfforts?.[sessionId] ?? null)
  )
  const options = props.session?.configOptions ?? []
  const pickerOptions = pickerOptionsWithPendingEffort(options, pending, pendingEffort).map((option) =>
    pending !== null && option.category === "model" && option.type === "select"
      ? { ...option, currentValue: pending }
      : option
  )

  if (props.surface === "draft") {
    const kind = modelEntryKind(props.session, "draft", { failure: props.failure, preparing: props.preparing })
    if (kind === "menu" && props.session !== null) {
      const gate = modelGateOf(props.session, {
        preparing: props.preparing,
        failure: props.failure,
        connected: props.connected
      })
      return (
        <ModelMenu
          {...chatModelMenu}
          sessionId={props.session.id}
          options={pickerOptions}
          disabled={gate !== "ready"}
          onModelChange={props.onChange}
        />
      )
    }
    if (kind === "draft") {
      return <DraftModelSelect snapshot={props.snapshot} model={props.model} onChange={props.onChange} />
    }
    return null
  }

  const kind = modelEntryKind(props.session, "session")
  if (kind === "recovery") {
    return (
      <RecoveryModelSelect
        sessionId={props.session.id}
        cwd={props.session.cwd}
        currentModel={pending ?? selectedModelId(options)}
        recovering={recovering}
      />
    )
  }
  // The trigger ellipsises when the composer is too narrow for the full name (index.css), so the
  // whole name has to remain readable somewhere: a native hover title on the slot. The id comes
  // from the session's own options; the display name prefers the reader's rename, then the
  // catalogue's label, then the raw id — the same order the turn-progress row uses.
  const modelId = pending ?? selectedModelId(options)
  const option = props.session.configOptions.find((entry) => entry.category === "model" && entry.type === "select")
  const choices: unknown[] =
    option !== undefined && option.type === "select" && Array.isArray(option.options) ? option.options : []
  let catalogueLabel: string | null = null
  for (const entry of choices) {
    const nested = (entry as { options?: unknown }).options
    const list = Array.isArray(nested) ? nested : [entry]
    for (const item of list) {
      const choice = item as { value?: unknown; name?: unknown }
      if (choice.value === modelId && typeof choice.name === "string" && choice.name !== "") catalogueLabel = choice.name
    }
  }
  const fullName = modelId === null ? undefined : (displayModelLabel(modelId) ?? catalogueLabel ?? modelId)
  return (
    <div className="contents" title={fullName}>
      <ModelMenu
        {...chatModelMenu}
        sessionId={props.session.id}
        options={pickerOptions}
        disabled={modelGateOf(props.session) !== "ready"}
        onModelChange={(value) => void selectSessionModel(props.session.id, value)}
      />
    </div>
  )
}
