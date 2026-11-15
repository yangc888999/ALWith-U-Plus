import { type Session } from "@alwith/api"
import { Lightbulb, Play, Users, Zap } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"


import {
  hasUsableEffortCatalog,
  NATIVE_MODEL_GROUP,
  nativeModelCatalog,
  selectedModelId,
  type NativeModel
} from "@/agent/native-models"
import { Switch } from "@/components/ui/switch"
import { RemoteChatClient } from "@/lib/chat-window-client"
import { client } from "@/lib/client"
import { describeError } from "@/lib/error-text"
import {
  orchestrationDefaultsSnapshot,
  subscribeOrchestrationDefaults
} from "@/lib/orchestration-defaults"
import { pendingPlanFor, subscribePendingPlan } from "@/lib/pending-plan"
import { resolveModelConfig } from "@/lib/model-config"
import {
  orchestrationAllowedFor,
  orchestrationFor,
  setOrchestration,
  subscribeOrchestration,
  type OrchestrationRoleConfig
} from "@/lib/session-orchestration"
import { cn } from "@/lib/utils"

const PANEL_WIDTH = 320

// Preferred planner/worker models when 分工 is first enabled. These are only hints — the live
// catalog is never hardcoded, and `defaultModelId` falls back to the first/second native GPT row
// when a preferred id is absent from this session's runtime catalog. The worker used to hardcode
// `gpt-6.1-terra`, but an id the provider can withdraw at any time is not a safe default, so it
// now resolves to the second live GPT row instead.
const DEFAULT_PLANNER_MODEL = "gpt-6.1-sol"

function labelOf(models: NativeModel[], value: string): string {
  return models.find((model) => model.id === value)?.label ?? value
}

function roleWithModel(role: OrchestrationRoleConfig, model: NativeModel): OrchestrationRoleConfig {
  return {
    model: model.id,
    effort: role.effort !== null && model.efforts.includes(role.effort) ? role.effort : null,
    // Acceleration is a GPT capability; a gateway model drops the flag instead of carrying a lie.
    ...(role.fastMode === true && model.groupId === NATIVE_MODEL_GROUP.id ? { fastMode: true } : {})
  }
}

/** Writes the acceleration flag without leaving `fastMode: false` on every role object. */
function roleWithFastMode(role: OrchestrationRoleConfig, fastMode: boolean): OrchestrationRoleConfig {
  const { fastMode: _ignored, ...rest } = role
  return fastMode ? { ...rest, fastMode: true } : rest
}

/**
 * Per-conversation "planner / worker" control.
 *
 * The planner only writes a plan; the user approves it with "执行计划" before the worker runs. Both
 * roles own a model/effort pair. The integrated ChatGPT group follows 设置 → 可用模型 (the user's own
 * shortlist), while every gateway group is offered whole — the shortlist does not describe them.
 * A model that publishes no effort ladder simply runs on its own default, so it is offered without
 * an effort selector. The menu is portaled so the composer's clipped input shell cannot hide it.
 */
