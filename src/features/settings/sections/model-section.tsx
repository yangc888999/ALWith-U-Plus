// Default model + default effort for new conversations.
//
// v1.0.3：这里的 ① 默认会话模型 和 ② 分工默认模型（规划/执行）不再自己拼分组、自己取
// 引擎目录、自己判断「可用」。两者连同 ③ 聊天输入框、④ 拉会成员，统一调用
// `useModelOptions()` / `resolveModelOptions()` 这一个出口，渲染也复用同一个
// `ModelOptionsSelect`，所以名称、分组、图标、排序、可用性、Effort 与加速口径完全一致。
import { Zap } from "lucide-react"
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/alwith-ui/select"
import { ModelOptionsSelect } from "@/components/model-options/model-options-select"
import { Button } from "@/components/ui/button"
import { defaultModelSnapshot, setDefaultModelChoice, subscribeDefaultModel } from "@/lib/default-model"
import { modelFastModeSnapshot, setModelFastMode, subscribeModelFastMode } from "@/lib/model-fast-mode"
import type { ModelOption, ModelOptionsResult } from "@/lib/model-options"
import {
  orchestrationDefaultsSnapshot,
  setOrchestrationDefaults,
  subscribeOrchestrationDefaults
} from "@/lib/orchestration-defaults"
import { useModelOptions } from "@/lib/use-model-options"
import { cn } from "@/lib/utils"

import { SettingsCard, SettingsNote } from "./shared"

/** "Follow the built-in default", sentinel for an unset choice. */
const AUTO = "auto"

