// Default model + default effort for new conversations: the picker joins the integrated ChatGPT
// group (answered by the main window through the settings bridge) with every configured
// provider's gateway models, so a custom vendor and the built-in GPT are chosen the same way.
import { Zap } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useSyncExternalStore } from "react"
import { toast } from "sonner"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from "@/components/alwith-ui/select"
import { Button } from "@/components/ui/button"
import { NATIVE_MODEL_GROUP } from "@/agent/native-models"
import {
  setDefaultModelChoice,
  subscribeDefaultModel,
  defaultModelSnapshot
} from "@/lib/default-model"
import {
  modelFastModeSnapshot,
  setModelFastMode,
  subscribeModelFastMode
} from "@/lib/model-fast-mode"
import {
  orchestrationDefaultsSnapshot,
  setOrchestrationDefaults,
  subscribeOrchestrationDefaults
} from "@/lib/orchestration-defaults"
import { resolveModelConfig, type ModelConfigEntry } from "@/lib/model-config"
import { useSettingsNativeModels } from "@/lib/settings-bridge"
import { useProviders } from "@/lib/use-providers"
import { cn } from "@/lib/utils"

import { SettingsCard, SettingsNote } from "./shared"

/** "Follow the built-in default", sentinel for an unset choice. */
const AUTO = "auto"

function isGptEntry(entry: ModelConfigEntry | null): boolean {
  return entry?.groupId === NATIVE_MODEL_GROUP.id
}