export function OrchestrationControl({ session }: { session: Session }): ReactNode {
  const { t } = useTranslation()
  const orchestration = useSyncExternalStore(
    subscribeOrchestration,
    () => orchestrationFor(session.id),
    () => orchestrationFor(session.id)
  )
  const pending = useSyncExternalStore(
    subscribePendingPlan,
    () => pendingPlanFor(session.id),
    () => pendingPlanFor(session.id)
  )
  const [open, setOpen] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [placement, setPlacement] = useState<{ left: number; bottom: number } | null>(null)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const reportedIssue = useRef<string | null>(null)

  const nativeModels = nativeModelCatalog(session.configOptions)
  // Same rows as 设置 → 默认模型 and the chat picker: one call, `resolveModelConfig`, decides which
  // saved rows count, what they are called and how deep their effort ladder is. Gateway groups have
  // no saved list of their own, so they always come from the session catalog.
  //
  // A row the provider has stopped serving is dropped from all three surfaces instead of sitting
  // here greyed out: nothing is asked of the engine to keep them in step, and the row reappears by
  // itself when the catalog carries it again.
  const engineGpt = nativeModels.filter((model) => model.groupId === NATIVE_MODEL_GROUP.id)
  // No model option at all means a draft that has not run `session/new` yet; a model option with
  // no integrated group means the engine really published none. Only the latter hides the saved
  // shortlist, so a timed-out `list_models` cannot put withdrawn ids back into the split picker —
  // a distinction `resolveModelConfig` makes once, for every surface.
  const gptChoices: NativeModel[] = resolveModelConfig({
    providerSnapshot: null,
    // No bridge list here: this surface holds the session itself, so `sessionOptions` is the catalog.
    native: undefined,
    sessionOptions: session.configOptions
  })
    .entries.filter((entry) => entry.groupId === NATIVE_MODEL_GROUP.id)
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      groupId: entry.groupId,
      efforts: entry.efforts,
      defaultEffort: entry.defaultEffort
    }))
  const gatewayChoices = nativeModels.filter((model) => model.groupId !== NATIVE_MODEL_GROUP.id)
  const offered = [...gptChoices, ...gatewayChoices]
  // A split saved before the shortlist changed can still sit on a model that is no longer offered.
  // Dropping it would leave the select blank with no effort ladder, so it stays selectable.
  const choices =
    orchestration === null
      ? offered
      : (() => {
          const keep = new Set([orchestration.planner.model, orchestration.worker.model])
          const missing = nativeModels.filter((model) => keep.has(model.id) && !offered.some((entry) => entry.id === model.id))
          return [...offered, ...missing]
        })()
  const savedDefaults = useSyncExternalStore(
    subscribeOrchestrationDefaults,
    orchestrationDefaultsSnapshot,
    orchestrationDefaultsSnapshot
  )
  // Resolved against `choices`: a default that is not actually offered would render as an empty
  // select. Falling back inside the GPT group first keeps a fresh split on two GPT models instead
  // of drifting onto a gateway.
  //
  // `engineGpt` is the session's own catalog, which is also what `gptChoices` was built from — a
  // model the provider withdrew is in neither list, so a hardcoded default can no longer put a
  // fresh split's worker on one whose first prompt would be refused.
  const defaultModelId = (preferred: string, fallbackIndex: number): string => {
    const live = (id: string): boolean => engineGpt.some((entry) => entry.id === id)
    if (choices.some((entry) => entry.id === preferred) && (engineGpt.length === 0 || live(preferred)))
      return preferred
    return (
      engineGpt[fallbackIndex]?.id ??
      gptChoices[fallbackIndex]?.id ??
      choices[fallbackIndex]?.id ??
      choices[0]?.id ??
      preferred
    )
  }
  /** Settings → 分工默认模型, resolved against what this session actually offers; falls back to Sol/Terra. */
  const configuredRole = (role: "planner" | "worker", fallbackIndex: number): OrchestrationRoleConfig => {
    const saved = savedDefaults?.[role]
    if (saved !== undefined) {
      const model = choices.find((entry) => entry.id === saved.model)
      if (model !== undefined)
        return {
          model: model.id,
          effort: saved.effort !== null && model.efforts.includes(saved.effort) ? saved.effort : null,
          ...(saved.fastMode === true && model.groupId === NATIVE_MODEL_GROUP.id ? { fastMode: true } : {})
        }
    }
    return {
      model: defaultModelId(
        role === "planner" ? DEFAULT_PLANNER_MODEL : (engineGpt[1]?.id ?? ""),
        fallbackIndex
      ),
      effort: null
    }
  }
  const currentModel = selectedModelId(session.configOptions)
  // The model catalog streams in from the engine after the session opens; before it lands the split
  // cannot be validated, so we must not auto-disable it on a false "model not found" reading.
  const catalogReady = nativeModels.length > 0
  const currentIsNative =
    catalogReady && currentModel !== null && nativeModels.some((entry) => entry.id === currentModel)

  const roleIssue = (role: OrchestrationRoleConfig, label: string): string | null => {
    // Validated against `choices`, the same list the user picks from: a saved row that the engine
    // catalog no longer advertises (a withdrawn model) is still a legitimate choice here.
    const model = choices.find((entry) => entry.id === role.model)
    if (model === undefined) return t("chat.orchestrationRoleUnsupported", { role: label })
    if (role.effort !== null && !hasUsableEffortCatalog(model))
      return t("chat.orchestrationRoleEffortUnavailable", { role: label })
    if (role.effort !== null && !model.efforts.includes(role.effort))
      return t("chat.orchestrationRoleEffortUnsupported", { role: label, effort: role.effort })
    return null
  }

  const issue =
    orchestration === null || !catalogReady
      ? null
      : !currentIsNative
        ? t("chat.orchestrationCurrentUnsupported")
        : (roleIssue(orchestration.planner, t("chat.orchestrationPlanner")) ??
          roleIssue(orchestration.worker, t("chat.orchestrationWorker")))

  useEffect(() => {
    if (orchestration === null) {
      reportedIssue.current = null
      return
    }
    if (issue === null || reportedIssue.current === issue) return
    reportedIssue.current = issue
    setOrchestration(session.id, null)
    toast.error(issue)
  }, [issue, orchestration, session.id])

  // The floating window projects the main conversation and does not own the plan/execute flow.
  // A group discussion and a quick chat are refused for a stronger reason (see
  // `orchestrationAllowedFor`): the composer already hides this control there, and the client's
  // runtime gate ignores a stored split in those conversations, so rendering anything here would
  // promise a flow the send path will not run.
  if (client instanceof RemoteChatClient || choices.length < 2) return null
  if (!orchestrationAllowedFor(session.cwd)) return null

  const execute = (): void => {
    setExecuting(true)
    void client
      .executePlan(session.id)
      .catch((error: unknown) => toast.error(describeError(error)))
      .finally(() => setExecuting(false))
  }

  if (pending !== null) {
    return (
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground disabled:opacity-60"
        disabled={executing}
        onClick={execute}
        title={t("chat.orchestrationPending")}
      >
        <Play className="size-3" />
        {executing ? t("chat.orchestrationExecuting") : t("chat.orchestrationExecute")}
      </button>
    )
  }

  const enabled = orchestration !== null && issue === null
  const planner = orchestration?.planner ?? configuredRole("planner", 0)
  const worker = orchestration?.worker ?? configuredRole("worker", 1)
  const plannerModel = choices.find((model) => model.id === planner.model)
  const workerModel = choices.find((model) => model.id === worker.model)
  const plannerEfforts = plannerModel?.efforts ?? []
  const workerEfforts = workerModel?.efforts ?? []
  const summary = enabled
    ? `${labelOf(choices, planner.model)} → ${labelOf(choices, worker.model)}`
    : t("chat.orchestrationOff")

  const setEnabled = (next: boolean): void => {
    if (!next) {
      setOrchestration(session.id, null)
      return
    }
    if (!currentIsNative) {
      toast.error(t("chat.orchestrationNativeOnly"))
      return
    }
    setOrchestration(session.id, {
      planner: configuredRole("planner", 0),
      worker: configuredRole("worker", 1)
    })
  }

  const changePlannerModel = (modelId: string): void => {
    const model = choices.find((entry) => entry.id === modelId)
    if (model === undefined) return
    setOrchestration(session.id, { planner: roleWithModel(planner, model), worker })
  }

  const changeWorkerModel = (modelId: string): void => {
    const model = choices.find((entry) => entry.id === modelId)
    if (model === undefined) return
    setOrchestration(session.id, { planner, worker: roleWithModel(worker, model) })
  }

  const effortDefaultLabel = (model: NativeModel | undefined): string =>
    model?.defaultEffort === null || model?.defaultEffort === undefined
      ? t("chat.orchestrationEffortDefault")
      : t("chat.orchestrationEffortDefaultWithValue", { effort: model.defaultEffort })

  return (
    <>
      {/* A small badge in the composer's top-right corner, like WorkBuddy's model chip: the state
          is one coloured dot, and the full 规划 → 执行 pair lives in the tooltip and the panel.
          Keeping it decorative stops a secondary setting from competing with the message box. */}
      <button
        ref={anchor}
        type="button"
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[10px] transition-colors",
          enabled
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "border-transparent bg-muted/45 text-muted-foreground hover:bg-muted/75 hover:text-foreground"
        )}
        aria-expanded={open}
        title={enabled ? summary : currentIsNative ? t("chat.orchestrationHint") : t("chat.orchestrationNativeOnly")}
        onClick={() => {
          const rect = anchor.current?.getBoundingClientRect()
          if (rect !== undefined)
            setPlacement({
              left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8)),
              bottom: window.innerHeight - rect.top + 8
            })
          setOpen((value) => !value)
        }}
      >
        <Users className="size-3 shrink-0" aria-hidden="true" />
        <span className="font-medium">{t("chat.orchestrationLabel")}</span>
        <span
          className={cn("size-1.5 shrink-0 rounded-full", enabled ? "bg-emerald-500" : "bg-muted-foreground/40")}
          aria-hidden="true"
        />
      </button>
      {open && placement !== null &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" aria-hidden onClick={() => setOpen(false)} />
            <div
              className="fixed z-50 rounded-2xl border border-border bg-popover p-4 text-xs text-popover-foreground shadow-xl ring-1 ring-black/[0.03] dark:ring-white/[0.06]"
              style={{ left: placement.left, bottom: placement.bottom, width: PANEL_WIDTH }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-foreground">{t("chat.orchestrationEnable")}</span>
                {/* A real switch: the old checkbox was the only square toggle in the composer and
                    read as a debug option rather than a conversation-wide setting. */}
                <Switch
                  aria-label={t("chat.orchestrationEnable")}
                  checked={enabled}
                  disabled={!currentIsNative}
                  onCheckedChange={setEnabled}
                />
              </div>
              {enabled && (
                <p className="mt-1 truncate text-[11px] font-medium text-emerald-700 dark:text-emerald-400" title={summary}>
                  {summary}
                </p>
              )}
              <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">{t("chat.orchestrationHint")}</p>

              <div
                className={cn(
                  "mt-3 space-y-2.5 rounded-xl border p-3 transition-colors",
                  enabled ? "border-amber-500/30 bg-amber-500/[0.06]" : "border-border/70 bg-muted/25"
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-md",
                      enabled ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-muted text-muted-foreground"
                    )}
                  >
                    <Lightbulb className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="text-[11.5px] font-semibold text-foreground">
                    {t("chat.orchestrationPlannerShort")}
                  </span>
                  <span className="truncate text-[10.5px] text-muted-foreground">
                    {t("chat.orchestrationPlannerRole")}
                  </span>
                  <button
                    type="button"
                    aria-label={t("chat.orchestrationFastMode")}
                    aria-pressed={planner.fastMode === true}
                    title={
                      plannerModel?.groupId === NATIVE_MODEL_GROUP.id
                        ? t("chat.orchestrationFastMode")
                        : t("chat.orchestrationFastModeUnavailable")
                    }
                    disabled={!enabled || plannerModel?.groupId !== NATIVE_MODEL_GROUP.id}
                    className={cn(
                      "ms-auto inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors",
                      planner.fastMode === true
                        ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
                      "disabled:cursor-not-allowed disabled:opacity-40"
                    )}
                    onClick={() =>
                      setOrchestration(session.id, {
                        planner: roleWithFastMode(planner, planner.fastMode !== true),
                        worker
                      })
                    }
                  >
                    <Zap className="size-3.5" fill={planner.fastMode === true ? "currentColor" : "none"} />
                  </button>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2">
                  <select
                    className="h-8 w-full min-w-0 rounded-lg border border-border bg-background px-2 text-[11.5px] text-foreground outline-none transition-colors focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-70"
                    aria-label={t("chat.orchestrationPlanner")}
                    value={planner.model}
                    disabled={!enabled}
                    onChange={(event) => changePlannerModel(event.target.value)}
                  >
                    {choices.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                  {plannerEfforts.length > 0 && (
                    <select
                      className="h-8 w-full min-w-0 rounded-lg border border-border bg-background px-2 text-[11.5px] text-foreground outline-none transition-colors focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-70"
                      aria-label={t("chat.orchestrationPlannerEffort")}
                      value={planner.effort ?? ""}
                      disabled={!enabled}
                      onChange={(event) =>
                        setOrchestration(session.id, {
                          planner: { model: planner.model, effort: event.target.value === "" ? null : event.target.value },
                          worker
                        })
                      }
                    >
                      <option value="">{effortDefaultLabel(plannerModel)}</option>
                      {plannerEfforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              <div
                className={cn(
                  "mt-2.5 space-y-2.5 rounded-xl border p-3 transition-colors",
                  enabled ? "border-sky-500/30 bg-sky-500/[0.06]" : "border-border/70 bg-muted/25"
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-md",
                      enabled ? "bg-sky-500/15 text-sky-600 dark:text-sky-400" : "bg-muted text-muted-foreground"
                    )}
                  >
                    <Zap className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="text-[11.5px] font-semibold text-foreground">
                    {t("chat.orchestrationWorkerShort")}
                  </span>
                  <span className="truncate text-[10.5px] text-muted-foreground">
                    {t("chat.orchestrationWorkerRole")}
                  </span>
                  <button
                    type="button"
                    aria-label={t("chat.orchestrationFastMode")}
                    aria-pressed={worker.fastMode === true}
                    title={
                      workerModel?.groupId === NATIVE_MODEL_GROUP.id
                        ? t("chat.orchestrationFastMode")
                        : t("chat.orchestrationFastModeUnavailable")
                    }
                    disabled={!enabled || workerModel?.groupId !== NATIVE_MODEL_GROUP.id}
                    className={cn(
                      "ms-auto inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors",
                      worker.fastMode === true
                        ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
                      "disabled:cursor-not-allowed disabled:opacity-40"
                    )}
                    onClick={() =>
                      setOrchestration(session.id, {
                        planner,
                        worker: roleWithFastMode(worker, worker.fastMode !== true)
                      })
                    }
                  >
                    <Zap className="size-3.5" fill={worker.fastMode === true ? "currentColor" : "none"} />
                  </button>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2">
                  <select
                    className="h-8 w-full min-w-0 rounded-lg border border-border bg-background px-2 text-[11.5px] text-foreground outline-none transition-colors focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-70"
                    aria-label={t("chat.orchestrationWorker")}
                    value={worker.model}
                    disabled={!enabled}
                    onChange={(event) => changeWorkerModel(event.target.value)}
                  >
                    {choices.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                  {workerEfforts.length > 0 && (
                    <select
                      className="h-8 w-full min-w-0 rounded-lg border border-border bg-background px-2 text-[11.5px] text-foreground outline-none transition-colors focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-70"
                      aria-label={t("chat.orchestrationWorkerEffort")}
                      value={worker.effort ?? ""}
                      disabled={!enabled}
                      onChange={(event) =>
                        setOrchestration(session.id, {
                          planner,
                          worker: { model: worker.model, effort: event.target.value === "" ? null : event.target.value }
                        })
                      }
                    >
                      <option value="">{effortDefaultLabel(workerModel)}</option>
                      {workerEfforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {(!currentIsNative || !enabled) && (
                <p className="mt-3 rounded-lg bg-muted/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                  {!currentIsNative ? t("chat.orchestrationNativeOnly") : t("chat.orchestrationDisabledHint")}
                </p>
              )}
            </div>
          </>,
          document.body
        )}
    </>
  )
}