export function ModelSection({ onApplied }: { onApplied?: (model: string | null) => void } = {}): ReactNode {
  const { t } = useTranslation()
  // 唯一出口：候选集来自「供应商与可用模型」的 enabled shortlist + 各供应商分组，
  // 引擎目录只补能力元数据，绝不裁剪。新增/启用一个模型，四处同时拿到它。
  const result = useModelOptions()
  const choice = useSyncExternalStore(subscribeDefaultModel, defaultModelSnapshot, defaultModelSnapshot)
  const savedDefaults = useSyncExternalStore(
    subscribeOrchestrationDefaults,
    orchestrationDefaultsSnapshot,
    orchestrationDefaultsSnapshot
  )
  const entries = result.options

  const selected = choice?.model ?? null
  const effort = choice?.effort ?? null
  // A model without a published ladder still accepts the standard levels; an empty list used to
  // leave the Effort picker offering nothing but "follow the model default".
  const levelsOf = (option: ModelOption | null): string[] =>
    option === null ? [] : option.efforts.length > 0 ? [...option.efforts] : ["low", "medium", "high", "max"]

  // Edits stay local until 「立即应用」: picking a model here used to save silently, which made
  // the selection impossible to review before it affected new chats.
  const [draftModel, setDraftModel] = useState<string>(selected ?? AUTO)
  const [draftEffort, setDraftEffort] = useState<string>(effort ?? AUTO)
  useEffect(() => {
    setDraftModel(selected ?? AUTO)
    setDraftEffort(effort ?? AUTO)
  }, [selected, effort])
  const draftEntry = result.byId(draftModel)
  const draftEfforts = levelsOf(draftEntry)
  const draftIsGpt = draftEntry?.isNative === true
  // What the new chat will actually run on: an explicit pick, or the level the model publishes as
  // its own default. The ladder names alone ("xhigh", "max") say nothing about cost or latency, so
  // the pane spells out the level in use instead of leaving the user to guess.
  const activeEffort = draftEffort === AUTO ? (draftEntry?.defaultEffort ?? null) : draftEffort
  const effortMeaning =
    activeEffort === null ? "" : t(`defaultModel.effortLevels.${activeEffort}`, { defaultValue: "" })
  // Acceleration is a property of the model, not a staged edit: the same switch exists on the
  // model-list row and must reach conversations without a second "apply" click.
  const fastModes = useSyncExternalStore(subscribeModelFastMode, modelFastModeSnapshot, modelFastModeSnapshot)
  const draftFast = draftModel !== AUTO && fastModes[draftModel] === true
  const dirty = draftModel !== (selected ?? AUTO) || draftEffort !== (effort ?? AUTO)

  const apply = (): void => {
    if (draftModel === AUTO) {
      setDefaultModelChoice(null)
      onApplied?.(null)
      return
    }
    const saved =
      draftEffort === AUTO || draftEfforts.includes(draftEffort) ? (draftEffort === AUTO ? null : draftEffort) : null
    setDefaultModelChoice({ model: draftModel, effort: saved })
    onApplied?.(draftModel)
  }

  const effortLabel = (option: ModelOption | null): string =>
    option === null || option.defaultEffort === null
      ? t("defaultModel.effortAuto")
      : t("defaultModel.effortAutoWithValue", { effort: option.defaultEffort })

  // ── 分工默认模型 ────────────────────────────────────────────────────────────
  // 候选来自统一出口，不再按「引擎目录是否 authoritative」筛掉用户已启用的 GPT 模型。
  // 只排除 provider 明确拒绝过（tombstone）的行；`available` 的口径与另外三处完全相同。
  const liveNative = entries.filter((option) => option.isNative && option.available)
  const fallbackPlanner = liveNative[0] ?? entries[0] ?? null
  const fallbackWorker = liveNative[1] ?? liveNative[0] ?? entries[0] ?? null

  const [plannerModel, setPlannerModel] = useState<string>(
    () => savedDefaults?.planner.model ?? fallbackPlanner?.id ?? ""
  )
  const [plannerEffort, setPlannerEffort] = useState<string>(() => savedDefaults?.planner.effort ?? AUTO)
  const [plannerFast, setPlannerFast] = useState<boolean>(() => savedDefaults?.planner.fastMode === true)
  const [workerModel, setWorkerModel] = useState<string>(() => savedDefaults?.worker.model ?? fallbackWorker?.id ?? "")
  const [workerEffort, setWorkerEffort] = useState<string>(() => savedDefaults?.worker.effort ?? AUTO)
  const [workerFast, setWorkerFast] = useState<boolean>(() => savedDefaults?.worker.fastMode === true)

  // A saved pair (or a provider list arriving after mount) replaces the fallback shown initially.
  useEffect(() => {
    if (savedDefaults === null) return
    setPlannerModel(savedDefaults.planner.model)
    setPlannerEffort(savedDefaults.planner.effort ?? AUTO)
    setPlannerFast(savedDefaults.planner.fastMode === true)
    setWorkerModel(savedDefaults.worker.model)
    setWorkerEffort(savedDefaults.worker.effort ?? AUTO)
    setWorkerFast(savedDefaults.worker.fastMode === true)
  }, [savedDefaults])

  useEffect(() => {
    if (savedDefaults !== null) return
    setPlannerModel((current) => current || (fallbackPlanner?.id ?? ""))
    setWorkerModel((current) => current || (fallbackWorker?.id ?? ""))
  }, [savedDefaults, fallbackPlanner?.id, fallbackWorker?.id])

  const plannerEntry = result.byId(plannerModel)
  const workerEntry = result.byId(workerModel)
  // A role cannot pin an effort the model did not publish: the client rejects that combination,
  // so the division picker offers the real ladder only (the session default keeps the fallback).
  const plannerLevels = plannerEntry?.efforts ?? []
  const workerLevels = workerEntry?.efforts ?? []
  // 「立即应用」 only appears when something actually differs from the stored pair.
  const divisionDirty =
    savedDefaults === null
      ? plannerModel !== (fallbackPlanner?.id ?? "") ||
        workerModel !== (fallbackWorker?.id ?? "") ||
        plannerEffort !== AUTO ||
        workerEffort !== AUTO ||
        plannerFast ||
        workerFast
      : plannerModel !== savedDefaults.planner.model ||
        plannerEffort !== (savedDefaults.planner.effort ?? AUTO) ||
        plannerFast !== (savedDefaults.planner.fastMode === true) ||
        workerModel !== savedDefaults.worker.model ||
        workerEffort !== (savedDefaults.worker.effort ?? AUTO) ||
        workerFast !== (savedDefaults.worker.fastMode === true)

  const changeDivisionModel = (role: "planner" | "worker", model: string): void => {
    const option = result.byId(model)
    const levels = option?.efforts ?? []
    const gpt = option?.isNative === true
    if (role === "planner") {
      setPlannerModel(model)
      setPlannerEffort((current) => (current !== AUTO && levels.includes(current) ? current : AUTO))
      setPlannerFast((current) => (gpt ? current : false))
    } else {
      setWorkerModel(model)
      setWorkerEffort((current) => (current !== AUTO && levels.includes(current) ? current : AUTO))
      setWorkerFast((current) => (gpt ? current : false))
    }
  }

  const saveDivision = (): void => {
    if (plannerEntry === null || workerEntry === null) return
    setOrchestrationDefaults({
      planner: {
        model: plannerEntry.id,
        effort: plannerEffort !== AUTO && plannerLevels.includes(plannerEffort) ? plannerEffort : null,
        ...(plannerEntry.isNative && plannerFast ? { fastMode: true } : {})
      },
      worker: {
        model: workerEntry.id,
        effort: workerEffort !== AUTO && workerLevels.includes(workerEffort) ? workerEffort : null,
        ...(workerEntry.isNative && workerFast ? { fastMode: true } : {})
      }
    })
    toast.success(t("defaultModel.divisionSaved"))
  }

  return (
    <div className="flex flex-col gap-6">
      {/* The router card lived here. It is injected into every engine this app spawns
          (`-c model_providers.alwith.*`), owns no models, cannot be selected, and its only content
          was a note that it exists — nothing the reader could act on, so it is not shown
          (2026-11-09). The injection itself is unchanged. */}
      <SettingsCard
        title={t("defaultModel.title")}
        desc={t("defaultModel.description")}
        action={<ScopeTag>{t("defaultModel.scopeNewChat")}</ScopeTag>}
      >
        {/* Same four columns as 分工默认模型: 角色 | 默认模型 | 默认 Effort | 加速. The top inset comes
          from the card body rule, so it matches every other card. */}
        <div className="space-y-2 pb-3">
          <div className="hidden gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[6.5rem_minmax(0,19rem)_9.25rem_2.5rem]">
            <span>{t("defaultModel.divisionRole")}</span>
            <span>{t("defaultModel.divisionModel")}</span>
            <span>{t("defaultModel.effort")}</span>
            <span className="text-center">{t("defaultModel.columnFast")}</span>
          </div>
          <div className="grid items-center gap-2 sm:grid-cols-[6.5rem_minmax(0,19rem)_9.25rem_2.5rem]">
            <span className="text-sm">{t("defaultModel.newChat")}</span>
            <ModelOptionsSelect
              result={result}
              value={draftModel}
              auto={{ value: AUTO, label: t("defaultModel.auto") }}
              ariaLabel={t("defaultModel.model")}
              onValueChange={(next) => {
                setDraftModel(next)
                // Keep effort only when the new model publishes it.
                const option = result.byId(next)
                setDraftEffort((current) => (current !== AUTO && levelsOf(option).includes(current) ? current : AUTO))
              }}
            />
            <Select
              value={draftEffort}
              disabled={draftModel === AUTO}
              items={[
                { label: effortLabel(draftEntry), value: AUTO },
                ...draftEfforts.map((level) => ({ label: level, value: level }))
              ]}
              onValueChange={(value) => setDraftEffort(value ?? AUTO)}
            >
              <SelectTrigger className="w-full" aria-label={t("defaultModel.effort")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>{effortLabel(draftEntry)}</SelectItem>
                {draftEfforts.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {draftIsGpt ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("defaultModel.fastMode")}
                aria-pressed={draftFast}
                title={draftFast ? t("defaultModel.fastModeOnHint") : t("defaultModel.fastModeOffHint")}
                className={cn("shrink-0", draftFast ? "text-emerald-500" : "text-muted-foreground")}
                onClick={() => setModelFastMode(draftModel, !draftFast)}
              >
                <Zap className="size-4" fill={draftFast ? "currentColor" : "none"} aria-hidden="true" />
              </Button>
            ) : (
              <span className="text-center text-xs text-muted-foreground">-</span>
            )}
          </div>
        </div>
        {dirty && <ApplyBar hint={t("defaultModel.applyHint")} onClick={apply} testId="default-model-apply" />}
        {draftModel !== AUTO && draftEfforts.length === 0 && (
          <SettingsNote>{t("defaultModel.effortUnavailable")}</SettingsNote>
        )}
        {draftModel !== AUTO && draftEfforts.length > 0 && effortMeaning !== "" && (
          <SettingsNote>
            {t("defaultModel.effortMeaning", { level: activeEffort, meaning: effortMeaning })}
          </SettingsNote>
        )}
        <SettingsNote>
          {t("defaultModel.candidatesNote")}{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() =>
              document.getElementById("provider-config")?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            {t("defaultModel.manageProviders")}
          </button>
        </SettingsNote>
      </SettingsCard>
      <SettingsCard
        title={t("defaultModel.divisionTitle")}
        desc={t("defaultModel.divisionDescription")}
        action={<ScopeTag>{t("defaultModel.scopeDivision")}</ScopeTag>}
      >
        {/* Cap the table so a model select does not stretch across the whole settings page. */}
        <div className="space-y-3 sm:max-w-2xl">
          <div className="hidden gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[6.5rem_minmax(0,19rem)_9.25rem_2.5rem]">
            <span>{t("defaultModel.divisionRole")}</span>
            <span>{t("defaultModel.divisionModel")}</span>
            <span>{t("defaultModel.effort")}</span>
            <span className="text-center">{t("defaultModel.columnFast")}</span>
          </div>
          <RoleDefaultsRow
            label={t("defaultModel.planner")}
            result={result}
            model={plannerModel}
            effort={plannerEffort}
            fast={plannerFast}
            onModelChange={(next) => changeDivisionModel("planner", next)}
            onEffortChange={setPlannerEffort}
            onFastChange={setPlannerFast}
          />
          <RoleDefaultsRow
            label={t("defaultModel.worker")}
            result={result}
            model={workerModel}
            effort={workerEffort}
            fast={workerFast}
            onModelChange={(next) => changeDivisionModel("worker", next)}
            onEffortChange={setWorkerEffort}
            onFastChange={setWorkerFast}
          />
        </div>
        {divisionDirty && (
          <ApplyBar
            hint={t("defaultModel.divisionApplyHint")}
            onClick={saveDivision}
            disabled={plannerEntry === null || workerEntry === null}
            testId="division-defaults-apply"
          />
        )}
        {/* A split that is already running keeps its own pair: changing this card must never
            rewrite the models of a live division behind the user's back. */}
        <SettingsNote>{t("defaultModel.divisionScopeNote")}</SettingsNote>
      </SettingsCard>
      {/* 公司模型默认思考级别已并入「供应商与可用模型」卡片（company-reasoning-row.tsx），
          不再单独占一张卡片。 */}
    </div>
  )
}

function ScopeTag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  )
}