export function ModelSection({ onApplied }: { onApplied?: (model: string | null) => void } = {}): ReactNode {
  const { t } = useTranslation()
  const snapshot = useProviders()
  const native = useSettingsNativeModels()
  const choice = useSyncExternalStore(subscribeDefaultModel, defaultModelSnapshot, defaultModelSnapshot)
  const savedDefaults = useSyncExternalStore(
    subscribeOrchestrationDefaults,
    orchestrationDefaultsSnapshot,
    orchestrationDefaultsSnapshot
  )
  // One read-only answer for every consumer of the engine catalog: which rows this window may show,
  // and — only when the answer is authoritative — which saved rows the engine has withdrawn. The
  // settings window is usually NOT authoritative (the main window's reply may be a bundled
  // fallback), which is why `withdrawnIds` is empty here rather than a lie.
  const config = useMemo(
    () => resolveModelConfig({ providerSnapshot: snapshot, native }),
    [snapshot, native]
  )
  const entries = config.entries
  // Explain an empty GPT group instead of quietly replaying the last saved shortlist.
  const catalogUnavailable = config.status === "unavailable"
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; models: ModelConfigEntry[] }>()
    for (const entry of entries) {
      const group = map.get(entry.groupId) ?? { name: entry.groupName, models: [] }
      group.models.push(entry)
      map.set(entry.groupId, group)
    }
    return [...map.entries()]
  }, [entries])

  const selected = choice?.model ?? null
  const effort = choice?.effort ?? null
  // A model without a published ladder still accepts the standard levels; an empty list used to
  // leave the Effort picker offering nothing but "follow the model default".
  const levelsOf = (entry: ModelConfigEntry | null): string[] =>
    entry === null ? [] : entry.efforts.length > 0 ? entry.efforts : ["low", "medium", "high", "max"]

  // Edits stay local until 「立即应用」: picking a model here used to save silently, which made
  // the selection impossible to review before it affected new chats.
  const [draftModel, setDraftModel] = useState<string>(selected ?? AUTO)
  const [draftEffort, setDraftEffort] = useState<string>(effort ?? AUTO)
  useEffect(() => {
    setDraftModel(selected ?? AUTO)
    setDraftEffort(effort ?? AUTO)
  }, [selected, effort])
  const draftEntry = entries.find((item) => item.id === draftModel) ?? null
  const draftEfforts = levelsOf(draftEntry)
  const draftIsGpt = isGptEntry(draftEntry)
  // What the new chat will actually run on: an explicit pick, or the level the model publishes as
  // its own default. The ladder names alone ("xhigh", "max") say nothing about cost or latency, so
  // the pane spells out the level in use instead of leaving the user to guess.
  const activeEffort = draftEffort === AUTO ? (draftEntry?.defaultEffort ?? null) : draftEffort
  const effortMeaning =
    activeEffort === null ? "" : t(`defaultModel.effortLevels.${activeEffort}`, { defaultValue: "" })
  // Acceleration is a property of the model, not a staged edit: the same switch exists on the
  // model-list row and must reach conversations without a second "apply" click.
  const fastModes = useSyncExternalStore(
    subscribeModelFastMode,
    modelFastModeSnapshot,
    modelFastModeSnapshot
  )
  const draftFast = draftModel !== AUTO && fastModes[draftModel] === true
  const dirty = draftModel !== (selected ?? AUTO) || draftEffort !== (effort ?? AUTO)

  const apply = (): void => {
    if (draftModel === AUTO) {
      setDefaultModelChoice(null)
      onApplied?.(null)
      return
    }
    const saved = draftEffort === AUTO || draftEfforts.includes(draftEffort) ? (draftEffort === AUTO ? null : draftEffort) : null
    setDefaultModelChoice({ model: draftModel, effort: saved })
    onApplied?.(draftModel)
  }

  const effortLabel = (entry: ModelConfigEntry | null): string =>
    entry === null || entry.defaultEffort === null
      ? t("defaultModel.effortAuto")
      : t("defaultModel.effortAutoWithValue", { effort: entry.defaultEffort })

  // ── 分工默认模型 ────────────────────────────────────────────────────────────
  const nativeEntries = entries.filter((entry) => entry.groupId === NATIVE_MODEL_GROUP.id)
  // Defaults must be runnable. 可用模型 keeps a row the engine has revoked (`gpt-6.1-terra`), so
  // choosing a hardcoded id off the raw list would point a fresh split at a model that cannot
  // answer a single prompt. Only `unsupported` — the tombstone verdict, meaning the provider
  // refused this id — is excluded: `unknown` merely says no authoritative catalog reached this
  // window, and that must not cost a model its chance at being the default.
  const liveNative = nativeEntries.filter((entry) => entry.status !== "unsupported")
  const fallbackPlanner =
    liveNative.find((entry) => entry.id === "gpt-6.1-sol") ?? liveNative[0] ?? entries[0] ?? null
  // The worker defaults to the second live row. A hardcoded `gpt-6.1-terra` used to sit here; the
  // provider withdrew it, and a name that changes on the provider's schedule is not a default.
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

  const plannerEntry = entries.find((entry) => entry.id === plannerModel) ?? null
  const workerEntry = entries.find((entry) => entry.id === workerModel) ?? null
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
    const entry = entries.find((item) => item.id === model) ?? null
    const levels = entry?.efforts ?? []
    const gpt = isGptEntry(entry)
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
        ...(isGptEntry(plannerEntry) && plannerFast ? { fastMode: true } : {})
      },
      worker: {
        model: workerEntry.id,
        effort: workerEffort !== AUTO && workerLevels.includes(workerEffort) ? workerEffort : null,
        ...(isGptEntry(workerEntry) && workerFast ? { fastMode: true } : {})
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
      {catalogUnavailable && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {t("defaultModel.catalogUnavailable")}
        </p>
      )}
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
          <Select
            value={draftModel}
            // `items` lets the trigger render the model's label instead of its raw gateway id.
            items={[
              { label: t("defaultModel.auto"), value: AUTO },
              ...entries.map((entry) => ({ label: entry.label, value: entry.id }))
            ]}
            onValueChange={(value) => {
              const next = value ?? AUTO
              setDraftModel(next)
              // Keep effort only when the new model publishes it.
              const entry = entries.find((item) => item.id === next) ?? null
              setDraftEffort((current) => (current !== AUTO && levelsOf(entry).includes(current) ? current : AUTO))
            }}
          >
            <SelectTrigger className="w-full" aria-label={t("defaultModel.model")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>{t("defaultModel.auto")}</SelectItem>
              {groups.map(([groupId, group]) => (
                <SelectGroup key={groupId}>
                  <SelectLabel>{group.name}</SelectLabel>
                  {group.models.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
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
      {dirty && (
        <ApplyBar hint={t("defaultModel.applyHint")} onClick={apply} testId="default-model-apply" />
      )}
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
            entries={entries}
            groups={groups}
            model={plannerModel}
            effort={plannerEffort}
            fast={plannerFast}
            onModelChange={(next) => changeDivisionModel("planner", next)}
            onEffortChange={setPlannerEffort}
            onFastChange={setPlannerFast}
          />
          <RoleDefaultsRow
            label={t("defaultModel.worker")}
            entries={entries}
            groups={groups}
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
  entries,
  groups,
  model,
  effort,
  fast,
  onModelChange,
  onEffortChange,
  onFastChange
}: {
  label: string
  entries: ModelConfigEntry[]
  groups: [string, { name: string; models: ModelConfigEntry[] }][]
  model: string
  effort: string
  fast: boolean
  onModelChange: (model: string) => void
  onEffortChange: (effort: string) => void
  onFastChange: (fast: boolean) => void
}) {
  const { t } = useTranslation()
  const entry = entries.find((item) => item.id === model) ?? null
  // Only the model's own ladder: the client rejects a pinned effort a model does not publish.
  const levels = entry?.efforts ?? []
  const gpt = isGptEntry(entry)
  const effortLabel =
    entry === null || entry.defaultEffort === null
      ? t("defaultModel.effortAuto")
      : t("defaultModel.effortAutoWithValue", { effort: entry.defaultEffort })
  return (
    <div className="grid items-center gap-2 sm:grid-cols-[6.5rem_minmax(0,19rem)_9.25rem_2.5rem]">
      <span className="text-sm">{label}</span>
      <Select value={model} items={entries.map((item) => ({ label: item.label, value: item.id }))} onValueChange={(value) => onModelChange(value ?? "")}>
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {groups.map(([groupId, group]) => (
            <SelectGroup key={groupId}>
              <SelectLabel>{group.name}</SelectLabel>
              {group.models.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={effort}
        disabled={entry === null || levels.length === 0}
        items={[{ label: effortLabel, value: AUTO }, ...levels.map((level) => ({ label: level, value: level }))]}
        onValueChange={(value) => onEffortChange(value ?? AUTO)}
      >
        <SelectTrigger className="w-full" aria-label={`${label} ${t("defaultModel.effort")}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO}>{effortLabel}</SelectItem>
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