/** The modified state is a full-width notice bar, not a small button lost under the table. */
function ApplyBar({
  hint,
  onClick,
  disabled = false,
  testId
}: {
  hint: string
  onClick: () => void
  disabled?: boolean
  testId: string
}) {
  const { t } = useTranslation()
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-primary/25 bg-primary/10 px-3 py-2">
      <span className="flex items-center gap-2 text-xs text-foreground/80">
        <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
        {hint}
      </span>
      <Button size="sm" onClick={onClick} disabled={disabled} data-testid={testId}>
        {t("defaultModel.apply")}
      </Button>
    </div>
  )
}

/** One planner/worker default row: model, effort and (GPT only) acceleration. */
function RoleDefaultsRow({
  label,
  result,
  model,
  effort,
  fast,
  onModelChange,
  onEffortChange,
  onFastChange
}: {
  label: string
  result: ModelOptionsResult
  model: string
  effort: string
  fast: boolean
  onModelChange: (model: string) => void
  onEffortChange: (effort: string) => void
  onFastChange: (fast: boolean) => void
}) {
  const { t } = useTranslation()
  const option = result.byId(model)
  // Only the model's own ladder: the client rejects a pinned effort a model does not publish.
  const levels = option?.efforts ?? []
  const gpt = option?.isNative === true
  const autoLabel =
    option === null || option.defaultEffort === null
      ? t("defaultModel.effortAuto")
      : t("defaultModel.effortAutoWithValue", { effort: option.defaultEffort })
  return (
    <div className="grid items-center gap-2 sm:grid-cols-[6.5rem_minmax(0,19rem)_9.25rem_2.5rem]">
      <span className="text-sm">{label}</span>
      <ModelOptionsSelect result={result} value={model} ariaLabel={label} onValueChange={onModelChange} />
      <Select
        value={effort}
        disabled={option === null || levels.length === 0}
        items={[{ label: autoLabel, value: AUTO }, ...levels.map((level) => ({ label: level, value: level }))]}
        onValueChange={(value) => onEffortChange(value ?? AUTO)}
      >
        <SelectTrigger className="w-full" aria-label={`${label} ${t("defaultModel.effort")}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO}>{autoLabel}</SelectItem>
          {levels.map((level) => (
            <SelectItem key={level} value={level}>
              {level}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {gpt ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`${label} ${t("defaultModel.fastMode")}`}
          aria-pressed={fast}
          title={fast ? t("defaultModel.fastModeOnHint") : t("defaultModel.fastModeOffHint")}
          className={cn("shrink-0", fast ? "text-emerald-500" : "text-muted-foreground")}
          onClick={() => onFastChange(!fast)}
        >
          <Zap className="size-4" fill={fast ? "currentColor" : "none"} aria-hidden="true" />
        </Button>
      ) : (
        <span className="hidden text-center text-xs text-muted-foreground sm:block">-</span>
      )}
    </div>
  )
}
