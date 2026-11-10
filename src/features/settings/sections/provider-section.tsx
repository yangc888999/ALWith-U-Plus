// Model providers, reduced from ALwith Desktop's API tab: compact provider pills choose one
// configuration panel. A saved key puts that provider's models into every chat's model picker;
// each chat picks its own model. Nothing global is written.
import {
  ChevronDownIcon,
  CircleHelpIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  GripVerticalIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
  Zap
} from "lucide-react"
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/alwith-ui/select"
import { ProviderMark } from "@/components/provider-mark"
import { MimoLogo } from "@/components/icons/mimo-logo"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { defaultModelSnapshot, subscribeDefaultModel } from "@/lib/default-model"
import {
  MAX_OVERLOAD_RETRY_COUNT,
  MIN_OVERLOAD_RETRY_COUNT,
  overloadRetryCount,
  setOverloadRetryCount,
  subscribeOverloadRetryCount
} from "@/lib/overload-retry-settings"
import {
  modelFastModeSnapshot,
  setModelFastMode,
  subscribeModelFastMode
} from "@/lib/model-fast-mode"
import { describeError } from "@/lib/error-text"
import { openExternal } from "@/lib/open"
import { FREE_MODEL_WATCH_SETTING } from "@/features/providers/free-model-watch"
import { useSettingsNativeModels } from "@/lib/settings-bridge"
import { useBooleanSetting } from "@/lib/use-boolean-setting"
import { Checkbox } from "@/components/ui/checkbox"
import type {
  CustomModel,
  CustomProvider,
  CustomProviderInput,
  ProviderDiscoveryInput,
  ProviderInput,
  ProviderKey,
  ProviderSnapshot,
  ProviderTestResult
} from "@/lib/providers"
import {
  applyProvidersWhenIdle,
  baseUrlLooksLikeEndpoint,
  discoverProviderModels,
  normalizeProviderBaseUrl,
  faviconUrl,
  gatewayModelId,
  mergeDiscoveredModels,
  nativeModelOverrides,
  parseCustomModels,
  type Provider,
  providerBuiltInModels,
  providerKeyUrl,
  providerRegion,
  PROVIDERS,
  retiredNativeRows,
  removeCustomProvider,
  loadProviders,
  saveBuiltInModels,
  saveCustomProvider,
  saveProviderKey,
  testProvider,
} from "@/lib/providers"
import { orchestratedSessionsUsing, providerCloseBlocker } from "@/lib/provider-usage"
import { useProviders } from "@/lib/use-providers"
import { cn } from "@/lib/utils"

import { CodexProviderSection } from "./codex-provider-section"
import { ModelSection } from "./model-section"
import { SettingsCard } from "./shared"

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A save rejected because the local revision lagged the store. In a single window this is a
 * transient mismatch, not a real concurrent edit, so it is worth a silent refresh + retry. */
function isRevisionConflict(error: unknown): boolean {
  return /changed in another window/i.test(describe(error))
}

/**
 * Runs a revision-guarded write, refreshing once if the store moved on.
 *
 * One card can write twice: toggling a model saves the catalog and bumps the revision, then the
 * 保存连接 button sends the revision the card loaded with. The second write was rejected as a
 * "changed in another window" conflict even though nothing else touched it. Refresh and retry
 * once with the store's revision; anything else (or a second failure) is a real error.
 */
export async function retryOnRevisionConflict<T>(
  attempt: (revision: number) => Promise<T>,
  revision: number,
  refresh: () => Promise<{ revision: number } | null>
): Promise<T> {
  try {
    return await attempt(revision)
  } catch (error) {
    if (!isRevisionConflict(error)) throw error
    const fresh = await refresh().catch(() => null)
    if (fresh === null || fresh.revision === revision) throw error
    return attempt(fresh.revision)
  }
}

/** The catalog persisted but the runtime rejected the reconfiguration (e.g. -32602 while busy).
 * `schedule_apply` retries it on the next idle boundary, so this is recoverable, not a hard failure. */
function isRecoverableApplyError(error: string): boolean {
  return /could not (apply|remove)/i.test(error) || /retry to apply saved settings/i.test(error)
}

const PLACEHOLDER_MODEL_ID = "model-id"
const PLACEHOLDER_MODEL_LABEL = "My Model"
// Standard custom-provider model entry. `contextWindow` is the context size in tokens; `reasoningLevels`
// lists the Effort tiers the model exposes (any of none/minimal/low/medium/high/xhigh/max/ultra/persistent);
// `defaultReasoningLevel` must be one of `reasoningLevels`. Omit a field to fall back to the /models default.
const NEW_PROVIDER_MODELS_JSON = `[
  {
    "label": "My Model",
    "api_id": "model-id",
    "contextWindow": 200000,
    "reasoningLevels": ["low", "medium", "high"],
    "defaultReasoningLevel": "medium"
  }
]`

/** The list call `curl https://api.openai.com/v1/models` makes; the key is passed in, not stored. */
const OPENAI_MODELS_URL = "https://api.openai.com/v1"
/** Where the native provider's model-list endpoint and optional remembered token live. */
const OPENAI_MODELS_BASE_URL_KEY = "alwith:openai:models-base-url"
const OPENAI_MODELS_TOKEN_KEY = "alwith:openai:models-token"

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null || value === "") localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable; the in-memory field still works for this launch.
  }
}

/**
 * The model rows a provider panel starts from: saved overrides first, else the provider's own
 * catalog — for the native OpenAI provider that catalog is the engine's GPT list published by
 * the main window, since those models ship with the binary rather than in a resource file.
 */function providerRowModels(
  snapshot: ProviderSnapshot,
  provider: Provider,
  native: ReturnType<typeof useSettingsNativeModels>
): CustomModel[] {
  const overrides = providerBuiltInModels(snapshot, provider.id)
  if (overrides.length > 0) return overrides
  if (provider.native === true)
    return (native?.models ?? []).map((model) => ({
      label: model.label,
      api_id: model.id,
      reasoningLevels: model.efforts,
      ...(model.defaultEffort === null ? {} : { defaultReasoningLevel: model.defaultEffort })
    }))
  return provider.models.map((model) => ({
    label: model.label ?? model.id,
    api_id: model.id,
    ...(model.description === undefined ? {} : { description: model.description })
  }))
}

/**
 * The provider a stored default model belongs to, or null when nothing can be attributed.
 *
 * Gateway models are stored as `gateway:<provider>:<model>`; anything else is a native model and
 * belongs to the native provider. `null` means "the built-in default", which is native as well.
 */
function providerIdForModel(model: string | null): string | null {
  if (model !== null && model.startsWith("gateway:")) return decodeURIComponent(model.split(":")[1] ?? "") || null
  return PROVIDERS.find((provider) => provider.native === true)?.id ?? null
}

export function ProviderSection() {
  const { t } = useTranslation()
  const snapshot = useProviders()
  // OpenAI's model list starts from the engine's own catalog (bridge-published), not a bundled
  // resource: the deployed engine version decides which GPT models exist.
  const nativeModels = useSettingsNativeModels()
  const keys = snapshot?.providers ?? {}
  const [busy, setBusy] = useState<string | null>(null)
  // Opening Settings lands on the provider that owns the current default model. Keeping the last
  // browsed provider instead meant "默认模型 DeepSeek, 但亮着 Kimi" -- the panel under the pills was
  // editing a provider the user never chose. The stored value is now only the fallback for a
  // default that cannot be attributed to any provider.
  const [activeId, setActiveIdState] = useState<string>(() => {
    const fromDefault = providerIdForModel(defaultModelSnapshot()?.model ?? null)
    if (fromDefault !== null) return fromDefault
    return localStorage.getItem("alwith:settings:active-provider") ?? PROVIDERS[0]?.id ?? ""
  })
  const setActiveId = useCallback((next: string) => {
    setActiveIdState(next)
    try {
      if (next !== "new") localStorage.setItem("alwith:settings:active-provider", next)
    } catch {
      // Storage is best effort; the in-memory selection still works.
    }
  }, [])
  const [customDraftVersion, setCustomDraftVersion] = useState(0)
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({})

  const save = async (
    revision: number,
    provider: Provider,
    key: ProviderInput | null
  ): Promise<ProviderSnapshot | null> => {
    setBusy(provider.id)
    try {
      const result = await retryOnRevisionConflict(
        (expected) => saveProviderKey(expected, provider.id, key),
        revision,
        () => loadProviders()
      )
      if (!result.error)
        setTestResults((current) => {
          const next = { ...current }
          delete next[provider.id]
          return next
        })
      if (result.error) toast.error(result.error)
      if (!result.error)
        toast.success(
          t(
            result.status === "pending"
              ? "provider.pending"
              : key === null
                ? "provider.removed"
                : key.disabled === true
                  ? "provider.closed"
                  : "provider.saved",
            { name: provider.name }
          )
        )
      return result
    } catch (error) {
      toast.error(describe(error))
      return null
    } finally {
      setBusy(null)
    }
  }

  const test = async (providerId: string) => {
    setBusy(providerId)
    try {
      const result = await testProvider(providerId)
      setTestResults((current) => ({ ...current, [providerId]: result }))
      if (result.ok) toast.success(t("provider.testSuccess", { latency: result.latencyMs ?? 0 }))
      else toast.error(`${t(`provider.testErrors.${result.code}`)}${result.message ? `: ${result.message}` : ""}`)
    } catch (error) {
      toast.error(describe(error))
    } finally {
      setBusy(null)
    }
  }

  const saveCustom = async (revision: number, input: CustomProviderInput): Promise<boolean> => {
    setBusy(input.id)
    try {
      const result = await saveCustomProvider(revision, input)
      if (result.error) toast.error(result.error)
      else {
        setTestResults((current) => {
          const next = { ...current }
          delete next[input.id]
          return next
        })
        toast.success(t(result.status === "pending" ? "provider.pending" : "provider.saved", { name: input.name }))
      }
      return !result.error
    } catch (error) {
      toast.error(describe(error))
      return false
    } finally {
      setBusy(null)
    }
  }

  const saveBuiltIn = async (
    revision: number,
    provider: Provider,
    nextModels: CustomModel[],
    reason: ModelSaveReason,
    attempt = 0
  ): Promise<CustomModel[] | null> => {
    setBusy(provider.id)
    try {
      let result: ProviderSnapshot
      try {
        result = await saveBuiltInModels(revision, provider.id, nextModels)
      } catch (error) {
        // A stale local revision can surface a false "changed in another window" conflict in a
        // single window. Refresh from the store and retry once before alarming the user.
        if (attempt === 0 && isRevisionConflict(error)) {
          const fresh = await loadProviders().catch(() => null)
          if (fresh && fresh.revision !== revision) {
            return saveBuiltIn(fresh.revision, provider, nextModels, reason, attempt + 1)
          }
        }
        toast.error(describe(error))
        return null
      }
      const models = providerBuiltInModels(result, provider.id)
      // The catalog persisted. A runtime apply error (e.g. -32602 while a session is busy) is
      // recoverable: schedule_apply retries it on the next idle boundary, so treat it as success
      // rather than a hard failure that leaves the row stuck dirty and scares the user.
      if (result.error && !isRecoverableApplyError(result.error)) {
        toast.error(result.error)
        return null
      }
      const key =
        reason === "reorder"
          ? "modelsReordered"
          : reason === "remove"
            ? "modelsRemoved"
            : reason === "add"
              ? "modelsAdded"
              : "modelsSaved"
      toast.success(t(result.status === "pending" ? "provider.pending" : `provider.${key}`, { name: provider.name }))
      return models
    } finally {
      setBusy(null)
    }
  }

  const removeCustom = async (provider: CustomProvider) => {
    if (!snapshot) return
    setBusy(provider.id)
    try {
      const result = await removeCustomProvider(snapshot.revision, provider.id)
      if (result.error) toast.error(result.error)
      else {
        setActiveId(PROVIDERS[0]?.id ?? "")
        toast.success(t(result.status === "pending" ? "provider.pending" : "provider.removed", { name: provider.name }))
      }
    } catch (error) {
      toast.error(describe(error))
    } finally {
      setBusy(null)
    }
  }

  const retry = async (): Promise<void> => {
    setBusy("retry")
    try {
      const result = await applyProvidersWhenIdle()
      if (result.error) toast.error(result.error)
      else if (result.status === "pending") toast.info(t("provider.pending"))
    } catch (error) {
      toast.error(describe(error))
    } finally {
      setBusy(null)
    }
  }

  const activeBuiltIn = PROVIDERS.find((provider) => provider.id === activeId) ?? null
  const activeCustom = snapshot?.customProviders.find((provider) => provider.id === activeId) ?? null

  useEffect(() => {
    if (!snapshot || activeId === "new" || activeBuiltIn || activeCustom) return
    // The remembered provider no longer exists (a removed custom one): fall back to the provider
    // the default model points at, and only then to the first built-in.
    const fromDefault = providerIdForModel(defaultModelSnapshot()?.model ?? null)
    const resolvable =
      fromDefault !== null &&
      (PROVIDERS.some((provider) => provider.id === fromDefault) ||
        snapshot.customProviders.some((provider) => provider.id === fromDefault))
    setActiveId(resolvable && fromDefault !== null ? fromDefault : (PROVIDERS[0]?.id ?? ""))
  }, [snapshot, activeId, activeBuiltIn, activeCustom, setActiveId])

  const configuredCount = snapshot
    ? PROVIDERS.filter((provider) => provider.native === true || keys[provider.id] !== undefined).length +
      snapshot.customProviders.length
    : 0

  return (
    <div className="flex flex-col gap-6">
      <CodexProviderSection />
      <ModelSection
        onApplied={(model) => {
          if (model === null) return
          const providerId = model.startsWith("gateway:")
            ? decodeURIComponent(model.split(":")[1] ?? "")
            : PROVIDERS.find((provider) => provider.native === true)?.id
          if (providerId !== undefined && providerId !== "") setActiveId(providerId)
        }}
      />
      <div id="provider-config">
        <SettingsCard
          title={t("provider.sourceTitle")}
          desc={t("provider.sourceDesc")}
          action={
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
              {t("provider.configuredCount", { count: configuredCount })}
            </span>
          }
        >
          {snapshot?.status === "pending" && (
            <p className="mb-3 text-sm text-muted-foreground">{t("provider.pending")}</p>
          )}
          {snapshot?.error && <p className="mb-3 text-sm text-destructive">{snapshot.error}</p>}
          {snapshot && snapshot.status !== "applied" && (
            <Button variant="outline" className="mb-3 self-start" disabled={busy !== null} onClick={() => void retry()}>
              {t("provider.applyNow")}
            </Button>
          )}
          {snapshot && (
          <>
            <ProviderTabs
              activeId={activeId}
              keys={keys}
              customProviders={snapshot.customProviders}
              onSelect={setActiveId}
              onAdd={() => setActiveId("new")}
            />
            {PROVIDERS.map((provider) => (
              // The provider card is a boxed block: keep its border off the card's bottom edge.
              <div key={provider.id} hidden={activeId !== provider.id} className="pb-3">
                <ProviderRow
                  provider={provider}
                  native={provider.native === true}
                  saved={keys[provider.id] ?? null}
                  revision={snapshot.revision}
                  busy={busy !== null}
                  models={providerRowModels(snapshot, provider, nativeModels)}
                  retired={
                    provider.native === true
                      ? retiredNativeRows(nativeModelOverrides(), nativeModels?.models ?? [])
                      : []
                  }
                  onSave={(revision, key) => save(revision, provider, key)}
                  onSaveModels={(revision, nextModels, reason) =>
                    saveBuiltIn(revision, provider, nextModels, reason)
                  }
                  testResult={testResults[provider.id]}
                  onTest={() => test(provider.id)}
                />
              </div>
            ))}
            {snapshot.customProviders.map((provider) => (
              <div key={provider.id} hidden={activeId !== provider.id} className="pb-3">
                <CustomProviderEditor
                  provider={provider}
                  revision={snapshot.revision}
                  busy={busy !== null}
                  testResult={testResults[provider.id]}
                  onTest={() => test(provider.id)}
                  onRemove={() => removeCustom(provider)}
                  onSaved={setActiveId}
                  onSave={saveCustom}
                />
              </div>
            ))}
            <div hidden={activeId !== "new"} className="pb-3">
              <CustomProviderEditor
                key={customDraftVersion}
                provider={null}
                revision={snapshot.revision}
                busy={busy !== null}
                onSaved={(id) => {
                  setCustomDraftVersion((version) => version + 1)
                  setActiveId(id)
                }}
                onSave={saveCustom}
              />
            </div>
          </>
          )}
        </SettingsCard>
      </div>
    </div>
  )
}

/**
 * Icon for a custom provider tab. Built-in providers use a drawn mark; custom ones fall back to the
 * vendor favicon, which 404s for some hosts (e.g. Xiaomi/MiMo). When the favicon fails to load we
 * swap to a drawn mark for known hosts, else the neutral server glyph — never a broken image.
 */
function CustomProviderIcon({ baseUrl }: { baseUrl: string | null }) {
  const [failed, setFailed] = useState(false)
  const drawn = useMemo(() => {
    let host = ""
    try {
      host = new URL(baseUrl ?? "").hostname
    } catch {
      host = ""
    }
    if (/xiaomi|mi\.com|mimo/i.test(host)) return <MimoLogo className="size-5 shrink-0" />
    return <ServerIcon className="size-5 shrink-0" />
  }, [baseUrl])
  const icon = faviconUrl(baseUrl)
  if (icon === null || failed) return drawn
  return (
    <img src={icon} alt="" className="size-5 shrink-0 rounded object-contain" onError={() => setFailed(true)} />
  )
}

export function ProviderTabs({
  activeId,
  keys,
  customProviders,
  onSelect,
  onAdd
}: {
  activeId: string
  keys: Record<string, ProviderKey>
  customProviders: CustomProvider[]
  onSelect: (id: string) => void
  onAdd: () => void
}) {
  const { t } = useTranslation()
  return (
    <div data-testid="provider-tabs" className="grid grid-cols-2 gap-2 pb-4 sm:grid-cols-3">
        {PROVIDERS.map((provider) => {
          // Native providers run on the Codex sign-in: they are always ready, no key needed.
          // A closed provider still has metadata (its key is kept) but is not configured.
          const configured = keys[provider.id]?.configured === true || provider.native === true
          return (
            <ProviderTab
              key={provider.id}
              id={provider.id}
              name={provider.name}
              active={activeId === provider.id}
              configured={configured}
              icon={<ProviderMark provider={provider} className="size-5 shrink-0" />}
              onClick={() => onSelect(provider.id)}
            />
          )
        })}
        {customProviders.map((provider) => {
          return (
            <ProviderTab
              key={provider.id}
              id={provider.id}
              name={provider.name}
              active={activeId === provider.id}
              configured
              icon={<CustomProviderIcon baseUrl={provider.baseUrl} />}
              onClick={() => onSelect(provider.id)}
            />
          )
        })}
        <Button
          type="button"
          variant="outline"
          aria-pressed={activeId === "new"}
          onClick={onAdd}
          className={cn("h-9 w-full justify-start gap-2 rounded-full px-4", activeId === "new" && "bg-accent")}
        >
          <PlusIcon className="size-4 shrink-0" />
          <span className="truncate">{t("provider.customButton")}</span>
        </Button>
    </div>
  )
}

function ProviderTab({
  id,
  name,
  active,
  configured,
  icon,
  onClick
}: {
  id: string
  name: string
  active: boolean
  configured: boolean
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-label={name}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        // Icon and label hug the left edge; the status dot sits on the right with its own gutter.
        // Selected reads as a raised card: white surface plus a coloured halo (cyan on light,
        // soft white on dark) defined in index.css.
        "relative h-9 w-full justify-start gap-2 rounded-full border ps-3 pe-8 text-left transition-colors",
        active ? "provider-tab-active bg-background font-medium" : "hover:border-foreground/20 hover:bg-muted/40"
      )}
    >
      {icon}
      <span className="min-w-0 truncate text-sm">{name}</span>
      <span
        data-testid={`${id}-status`}
        data-configured={configured}
        aria-hidden="true"
        className={cn(
          "absolute top-1/2 right-3 size-1.5 -translate-y-1/2 rounded-full",
          configured ? "bg-emerald-500" : "bg-muted-foreground/25"
        )}
      />
    </Button>
  )
}

/** Default-effort picker: a real dropdown fed by the model's declared effort levels, with an
 * explicit "auto" choice that inherits the level from the model family. */
/** The full ladder Codex accepts; a model offers a subset of it. */
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

function effortLevels(row: ModelRow): string[] {
  return row.reasoningLevels
    .split(",")
    .map((level) => level.trim())
    .filter((level) => level !== "")
}

function toggleEffortLevel(row: ModelRow, level: string): string[] {
  const current = effortLevels(row)
  return current.includes(level) ? current.filter((entry) => entry !== level) : [...current, level]
}

/**
 * Levels the pills offer: the fixed set plus whatever the row already stores.
 *
 * The engine can publish a level the fixed list predates — GPT-6.1 ships `ultra`, and a saved row
 * carries it — but rendering the pills from `EFFORT_LEVELS` alone left it invisible: the row had
 * `ultra`, the 默认 Effort dropdown offered it, yet no pill ever lit up for it. Deriving the list
 * from both sources keeps a late-added level reachable instead of silently unselectable.
 */
function effortChoices(row: ModelRow): string[] {
  return [...new Set([...EFFORT_LEVELS, ...effortLevels(row)])]
}

function ModelEffortSelect({
  levels,
  value,
  onChange,
  ariaLabel
}: {
  levels: string
  value: string
  onChange: (next: string) => void
  ariaLabel: string
}) {
  const { t } = useTranslation()
  const options = Array.from(
    new Set(
      levels
        .split(",")
        .map((level) => level.trim())
        .filter((level) => level !== "")
        .concat(value.trim() === "" ? [] : [value.trim()])
    )
  )
  return (
    <Select
      value={value.trim() === "" ? "auto" : value.trim()}
      onValueChange={(next) => onChange(next === "auto" || next === null ? "" : next)}
    >
      <SelectTrigger className="w-full" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">{t("provider.modelDefaultEffortAuto")}</SelectItem>
        {options.map((level) => (
          // A description inside the item would be folded into the trigger text by Radix, so the
          // wording rides on the row's tooltip instead of its label.
          <SelectItem key={level} value={level} title={t(`defaultModel.effortLevels.${level}`, { defaultValue: "" })}>
            {level}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function TestFeedback({ result }: { result: ProviderTestResult }) {
  const { t } = useTranslation()
  return (
    <p role="status" className={result.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
      {result.ok
        ? t("provider.testSuccess", { latency: result.latencyMs ?? 0 })
        : `${t(`provider.testErrors.${result.code}`)}${result.status ? ` (HTTP ${result.status})` : ""}`}
    </p>
  )
}

function ProviderActions({
  busy,
  canTest,
  onTest,
  onRemove,
  result,
  children
}: {
  busy: boolean
  canTest: boolean
  onTest?: () => void
  onRemove?: () => void
  result?: ProviderTestResult
  children?: ReactNode
}): ReactNode {
  const { t } = useTranslation()
  // Nothing to do yet (a provider with no key has no test, no remove and no save) — an empty
  // `border-t + pt-4` still painted a rule and a blank band under the model table, which read as
  // a broken card. Skip the block entirely when every slot is empty.
  const empty = result === undefined && onTest === undefined && onRemove === undefined && !children
  if (empty) return null
  return (
    <div className="space-y-3 border-t pt-4 pb-5">
      {result && <TestFeedback result={result} />}
      {onTest && <p className="text-xs leading-relaxed text-muted-foreground">{t("provider.testDescription")}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {onRemove && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={busy}
            onClick={onRemove}
          >
            {t("provider.remove")}
          </Button>
        )}
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {onTest && (
            <Button size="sm" variant="outline" disabled={busy || !canTest} onClick={onTest}>
              {t("provider.testButton")}
            </Button>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}

/** Groups discovered models by vendor family, so a long fetch reads like a model catalog. */
function modelFamily(apiId: string): string {
  const id = apiId.toLowerCase()
  if (
    id.includes("claude") ||
    id.includes("sonnet") ||
    id.includes("opus") ||
    id.includes("haiku") ||
    id.includes("fable")
  )
    return "Claude"
  if (id.includes("gemini")) return "Gemini"
  if (id.startsWith("gpt") || id.startsWith("o3") || id.startsWith("o4")) return "GPT"
  if (id.includes("deepseek")) return "DeepSeek"
  if (id.includes("qwen")) return "Qwen"
  if (id.includes("grok")) return "Grok"
  if (id.includes("kimi") || id.includes("moonshot")) return "Kimi"
  if (id.includes("glm") || id.includes("zhipu")) return "Zhipu"
  if (id.includes("minimax")) return "MiniMax"
  return "Other"
}

function modelFamilies(models: CustomModel[]): [string, CustomModel[]][] {
  const map = new Map<string, CustomModel[]>()
  for (const model of models) {
    const family = modelFamily(model.api_id)
    const list = map.get(family) ?? []
    list.push(model)
    map.set(family, list)
  }
  return [...map.entries()]
}

/** One editable row in the built-in provider's model table. */
/** Why the model list is being saved; drives the success toast wording. */
type ModelSaveReason = "save" | "reorder" | "remove" | "add"

interface ModelRow {
  key: string
  label: string
  api_id: string
  contextWindow: string
  reasoningLevels: string
  defaultReasoningLevel: string
  /** Switched off models stay saved but never reach the picker. */
  enabled: boolean
}

let modelRowSequence = 0
function newModelKey(): string {
  modelRowSequence += 1
  return `model-row-${modelRowSequence}`
}

function toModelRow(model: CustomModel): ModelRow {
  return {
    key: newModelKey(),
    label: model.label ?? "",
    api_id: model.api_id ?? "",
    contextWindow: model.contextWindow == null ? "" : String(model.contextWindow),
    reasoningLevels: (model.reasoningLevels ?? []).join(", "),
    defaultReasoningLevel: model.defaultReasoningLevel ?? "",
    enabled: model.enabled ?? true
  }
}

/** Turns the table back into the catalog shape the Rust side persists. */
function parseModelRows(
  rows: ModelRow[],
  messages: (key: string, values?: Record<string, unknown>) => string
): CustomModel[] {
  if (rows.length === 0) throw new Error(messages("provider.modelsEmpty"))
  const seen = new Set<string>()
  return rows.map((row, index) => {
    const label = row.label.trim()
    const apiId = row.api_id.trim()
    if (label === "") throw new Error(messages("provider.modelNameRequired", { row: index + 1 }))
    if (apiId === "") throw new Error(messages("provider.modelIdRequired", { row: index + 1 }))
    if (seen.has(apiId)) throw new Error(messages("provider.modelIdDuplicate", { id: apiId }))
    seen.add(apiId)
    const context = row.contextWindow.trim()
    const contextWindow = context === "" ? undefined : Number(context)
    if (contextWindow !== undefined && (!Number.isFinite(contextWindow) || contextWindow <= 0)) {
      throw new Error(messages("provider.modelContextInvalid", { row: index + 1 }))
    }
    const levels = row.reasoningLevels
      .split(",")
      .map((level) => level.trim())
      .filter((level) => level !== "")
    const fallback = row.defaultReasoningLevel.trim()
    return {
      label,
      api_id: apiId,
      ...(contextWindow === undefined ? {} : { contextWindow: Math.round(contextWindow) }),
      ...(levels.length === 0 ? {} : { reasoningLevels: levels }),
      ...(fallback === "" ? {} : { defaultReasoningLevel: fallback }),
      // The switch state must survive the save: dropping it reset every row to enabled after
      // each "Save models", which read as the user's toggles never sticking.
      ...(row.enabled ? {} : { enabled: false })
    }
  })
}

export function ProviderRow({
  provider,
  native = false,
  saved,
  revision,
  busy,
  models,
  retired = [],
  onSave,
  onSaveModels,
  testResult,
  onTest,
  onDiscover = discoverProviderModels
}: {
  provider: Provider
  /** Runs on the Codex sign-in: no connection section, no key, no per-model speed test. */
  native?: boolean
  saved: ProviderKey | null
  revision: number
  busy: boolean
  /** Effective catalog models for this built-in provider (bundled catalog merged with overrides). */
  models: CustomModel[]
  /**
   * Ids the provider no longer serves. They stay in the table — this list is what 保存模型 writes,
   * so hiding a row here would delete it the next time the user saves — but they are marked 已下架
   * and no picker offers them.
   */
  retired?: readonly string[]
  onSave: (revision: number, key: ProviderInput | null) => Promise<ProviderSnapshot | null>
  onSaveModels: (
    revision: number,
    models: CustomModel[],
    reason: ModelSaveReason
  ) => Promise<CustomModel[] | null>
  testResult?: ProviderTestResult
  onTest?: () => void
  /** Injected for tests; the real one talks to the provider through Rust. */
  onDiscover?: (input: ProviderDiscoveryInput) => Promise<CustomModel[]>
}) {
  const { t } = useTranslation()
  const retiredIds = new Set(retired)
  const defaultChoice = useSyncExternalStore(subscribeDefaultModel, defaultModelSnapshot, defaultModelSnapshot)
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [base, setBase] = useState({ saved, revision })
  const [region, setRegion] = useState(providerRegion(provider, saved?.region)?.id)
  const [baseUrl, setBaseUrl] = useState(saved?.base_url ?? "")
  const [modelRows, setModelRows] = useState<ModelRow[]>(() => models.map(toModelRow))
  const [modelBase, setModelBase] = useState({ models, revision })
  const [modelsDirty, setModelsDirty] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  // Bulk editing a catalog with hundreds of OpenRouter rows: filter first, then act on the
  // visible subset. Selection only exists in bulk mode so the drag handle and the narrow grid stay
  // exactly as they were for day-to-day editing.
  const [modelFilter, setModelFilter] = useState("")
  const [freeOnly, setFreeOnly] = useState(false)
  // The field is staged: typing must not rewrite the retry budget for every other chat mid-keystroke.
  const appliedRetryCount = useSyncExternalStore(
    subscribeOverloadRetryCount,
    overloadRetryCount,
    overloadRetryCount
  )
  const [retryCount, setRetryCount] = useState(String(appliedRetryCount))
  useEffect(() => {
    setRetryCount(String(appliedRetryCount))
  }, [appliedRetryCount])
  const parsedRetryCount = Math.round(Number(retryCount))
  const retryCountDirty =
    retryCount.trim() !== "" && Number.isFinite(parsedRetryCount) && parsedRetryCount !== appliedRetryCount
  const [freeWatch, setFreeWatch] = useBooleanSetting(FREE_MODEL_WATCH_SETTING)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set())
  // The manual 保存模型 action needs to know whether the pending edit was an add/remove, so the
  // toast says “模型已删除” instead of the old, always-wrong “已加入模型选择器”.
  const lastChange = useRef<ModelSaveReason>("save")
  // A closed provider keeps its metadata (and its key) but is not configured: the switch is off.
  const configured = saved !== null && saved.disabled !== true
  const keyTrimmed = apiKey.trim()
  const keyUrl = providerKeyUrl(provider, region)
  const regionChanged = region !== providerRegion(provider, base.saved?.region)?.id
  const baseUrlChanged = baseUrl.trim() !== (base.saved?.base_url ?? "")
  useEffect(() => {
    if (revision > base.revision && keyTrimmed === "" && !regionChanged && !baseUrlChanged) {
      setBase({ saved, revision })
      setRegion(providerRegion(provider, saved?.region)?.id)
      setBaseUrl(saved?.base_url ?? "")
    }
  }, [revision, saved, provider, base.revision, keyTrimmed, regionChanged, baseUrlChanged])
  const hasUnsaved = keyTrimmed !== "" || regionChanged || baseUrlChanged
  const canSave = !busy && hasUnsaved
  const inputId = `${provider.id}-api-key`

  // The connection state belongs next to the fields it describes. Keeping the save button at the
  // very bottom of a long card broke the causality the page asks for: syncing models needs the
  // credential to be on disk first.
  const connectionStatus = saved?.disabled === true
    ? { key: "provider.connectionClosed", tone: "bg-muted-foreground" }
    : hasUnsaved
      ? { key: "provider.connectionUnsaved", tone: "bg-amber-500" }
      : configured
        ? { key: "provider.connectionSaved", tone: "bg-emerald-500" }
        : { key: "provider.connectionMissing", tone: "bg-muted-foreground" }

  // `:free` is an OpenRouter tier. On other vendors the toggle can never match anything, so it
  // stays hidden instead of adding a dead control to every catalog.
  const showFreeFilter = provider.id === "openrouter"
  const filteredRows = useMemo(() => {
    const query = modelFilter.trim().toLowerCase()
    return modelRows.filter((row) => {
      const id = row.api_id.toLowerCase()
      if (showFreeFilter && freeOnly && !id.endsWith(":free")) return false
      if (query === "") return true
      return row.label.toLowerCase().includes(query) || id.includes(query)
    })
  }, [modelRows, modelFilter, freeOnly, showFreeFilter])
  // Reordering a filtered view would reorder hidden rows too, so the drag handle is inert while
  // a filter is active; the saved array is always what gets persisted.
  const filtering = modelFilter.trim() !== "" || (showFreeFilter && freeOnly)

  const toggleSelection = (key: string): void => {
    setSelectedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const selectAllFiltered = (): void => setSelectedKeys(new Set(filteredRows.map((row) => row.key)))
  const clearSelection = (): void => setSelectedKeys(new Set())
  const exitBulkMode = (): void => {
    setSelectionMode(false)
    clearSelection()
  }
  const bulkSetEnabled = (enabled: boolean): void => {
    if (selectedKeys.size === 0) return
    setModelRows((rows) => rows.map((row) => (selectedKeys.has(row.key) ? { ...row, enabled } : row)))
    setModelsDirty(true)
    setModelsError(null)
  }
  const bulkDelete = (): void => {
    if (selectedKeys.size === 0) return
    const next = modelRows.filter((row) => !selectedKeys.has(row.key))
    if (next.length === 0) {
      toast.error(t("provider.cannotRemoveLastModel"))
      return
    }
    lastChange.current = "remove"
    setModelRows(next)
    setModelsDirty(true)
    setModelsError(null)
    clearSelection()
    // A filtered view can be empty after the removal (e.g. deleting every `:free` row while
    // `:free only` is on). Show the surviving rows instead of a blank "no matches" panel that
    // reads as if the whole catalog had been wiped.
    setModelFilter("")
    setFreeOnly(false)
    toast.success(t("provider.bulkDeleteDone", { count: modelRows.length - next.length }))
  }
  /**
   * 反选删除: keep the checked rows, drop everything else. This is the fast path for reducing a
   * 400-row OpenRouter catalog to just its free models — filter `:free`, select all shown, then
   * delete the rest. It must act on the full saved array: deleting only visible rows would leave
   * hidden paid models behind.
   */
  const bulkDeleteInverted = (): void => {
    if (selectedKeys.size === 0 || selectedKeys.size >= modelRows.length) return
    const next = modelRows.filter((row) => selectedKeys.has(row.key))
    const removed = modelRows.length - next.length
    lastChange.current = "remove"
    setModelRows(next)
    setModelsDirty(true)
    setModelsError(null)
    clearSelection()
    // The survivors may not match the filter that was used to select them.
    setModelFilter("")
    setFreeOnly(false)
    toast.success(t("provider.bulkDeleteDone", { count: removed }))
  }

  useEffect(() => {
    if (revision <= modelBase.revision) return
    setModelBase({ models, revision })
    setModelRows(models.map(toModelRow))
    // A newer revision means a save has landed, so the table is clean again: leaving the flag
    // set kept "Save models" lit after a successful save.
    setModelsDirty(false)
  }, [revision, models, modelBase.revision])

  const editRow = (key: string, patch: Partial<ModelRow>): void => {
    lastChange.current = "save"
    setModelRows((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
    setModelsDirty(true)
    setModelsError(null)
  }

  const [syncingModels, setSyncingModels] = useState(false)
  // Native OpenAI: the model list needs an endpoint and a token, but neither is used for chat —
  // the conversation runs on the Codex sign-in. Both are kept only for `GET /models`.
  const [nativeBaseUrl, setNativeBaseUrl] = useState(
    () => readStored(OPENAI_MODELS_BASE_URL_KEY) ?? OPENAI_MODELS_URL
  )
  const [nativeToken, setNativeToken] = useState(() => readStored(OPENAI_MODELS_TOKEN_KEY) ?? "")
  const [nativeTokenVisible, setNativeTokenVisible] = useState(false)
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  // Pointer dragging (not HTML5 drag-and-drop): a WKWebView starts the drag image but never
  // delivers `drop`, which is why reordering looked like it only moved the grip icon.
  const dragPointer = useRef<{ id: number; key: string; startY: number } | null>(null)
  const dragRects = useRef<Array<{ key: string; top: number; bottom: number }>>([])
  // One acceleration switch per GPT model; conversations read the same store when they switch.
  const fastModes = useSyncExternalStore(
    subscribeModelFastMode,
    modelFastModeSnapshot,
    modelFastModeSnapshot
  )
  // The token prompt stays as the fallback when the inline field is empty, so a one-off fetch
  // never has to write to storage at all.
  const [keyPromptOpen, setKeyPromptOpen] = useState(false)
  const [promptKey, setPromptKey] = useState("")
  const [promptKeyVisible, setPromptKeyVisible] = useState(false)
  const [promptBusy, setPromptBusy] = useState(false)
  // Shown inside the dialog: a key error belongs next to the key, not in a toast that covers the
  // settings page and disappears before the reader can act on it.
  const [promptError, setPromptError] = useState<string | null>(null)

  /** Keys never contain whitespace; paste artefacts (newlines, full-width punctuation) do. */
  const pastedKey = promptKey.replace(/\s+/g, "")
  const keyFormatError =
    pastedKey !== "" && /[^\x21-\x7e]/.test(pastedKey) ? t("provider.syncKeyInvalidChars") : null

  /** Merges a `/models` answer into the table; both the inline and dialog fetches share this. */
  const applyDiscoveredModels = (found: CustomModel[]): void => {
    const merged = mergeDiscoveredModels(parseModelRows(modelRows, t), found).models
    setModelRows(merged.map(toModelRow))
    setModelsDirty(true)
    setModelsError(null)
  }

  /** No save button: the endpoint and token persist as soon as the field is committed. */
  const persistModelSource = (baseUrl: string, token: string): void => {
    writeStored(OPENAI_MODELS_BASE_URL_KEY, baseUrl)
    writeStored(OPENAI_MODELS_TOKEN_KEY, token)
    setNativeToken(token)
  }

  /** Fetches the list with the inline endpoint/token; opens the prompt when no token is set. */
  const syncNativeInline = async (): Promise<void> => {
    const token = nativeToken.replace(/\s+/g, "")
    if (token === "") {
      setKeyPromptOpen(true)
      return
    }
    const baseUrl = nativeBaseUrl.trim() || OPENAI_MODELS_URL
    setSyncingModels(true)
    try {
      const found = await onDiscover({ baseUrl, apiKey: token })
      if (found.length === 0) {
        toast.info(t("provider.syncModelsEmpty"))
        return
      }
      applyDiscoveredModels(found)
      persistModelSource(baseUrl, token)
      toast.success(t("provider.syncModelsFound", { count: found.length }))
    } catch (error) {
      console.error("[provider-discovery]", error)
      toast.error(`${t("provider.syncModelsFailed")}: ${describeError(error)}`)
    } finally {
      setSyncingModels(false)
    }
  }

  /** Lists the native provider's `/models` endpoint with a token and merges the ids in. */
  const syncNativeModels = async (): Promise<void> => {
    if (pastedKey === "" || keyFormatError !== null) return
    setPromptBusy(true)
    setPromptError(null)
    try {
      const baseUrl = nativeBaseUrl.trim() || OPENAI_MODELS_URL
      const found = await onDiscover({ baseUrl, apiKey: pastedKey })
      if (found.length === 0) {
        setPromptError(t("provider.syncModelsEmpty"))
        return
      }
      applyDiscoveredModels(found)
      persistModelSource(baseUrl, pastedKey)
      setKeyPromptOpen(false)
      setPromptKey("")
      toast.success(t("provider.syncModelsFound", { count: found.length }))
    } catch (error) {
      // The vendor's raw sentence stays in the console for support; the dialog shows the reason.
      console.error("[provider-discovery]", error)
      setPromptError(describeError(error))
    } finally {
      setPromptBusy(false)
    }
  }

  /** Fetches the models the built-in endpoint currently offers and merges them into the table. */
  const syncBuiltInModels = async (): Promise<void> => {
    if (!configured) {
      toast.info(t("provider.syncModelsKeyRequired"))
      return
    }
    setSyncingModels(true)
    try {
      const effectiveBaseUrl =
        baseUrl.trim() !== ""
          ? baseUrl.trim()
          : (providerRegion(provider, saved?.region)?.baseUrl ?? provider.baseUrl ?? "")
      if (effectiveBaseUrl === null || effectiveBaseUrl === "") {
        toast.info(t("provider.syncModelsUrlRequired"))
        return
      }
      const found = await onDiscover({ baseUrl: effectiveBaseUrl, providerId: provider.id })
      if (found.length === 0) {
        toast.info(t("provider.syncModelsEmpty"))
        return
      }
      const current = parseModelRows(modelRows, t)
      const merged = mergeDiscoveredModels(current, found).models
      setModelRows(merged.map(toModelRow))
      setModelsDirty(true)
      setModelsError(null)
      toast.success(t("provider.syncModelsFound", { count: found.length }))
    } catch (error) {
      toast.error(`${t("provider.syncModelsFailed")}: ${describeError(error)}`)
    } finally {
      setSyncingModels(false)
    }
  }

  const addRow = (): void => {
    lastChange.current = "add"
    setModelRows((rows) => [
      ...rows,
      {
        key: newModelKey(),
        label: "",
        api_id: "",
        contextWindow: "",
        reasoningLevels: "",
        defaultReasoningLevel: "",
        enabled: true
      }
    ])
    setModelsDirty(true)
    setModelsError(null)
  }

  const removeRow = (key: string): void => {
    lastChange.current = "remove"
    // 强校验：不允许把模型列表删空，至少保留一个（内置模型本就无删除按钮，这里兜住用户自定义模型）。
    if (modelRows.length <= 1) {
      toast.error(t("provider.cannotRemoveLastModel"))
      return
    }
    setModelRows((rows) => rows.filter((row) => row.key !== key))
    setModelsDirty(true)
    setModelsError(null)
  }

  /** Persists one order; a failed save keeps the rows visible and dirty for another attempt. */
  const saveRows = async (nextRows: ModelRow[], reason: ModelSaveReason = "save"): Promise<void> => {
    let parsed: CustomModel[]
    try {
      parsed = parseModelRows(nextRows, t)
      setModelsError(null)
    } catch (error) {
      setModelsError(describe(error))
      return
    }
    const savedModels = await onSaveModels(revision, parsed, reason)
    if (!savedModels) return
    setModelBase({ models: savedModels, revision })
    setModelRows(savedModels.map(toModelRow))
    setModelsDirty(false)
    lastChange.current = "save"
  }

  const submitModels = async () => {
    await saveRows(modelRows, lastChange.current)
  }

  /**
   * Moves one model row in front of another and saves immediately.
   *
   * The saved array is the order every picker reads, so a drop has to reach storage without a
   * second "保存模型" click; otherwise the chat menu keeps the old order and the drag looks broken.
   */
  const moveRow = (from: string, to: string): void => {
    if (from === to) return
    const fromIndex = modelRows.findIndex((row) => row.key === from)
    const toIndex = modelRows.findIndex((row) => row.key === to)
    if (fromIndex < 0 || toIndex < 0) return
    const next = [...modelRows]
    const [moved] = next.splice(fromIndex, 1)
    if (moved === undefined) return
    next.splice(toIndex, 0, moved)
    setModelRows(next)
    setModelsDirty(true)
    setModelsError(null)
    void saveRows(next, "reorder")
  }

  /** Captures the rows' original rects so the target is resolved even while one row follows the pointer. */
  const startPointerDrag = (event: ReactPointerEvent<HTMLElement>, key: string): void => {
    if (busy) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragPointer.current = { id: event.pointerId, key, startY: event.clientY }
    dragRects.current = [...document.querySelectorAll<HTMLElement>("[data-model-row]")]
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return { key: element.dataset.modelRow ?? "", top: rect.top, bottom: rect.bottom }
      })
      .filter((row) => row.key !== "")
    setDraggingKey(key)
    setDragOverKey(key)
    setDragOffset(0)
  }

  const movePointerDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragPointer.current
    if (drag === null || drag.id !== event.pointerId) return
    event.preventDefault()
    setDragOffset(event.clientY - drag.startY)
    const hit = dragRects.current.find((row) => event.clientY >= row.top && event.clientY <= row.bottom)
    if (hit !== undefined) setDragOverKey(hit.key)
  }

  const endPointerDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragPointer.current
    if (drag === null || drag.id !== event.pointerId) return
    dragPointer.current = null
    setDragOffset(0)
    const hit =
      dragRects.current.find((row) => event.clientY >= row.top && event.clientY <= row.bottom) ??
      // Dropping in the gap between rows still uses the last highlighted row.
      dragRects.current.find((row) => row.key === dragOverKey)
    setDraggingKey(null)
    setDragOverKey(null)
    if (hit !== undefined && hit.key !== drag.key) moveRow(drag.key, hit.key)
  }

  const persist = async (input: ProviderInput | null) => {
    const submittedKey = apiKey,
      submittedRegion = region
    const result = await onSave(base.revision, input)
    if (!result) return
    const nextSaved = result.providers[provider.id] ?? null
    setBase({ saved: nextSaved, revision: result.revision })
    setApiKey((current) => (current === submittedKey ? "" : current))
    setRegion((current) => (current === submittedRegion ? providerRegion(provider, nextSaved?.region)?.id : current))
    setBaseUrl((current) => (current === baseUrl ? (nextSaved?.base_url ?? "") : current))
  }
  /**
   * Closes a built-in provider: its models leave every picker, and nothing calls it again.
   *
   * Closing only flips the credential's `disabled` flag — the key, region and models stay on disk,
   * so re-enabling is a switch, not a re-entry. A live choice that still points at one of these
   * models blocks the close (a default session model and a 群聊 role would break silently
   * otherwise); a conversation's recorded 分工 only warns.
   */
  /** The other half of the switch: re-enable a closed provider, or collect a key if there is none. */
  const enableProvider = (): void => {
    if (configured) return
    // Closing keeps the key, so re-enabling is just flipping the flag back — no key prompt.
    if (base.saved?.disabled === true) {
      void persist({ disabled: false })
      return
    }
    // No stored key at all: a visible answer, not just a toast. The dialog that collects the key
    // opens instead, otherwise the click reads as dead.
    toast.info(t("provider.enableNeedsKey", { name: provider.name }))
    setKeyPromptOpen(true)
    const key = document.getElementById(`${provider.id}-api-key`)
    if (key instanceof HTMLInputElement) key.focus()
  }

  const closeProvider = (): void => {
    const blocker = providerCloseBlocker(provider.id)
    if (blocker !== null) {
      toast.error(
        blocker.kind === "defaultModel"
          ? t("provider.closeBlockedDefault", { name: provider.name })
          : t("provider.closeBlockedRole", { role: blocker.role })
      )
      return
    }
    const usedByChats = orchestratedSessionsUsing(provider.id)
    if (usedByChats > 0) toast.info(t("provider.closeUsedByChats", { count: usedByChats }), { duration: 8000 })
    // Close, don't erase: the key stays in the credential so re-enabling needs no re-entry.
    void persist({ disabled: true })
  }

  const submit = () => {
    if (keyTrimmed === "" && base.saved === null) return
    // A pasted curl URL is a concrete endpoint, not an API root. Save the cleaned root and echo
    // it back into the field, otherwise 保存连接 would stay lit after an otherwise good save.
    const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl)
    if (normalizedBaseUrl !== baseUrl.trim()) setBaseUrl(normalizedBaseUrl)
    void persist({
      ...(keyTrimmed === "" ? {} : { apiKey: keyTrimmed }),
      ...(region === undefined ? {} : { region }),
      ...(baseUrlChanged ? { baseUrl: normalizedBaseUrl } : {}),
      // Editing a closed provider must not switch it back on behind the user's back: only a new
      // key re-opens it, everything else keeps the flag as it was.
      ...(base.saved?.disabled === true ? { disabled: keyTrimmed !== "" } : {})
    })
  }

  return (
    <div className="space-y-5 rounded-xl border p-5">
      <div className="flex flex-wrap items-center gap-3">
        <ProviderMark provider={provider} className="size-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{provider.name}</h3>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {native
              ? t("provider.nativeActive", { count: modelRows.length })
              : configured
                ? t("provider.active", { name: provider.name, count: modelRows.length })
                : // A closed provider still holds its key, so "未配置" would send the user off to
                  // re-enter a key that is already on disk.
                  saved?.disabled === true
                  ? t("provider.closedState")
                  : t("provider.inactive")}
          </div>
        </div>
        {provider.regions && (
          <Select value={region} onValueChange={(value) => setRegion(value ?? provider.regions?.[0]?.id)}>
            <SelectTrigger className="w-32" aria-label={t("provider.region")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {provider.regions.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {t(`provider.regions.${entry.id}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
      </div>
      {!native && (
        <>
          <Separator />
          <section className="space-y-4" aria-labelledby={`${provider.id}-connection`}>
            <h4 id={`${provider.id}-connection`} className="text-sm font-medium">
              {t("provider.connectionSettings")}
            </h4>
            <Field className="gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <FieldLabel htmlFor={inputId}>{t("provider.apiKey")}</FieldLabel>
                {keyUrl !== null && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs text-muted-foreground"
                    onClick={() => void openExternal(keyUrl).catch((error: unknown) => toast.error(describe(error)))}
                  >
                    {t("provider.getKey", { name: provider.name })}
                    <ExternalLinkIcon className="size-3" aria-hidden="true" />
                  </Button>
                )}
              </div>
              <InputGroup>
                <InputGroupInput
                  id={inputId}
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  // The key survives a close, so the placeholder follows the stored credential,
                  // not the on/off state — otherwise a closed provider asks for a key it has.
                  placeholder={base.saved !== null ? t("provider.apiKeyKept") : t("provider.apiKeyPlaceholder")}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canSave) submit()
                  }}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    aria-label={t(showKey ? "provider.hideKey" : "provider.showKey")}
                    onClick={() => setShowKey((value) => !value)}
                  >
                    {showKey ? <EyeIcon /> : <EyeOffIcon />}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>
            <Collapsible className="space-y-2">
              <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group -ms-2" />}>
                {t("provider.baseUrl")}
                <ChevronDownIcon
                  className="size-4 transition-transform group-aria-expanded:rotate-180"
                  aria-hidden="true"
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <Field className="gap-2">
                  <FieldLabel htmlFor={`${provider.id}-base-url`} className="sr-only">
                    {t("provider.baseUrl")}
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id={`${provider.id}-base-url`}
                      type="url"
                      spellCheck={false}
                      placeholder={providerRegion(provider, region)?.baseUrl ?? provider.baseUrl}
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                    />
                  </InputGroup>
                  <FieldDescription className="text-xs">{t("provider.baseUrlDescription")}</FieldDescription>
                </Field>
              </CollapsibleContent>
            </Collapsible>
            {baseUrlLooksLikeEndpoint(baseUrl) && (
              <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400" role="status">
                {t("provider.baseUrlEndpointWarning")}
              </p>
            )}
            {/* Typing is not saving. Every non-native provider shares this row, so the hint lives
                here rather than in one vendor's special case. */}
            {canSave && !configured && (
              <p className="text-xs leading-relaxed text-primary" role="status">
                {t("provider.unsavedHint")}
              </p>
            )}
            {/* The save action lives with the fields it commits. At the bottom of a card holding
                hundreds of OpenRouter rows it was off-screen, so users filled the key, clicked
                「更新模型列表」 below, and only then learned the key had never been saved. */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className={cn("size-1.5 shrink-0 rounded-full", connectionStatus.tone)} aria-hidden="true" />
                <span className="text-xs text-muted-foreground" role="status">
                  {t(connectionStatus.key)}
                </span>
              </div>
              <Button size="sm" disabled={!canSave} title={t("provider.saveButtonHint")} onClick={submit}>
                {busy && <Spinner data-icon="inline-start" />}
                {t("provider.saveButton")}
              </Button>
            </div>
          </section>
        </>
      )}
      {native && (
        <>
          <Separator />
          {/* Mirrors a normal provider's connection settings: no save button, the token and
              endpoint are committed on blur, and the token is explicitly model-list-only. */}
          <section className="space-y-4" aria-labelledby={`${provider.id}-connection`}>
            <h4 id={`${provider.id}-connection`} className="text-sm font-medium">
              {t("provider.connectionSettings")}
            </h4>
            <Field className="gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <FieldLabel htmlFor={`${provider.id}-models-token`}>{t("provider.apiKey")}</FieldLabel>
                {keyUrl !== null && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs text-muted-foreground"
                    onClick={() => void openExternal(keyUrl).catch((error: unknown) => toast.error(describe(error)))}
                  >
                    {t("provider.getKey", { name: provider.name })}
                    <ExternalLinkIcon className="size-3" aria-hidden="true" />
                  </Button>
                )}
              </div>
              <InputGroup>
                <InputGroupInput
                  id={`${provider.id}-models-token`}
                  type={nativeTokenVisible ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    nativeToken.trim() === "" ? t("provider.openaiTokenPlaceholder") : t("provider.apiKeyKept")
                  }
                  value={nativeToken}
                  onChange={(event) => setNativeToken(event.target.value)}
                  onBlur={() => writeStored(OPENAI_MODELS_TOKEN_KEY, nativeToken.replace(/\s+/g, ""))}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    aria-label={t(nativeTokenVisible ? "provider.hideKey" : "provider.showKey")}
                    onClick={() => setNativeTokenVisible((value) => !value)}
                  >
                    {nativeTokenVisible ? <EyeIcon /> : <EyeOffIcon />}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              <FieldDescription className="text-xs">{t("provider.openaiTokenNote")}</FieldDescription>
            </Field>
            <Collapsible className="space-y-2">
              <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group -ms-2" />}>
                {t("provider.baseUrl")}
                <ChevronDownIcon
                  className="size-4 transition-transform group-aria-expanded:rotate-180"
                  aria-hidden="true"
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <Field className="gap-2">
                  <FieldLabel htmlFor={`${provider.id}-models-base-url`} className="sr-only">
                    {t("provider.baseUrl")}
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id={`${provider.id}-models-base-url`}
                      type="url"
                      spellCheck={false}
                      placeholder={OPENAI_MODELS_URL}
                      value={nativeBaseUrl}
                      onChange={(event) => setNativeBaseUrl(event.target.value)}
                      onBlur={() =>
                        writeStored(OPENAI_MODELS_BASE_URL_KEY, nativeBaseUrl.trim() || OPENAI_MODELS_URL)
                      }
                    />
                  </InputGroup>
                  <FieldDescription className="text-xs">{t("provider.baseUrlDescription")}</FieldDescription>
                </Field>
              </CollapsibleContent>
            </Collapsible>
            <div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t("defaultModel.overloadRetryCount")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("defaultModel.overloadRetryDescription")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    min={MIN_OVERLOAD_RETRY_COUNT}
                    max={MAX_OVERLOAD_RETRY_COUNT}
                    value={retryCount}
                    className="w-20"
                    onChange={(event) => setRetryCount(event.target.value)}
                    onBlur={() => {
                      // Clamp on the way out so an out-of-range value never sits in the box looking saved.
                      const parsed = Math.round(Number(retryCount))
                      setRetryCount(
                        Number.isFinite(parsed)
                          ? String(
                              Math.min(
                                MAX_OVERLOAD_RETRY_COUNT,
                                Math.max(MIN_OVERLOAD_RETRY_COUNT, parsed)
                              )
                            )
                          : String(appliedRetryCount)
                      )
                    }}
                    aria-label={t("defaultModel.overloadRetryCount")}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!retryCountDirty}
                    onClick={() => {
                      const parsed = Math.min(
                        MAX_OVERLOAD_RETRY_COUNT,
                        Math.max(MIN_OVERLOAD_RETRY_COUNT, Math.round(Number(retryCount)))
                      )
                      setRetryCount(String(parsed))
                      setOverloadRetryCount(parsed)
                    }}
                  >
                    {t("defaultModel.overloadRetryApply")}
                  </Button>
                </div>
              </div>
              <p className="text-[11px] leading-4 text-muted-foreground/80">
                {t("defaultModel.overloadRetryRange", {
                  min: MIN_OVERLOAD_RETRY_COUNT,
                  max: MAX_OVERLOAD_RETRY_COUNT
                })}
              </p>
            </div>
          </section>
        </>
      )}
      <Separator />
      {provider.id === "openrouter" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("provider.freeWatchTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("provider.freeWatchDesc")}</p>
          </div>
          <Switch checked={freeWatch} onCheckedChange={setFreeWatch} aria-label={t("provider.freeWatchTitle")} />
        </div>
      )}
      <section className="space-y-3 pb-2" aria-labelledby={`${provider.id}-models`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 id={`${provider.id}-models`} className="text-sm font-medium">
            {t("provider.models")}
            <span className="ms-2 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground tabular-nums">
              {modelRows.length}
            </span>
          </h4>
          {/* Wraps instead of overflowing: the row now carries four controls and used to push
              "save models" past the panel edge on a narrow settings column. */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Native (OpenAI) has no stored key of its own — it signs in through Codex — so its
                list is refreshed with a key the user pastes into a dialog. */}
            <Button
              variant="outline"
              size="sm"
              disabled={busy || syncingModels || promptBusy || (!native && !configured)}
              title={
                !native && !configured ? t("provider.saveBeforeSync") : t("provider.syncModelsDescription")
              }
              onClick={() => (native ? void syncNativeInline() : void syncBuiltInModels())}
            >
              {syncingModels || promptBusy ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon className="size-4" />
              )}
              {t("provider.syncModels")}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={addRow}>
              <PlusIcon className="size-4" />
              {t("provider.addModel")}
            </Button>
            {modelsDirty && (
              <Button size="sm" disabled={busy} onClick={() => void submitModels()}>
                {busy && <Spinner data-icon="inline-start" />}
                {t("provider.saveModels")}
              </Button>
            )}
          </div>
        </div>
        {/* A quiet, single-height toolbar. Filled pill buttons made a filter row look like a row
            of actions and squeezed the counter between them. Only OpenRouter gets the free toggle. */}
        <div className="flex flex-wrap items-center gap-2 py-1">
          <div className="relative min-w-[12rem] flex-1">
            <SearchIcon
              className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={modelFilter}
              onChange={(event) => setModelFilter(event.target.value)}
              placeholder={t("provider.filterPlaceholder")}
              aria-label={t("provider.filterPlaceholder")}
              spellCheck={false}
              className="h-8 ps-8 text-xs"
            />
          </div>
          {showFreeFilter && (
            <button
              type="button"
              aria-pressed={freeOnly}
              onClick={() => setFreeOnly((value) => !value)}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] transition-colors",
                freeOnly
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/50 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              )}
            >
              <span
                className={cn("size-1.5 rounded-full", freeOnly ? "bg-primary" : "bg-muted-foreground/60")}
                aria-hidden="true"
              />
              {t("provider.freeOnly")}
            </button>
          )}
          <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
            {t("provider.showCount", { shown: filteredRows.length, total: modelRows.length })}
          </span>
          <span className="h-4 w-px shrink-0 bg-border/50" aria-hidden="true" />
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 px-2 text-[11px]"
            aria-pressed={selectionMode}
            onClick={() => (selectionMode ? exitBulkMode() : setSelectionMode(true))}
          >
            {t(selectionMode ? "provider.bulkModeExit" : "provider.bulkMode")}
          </Button>
        </div>
        {selectionMode && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-2">
            <Button variant="ghost" size="sm" onClick={selectAllFiltered}>
              {t("provider.selectAll")}
            </Button>
            <Button variant="ghost" size="sm" disabled={selectedKeys.size === 0} onClick={clearSelection}>
              {t("provider.clearSelection")}
            </Button>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {t("provider.selectedCount", { count: selectedKeys.size })}
            </span>
            <div className="ms-auto flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={selectedKeys.size === 0}
                onClick={() => bulkSetEnabled(true)}
              >
                {t("provider.bulkEnable")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={selectedKeys.size === 0}
                onClick={() => bulkSetEnabled(false)}
              >
                {t("provider.bulkDisable")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px] text-destructive hover:text-destructive"
                disabled={selectedKeys.size === 0}
                onClick={bulkDelete}
              >
                {t("provider.bulkDelete")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px] text-destructive hover:text-destructive"
                disabled={selectedKeys.size === 0 || selectedKeys.size >= modelRows.length}
                title={t("provider.invertDeleteHint", { count: selectedKeys.size })}
                onClick={bulkDeleteInverted}
              >
                {t("provider.invertDelete")}
              </Button>
            </div>
          </div>
        )}
        {!native && !configured && (
          <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400" role="status">
            {t("provider.saveBeforeSync")}
          </p>
        )}
        {/* One switch instead of a one-way "关闭" button: turning it back on is the other half of
            the same decision. Off means nothing calls this provider until it is turned on again.
            Native providers have no credential to close — the account sign-in already decides —
            so the switch would only point at a key field that does not exist. */}
        {!native && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium">{t("provider.enableProvider")}</p>
              <p className="text-[11px] leading-4 text-muted-foreground">{t("provider.enableProviderDesc")}</p>
            </div>
            <Switch
              aria-label={t("provider.enableProvider")}
              checked={configured}
              disabled={busy}
              onCheckedChange={(next) => {
                if (next) enableProvider()
                else closeProvider()
              }}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground"><span title={t("provider.modelsDescriptionLong")}>{t("provider.modelsDescription")}</span></p>
        {/* Quiet, one line: the rows are still in the table below, they just are not offered
            anywhere until the provider serves them again. */}
        {retired.length > 0 && (
          <p className="text-xs text-muted-foreground">{t("provider.modelsRetired", { count: retired.length })}</p>
        )}
        {modelRows.length > 0 && (
          // Column labels match the row grid below. The api id sits under the name instead of
          // taking a column of its own: eight columns in a ~490px settings panel squeezed the name
          // down to "4…" and rendered 模型名称 vertically.
          <div className="hidden items-center gap-2 px-3 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[1.25rem_1rem_minmax(0,1fr)_3rem_5.5rem_2rem_2rem]">
            {/* Empty cells, not `sr-only`: an absolutely positioned header cell is removed from
                the grid flow and shifts every following label one column left. In bulk mode the
                first column becomes the "select all shown" checkbox, sharing the drag column. */}
            {selectionMode ? (
              <Checkbox
                checked={
                  filteredRows.length > 0 && filteredRows.every((row) => selectedKeys.has(row.key))
                }
                onCheckedChange={(checked) => (checked ? selectAllFiltered() : clearSelection())}
                aria-label={t("provider.selectAll")}
                className="justify-self-center"
              />
            ) : (
              <span aria-hidden="true" />
            )}
            <span aria-hidden="true" />
            <span>{t("provider.columnName")}</span>
            <span className="text-center">{t("provider.columnEnabled")}</span>
            <span>{t("provider.columnEffort")}</span>
            <span className="text-center">{t("provider.columnFast")}</span>
            <span className="text-center">{t("provider.columnDelete")}</span>
          </div>
        )}
        <div className="space-y-2">
          {filteredRows.length === 0 && modelRows.length > 0 && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground" role="status">
              {t("provider.noMatches")}
            </p>
          )}
          {filteredRows.map((row, index) => (
            <div
              key={row.key}
              data-model-row={row.key}
              style={
                draggingKey === row.key ? { transform: `translateY(${dragOffset}px)` } : undefined
              }
              className={cn(
                "rounded-lg transition-shadow",
                draggingKey === row.key && "relative z-10 opacity-70 shadow-lg",
                dragOverKey === row.key &&
                  draggingKey !== null &&
                  draggingKey !== row.key &&
                  "ring-2 ring-primary/50 ring-offset-1 ring-offset-background"
              )}
            >
            <Collapsible
              className={cn(
                "group rounded-lg border",
                row.enabled ? "" : "opacity-60",
                // The model a new chat starts on stands out from the rest of the list.
                (native ? row.api_id : gatewayModelId(provider.id, row.api_id)) === defaultChoice?.model &&
                  "border-primary/40 bg-primary/5"
              )}
            >
              {/* Collapsed: the name and the actions only. Editing fields open on demand, so a
                  provider with a dozen models stays readable instead of a wall of inputs. */}
              <div className="grid items-center gap-2 px-3 py-2 sm:grid-cols-[1.25rem_1rem_minmax(0,1fr)_3rem_5.5rem_2rem_2rem]">
                {/* The saved array is the order every picker reads; drag this handle to change it.
                    Pointer events, not HTML5 drag: WKWebView shows the drag image but never
                    delivers the drop, so the order never changed. */}
                {selectionMode ? (
                  // Bulk mode borrows the drag column: the grid keeps its seven tracks and the
                  // row does not shift by one cell when the mode is toggled.
                  <Checkbox
                    checked={selectedKeys.has(row.key)}
                    onCheckedChange={() => toggleSelection(row.key)}
                    aria-label={t("provider.selectModel", {
                      name: row.label.trim() || row.api_id.trim() || row.key
                    })}
                    className="justify-self-center"
                  />
                ) : (
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={t("provider.dragModel")}
                    aria-disabled={busy || filtering}
                    title={t("provider.dragModel")}
                    className={cn(
                      "model-drag-handle touch-none text-muted-foreground opacity-60 transition-opacity select-none group-hover:opacity-100 focus-visible:opacity-100",
                      filtering ? "cursor-not-allowed opacity-30" : "cursor-grab active:cursor-grabbing"
                    )}
                    onPointerDown={(event) => {
                      if (!filtering) startPointerDrag(event, row.key)
                    }}
                    onPointerMove={movePointerDrag}
                    onPointerUp={endPointerDrag}
                    onPointerCancel={endPointerDrag}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <GripVerticalIcon className="size-3.5" aria-hidden="true" />
                  </span>
                )}
                <CollapsibleTrigger
                  render={
                    <button
                      type="button"
                      className="col-span-2 col-start-2 flex min-w-0 items-center gap-1.5 p-0 py-0.5 text-start"
                    />
                  }
                >
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-180" />
                  {/* Name over id: one column, read top-down, so a long id never steals width
                      from the name. */}
                  <span className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 truncate text-sm leading-4">
                        {row.label.trim() || row.api_id.trim() || t("provider.modelNamePlaceholder")}
                      </span>
                      {retiredIds.has(row.api_id) && (
                        <span className="shrink-0 rounded-full border border-border bg-muted/40 px-1.5 text-[10px] leading-4 text-muted-foreground">
                          {t("provider.modelWithdrawn")}
                        </span>
                      )}
                    </span>
                    {row.api_id.trim() !== "" && (
                      <span className="min-w-0 truncate font-mono text-[10px] leading-3.5 text-muted-foreground">
                        {row.api_id}
                      </span>
                    )}
                  </span>
                </CollapsibleTrigger>
                  <Switch
                    aria-label={t("provider.modelEnabled")}
                    title={t("provider.modelEnabled")}
                    checked={row.enabled}
                    onCheckedChange={(next) => editRow(row.key, { enabled: next })}
                    className="justify-self-center"
                  />
                  {/* Default effort for this model: overrides the catalog default in new chats. */}
                  <Select
                    value={String(row.defaultReasoningLevel ?? "").trim() || "auto"}
                    onValueChange={(value: string | null) =>
                      editRow(row.key, {
                        defaultReasoningLevel: value === null || value === "auto" ? "" : value
                      })
                    }
                  >
                    <SelectTrigger
                      className="h-8 w-full text-xs"
                      aria-label={t("provider.modelDefaultEffort")}
                      title={t("provider.modelDefaultEffortHint")}
                    >
                      <SelectValue placeholder={t("provider.modelEffortAuto")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t("provider.modelEffortAuto")}</SelectItem>
                      {row.reasoningLevels
                        .split(",")
                        .map((level) => level.trim())
                        .filter((level) => level !== "")
                        .map((level) => (
                          <SelectItem key={level} value={level}>
                            {level}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  {native && row.api_id.trim() !== "" ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className={cn(
                        "shrink-0",
                        fastModes[row.api_id] === true ? "text-emerald-500" : "text-muted-foreground"
                      )}
                      aria-label={t("provider.modelFastMode")}
                      aria-pressed={fastModes[row.api_id] === true}
                      title={t("provider.modelFastModeHint")}
                      disabled={busy}
                      onClick={() => setModelFastMode(row.api_id, fastModes[row.api_id] !== true)}
                    >
                      <Zap
                        className="size-4"
                        fill={fastModes[row.api_id] === true ? "currentColor" : "none"}
                        aria-hidden="true"
                      />
                    </Button>
                  ) : (
                    // Keep the delete button in the last column and show “no acceleration”.
                    <span className="text-center text-xs text-muted-foreground">-</span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground transition-colors hover:text-destructive"
                    aria-label={t("provider.removeModel")}
                    title={t("provider.removeModel")}
                    disabled={busy}
                    onClick={() => removeRow(row.key)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
              </div>
              <CollapsibleContent className="space-y-3 border-t px-3 py-3">
                <div className="grid items-start gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">{t("provider.modelName")}</span>
                    <Input
                      value={row.label}
                      placeholder={t("provider.modelNamePlaceholder")}
                      aria-label={`${t("provider.modelName")} ${index + 1}`}
                      onChange={(event) => editRow(row.key, { label: event.target.value })}
                    />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span className="text-muted-foreground">{t("provider.modelId")}</span>
                    <Input
                      value={row.api_id}
                      spellCheck={false}
                      className="font-mono text-xs"
                      placeholder={t("provider.modelIdPlaceholder")}
                      aria-label={`${t("provider.modelId")} ${index + 1}`}
                      onChange={(event) => editRow(row.key, { api_id: event.target.value })}
                    />
                  </label>
                </div>
                {native ? (
                  // Native GPT context is owned by the engine, so the context-window field (only
                  // meaningful for custom gateway providers, per modelContextHint) is hidden here.
                  <div className="grid gap-2">
                    <span className="text-xs text-muted-foreground">{t("provider.modelEfforts")}</span>
                    {/* Effort levels are picked, not typed: a typo here silently dropped the whole
                        ladder and the picker then offered no Effort at all. */}
                    <div className="flex flex-wrap gap-1.5">
                      {effortChoices(row).map((level) => {
                        const selected = effortLevels(row).includes(level)
                        return (
                          <button
                            key={level}
                            type="button"
                            aria-pressed={selected}
                            aria-label={level}
                            className={cn(
                              "rounded-full border px-2 py-0.5 text-xs transition-colors",
                              selected
                                ? "border-transparent bg-primary text-primary-foreground"
                                : "border-border text-muted-foreground hover:text-foreground"
                            )}
                            onClick={() =>
                              editRow(row.key, { reasoningLevels: toggleEffortLevel(row, level).join(", ") })
                            }
                          >
                            {level}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                    <label className="grid gap-1 text-xs">
                      <span className="text-muted-foreground">{t("provider.modelContext")}</span>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        value={row.contextWindow}
                        placeholder={t("provider.modelContextPlaceholder")}
                        aria-label={`${t("provider.modelContext")} ${index + 1}`}
                        onChange={(event) => editRow(row.key, { contextWindow: event.target.value })}
                      />
                    </label>
                    <div className="grid gap-2">
                      <span className="text-xs text-muted-foreground">{t("provider.modelEfforts")}</span>
                      {/* Effort levels are picked, not typed: a typo here silently dropped the whole
                          ladder and the picker then offered no Effort at all. */}
                      <div className="flex flex-wrap gap-1.5">
                        {effortChoices(row).map((level) => {
                          const selected = effortLevels(row).includes(level)
                          return (
                            <button
                              key={level}
                              type="button"
                              aria-pressed={selected}
                              aria-label={level}
                              // The name alone ("xhigh", "max") says nothing about what it costs,
                              // so the same wording used by 默认模型 is available on hover.
                              title={t(`defaultModel.effortLevels.${level}`, { defaultValue: "" })}
                              className={cn(
                                "rounded-full border px-2 py-0.5 text-xs transition-colors",
                                selected
                                  ? "border-transparent bg-primary text-primary-foreground"
                                  : "border-border text-muted-foreground hover:text-foreground"
                              )}
                              onClick={() =>
                                editRow(row.key, { reasoningLevels: toggleEffortLevel(row, level).join(", ") })
                              }
                            >
                              {level}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                )}
                <label className="grid gap-1 text-xs">
                  <span className="text-muted-foreground">{t("provider.modelDefaultEffort")}</span>
                  <ModelEffortSelect
                    levels={row.reasoningLevels}
                    value={row.defaultReasoningLevel}
                    onChange={(next) => editRow(row.key, { defaultReasoningLevel: next })}
                    ariaLabel={`${t("provider.modelDefaultEffort")} ${index + 1}`}
                  />
                </label>
              </CollapsibleContent>
            </Collapsible>
            </div>
          ))}
        </div>
        {!native && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("provider.modelContextHint")}
          </p>
        )}
        {modelsError !== null && (
          <p className="text-xs text-destructive" role="alert">
            {modelsError}
          </p>
        )}
        {/* The header's 保存模型 button is the single entry point; a second pair here read as
            three competing saves (user feedback), and 取消 only re-read the same snapshot. */}
      </section>
      {/* 保存连接 now lives under 连接设置. Only test/result stay at the bottom, so a long model
          table can no longer push the save action out of view. */}
      {!native && (
        <ProviderActions
          busy={busy}
          canTest={!canSave}
          onTest={configured ? onTest : undefined}
          result={!canSave ? testResult : undefined}
        />
      )}
      <Dialog
        open={keyPromptOpen}
        onOpenChange={(next) => {
          setKeyPromptOpen(next)
          // A stale error must not greet the next attempt.
          if (!next) setPromptError(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("provider.syncModelsKeyTitle")}</DialogTitle>
            <DialogDescription>{t("provider.syncModelsKeyDescription")}</DialogDescription>
          </DialogHeader>
          <Field className="gap-2">
            <div className="flex items-center gap-1.5">
              <FieldLabel htmlFor={`${provider.id}-list-key`}>{t("provider.apiKey")}</FieldLabel>
              {/* Hover shows a toast, as asked: the key is only used for this one list call. */}
              <button
                type="button"
                aria-label={t("provider.syncModelsKeyHelpLabel")}
                className="text-muted-foreground hover:text-foreground cursor-help"
                onPointerEnter={() => toast.info(t("provider.syncModelsKeyHelp"))}
                onFocus={() => toast.info(t("provider.syncModelsKeyHelp"))}
              >
                <CircleHelpIcon className="size-3.5" aria-hidden="true" />
              </button>
            </div>
            <InputGroup>
              <InputGroupInput
                id={`${provider.id}-list-key`}
                type={promptKeyVisible ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-..."
                aria-invalid={keyFormatError !== null || promptError !== null}
                value={promptKey}
                onChange={(event) => {
                  setPromptKey(event.target.value)
                  setPromptError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && pastedKey !== "" && keyFormatError === null && !promptBusy)
                    void syncNativeModels()
                }}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  aria-label={t(promptKeyVisible ? "provider.hideKey" : "provider.showKey")}
                  onClick={() => setPromptKeyVisible((value) => !value)}
                >
                  {promptKeyVisible ? <EyeIcon /> : <EyeOffIcon />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription className="text-xs">{t("provider.syncModelsKeyFootnote")}</FieldDescription>
            {(keyFormatError ?? promptError) !== null && (
              <p className="text-xs leading-relaxed text-destructive" role="alert">
                {keyFormatError ?? promptError}
              </p>
            )}
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t("actions.cancel")}</DialogClose>
            <Button
              disabled={pastedKey === "" || keyFormatError !== null || promptBusy}
              onClick={() => void syncNativeModels()}
            >
              {promptBusy && <Spinner data-icon="inline-start" />}
              {t("provider.syncModelsFetch")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function CustomProviderEditor({
  provider,
  revision,
  busy,
  testResult,
  onTest,
  onRemove,
  onSaved,
  onSave,
  onDiscover = discoverProviderModels
}: {
  provider: CustomProvider | null
  revision: number
  busy: boolean
  testResult?: ProviderTestResult
  onTest?: () => void
  onRemove?: () => void
  onSaved: (id: string) => void
  onSave: (revision: number, input: CustomProviderInput) => Promise<boolean>
  onDiscover?: (input: ProviderDiscoveryInput) => Promise<CustomModel[]>
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(provider?.name ?? "")
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "")
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(provider === null)
  const [previewModels, setPreviewModels] = useState(provider?.models ?? [])
  const [modelsJson, setModelsJson] = useState(
    provider ? JSON.stringify(provider.models, null, 2) : NEW_PROVIDER_MODELS_JSON
  )
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [discoveryMessage, setDiscoveryMessage] = useState<string | null>(null)
  // The last fetch from the endpoint, kept beside the editor: the user picks which of its models
  // join the provider's list with + / -, instead of the fetch merging everything in at once.
  const [discovered, setDiscovered] = useState<CustomModel[]>([])
  const [syncing, setSyncing] = useState(false)
  const [id] = useState(() => provider?.id ?? `custom_${crypto.randomUUID().replaceAll("-", "")}`)
  const nameInputId = `${id}-name`
  const urlInputId = `${id}-base-url`
  const keyInputId = `${id}-api-key`
  const modelsInputId = `${id}-models`
  const dirty =
    name.trim() !== provider?.name ||
    baseUrl.trim() !== provider.baseUrl ||
    apiKey.trim() !== "" ||
    modelsJson !== JSON.stringify(provider.models, null, 2)

  // Which models the editor's JSON currently lists, so the fetched list can show + or - per model.
  // A malformed JSON lists nothing: the +/- buttons then report the parse error on click.
  const listedModels = useMemo(() => {
    try {
      return new Set(parseCustomModels(modelsJson).map((model) => model.api_id))
    } catch {
      return new Set<string>()
    }
  }, [modelsJson])

  const changeModelsOpen = (open: boolean): void => {
    if (!open) {
      try {
        setPreviewModels(parseCustomModels(modelsJson))
        setModelsError(null)
      } catch (error) {
        setModelsError(describe(error))
        return
      }
    }
    setModelsOpen(open)
  }

  const syncModels = async () => {
    const url = baseUrl.trim()
    if (url === "") {
      setDiscoveryError(t("provider.syncModelsUrlRequired"))
      setModelsOpen(true)
      return
    }
    if (provider === null && apiKey.trim() === "") {
      setDiscoveryError(t("provider.syncModelsKeyRequired"))
      return
    }
    let current: CustomModel[]
    try {
      const parsed: unknown = JSON.parse(modelsJson)
      current =
        Array.isArray(parsed) && (parsed.length === 0 || (provider === null && modelsJson === NEW_PROVIDER_MODELS_JSON))
          ? []
          : parseCustomModels(modelsJson)
    } catch (error) {
      setDiscoveryError(`${t("provider.syncModelsInvalidJson")}: ${describe(error)}`)
      setModelsOpen(true)
      return
    }
    setSyncing(true)
    setDiscoveryError(null)
    setDiscoveryMessage(null)
    try {
      const found = await onDiscover({
        baseUrl: url,
        ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
        ...(provider === null ? {} : { providerId: provider.id })
      })
      if (found.length === 0) throw new Error(t("provider.syncModelsEmpty"))
      // The fetch only reports what the endpoint offers; which of them join the list is the
      // user's call, one model at a time, through the + / - buttons below.
      setDiscovered(found)
      setModelsOpen(false)
      setModelsError(null)
      const missing = found.filter((model) => !current.some((entry) => entry.api_id === model.api_id))
      setDiscoveryMessage(
        missing.length === found.length
          ? t("provider.syncModelsFound", { count: found.length })
          : t("provider.syncModelsFoundMixed", { count: found.length, missing: missing.length })
      )
    } catch (error) {
      setDiscoveryError(`${t("provider.syncModelsFailed")}: ${describe(error)}`)
    } finally {
      setSyncing(false)
    }
  }

  /** Adds one fetched model to the list, or removes it again; the Save button persists the result. */
  const toggleDiscovered = (model: CustomModel): void => {
    let current: CustomModel[]
    try {
      current = parseCustomModels(modelsJson)
    } catch {
      setDiscoveryError(t("provider.syncModelsInvalidJson"))
      setModelsOpen(true)
      return
    }
    const listed = current.some((entry) => entry.api_id === model.api_id)
    // Adding reuses the merge rules: an already listed model keeps the fields the user filled in
    // and only gains what the endpoint reported (context window, efforts).
    const next = listed
      ? current.filter((entry) => entry.api_id !== model.api_id)
      : mergeDiscoveredModels(current, [model]).models
    setModelsJson(JSON.stringify(next, null, 2))
    setPreviewModels(next)
    setModelsError(null)
  }

  // Pointer drag, same reason the built-in table uses it: WKWebView shows an HTML5 drag image but
  // never delivers the drop. The list reorders live, so releasing just ends the gesture.
  const [dragModelId, setDragModelId] = useState<string | null>(null)
  const customListRef = useRef<HTMLDivElement>(null)
  const moveDraggedModel = (clientY: number): void => {
    if (dragModelId === null) return
    const rows = [...(customListRef.current?.children ?? [])] as HTMLElement[]
    const over = rows.findIndex((row) => clientY < row.getBoundingClientRect().bottom)
    const from = previewModels.findIndex((model) => model.api_id === dragModelId)
    if (from === -1) return
    const to = over === -1 ? previewModels.length - 1 : over
    if (to === from) return
    const next = [...previewModels]
    const [moved] = next.splice(from, 1)
    if (moved === undefined) return
    next.splice(to, 0, moved)
    setPreviewModels(next)
    setModelsJson(JSON.stringify(next, null, 2))
  }

  /** Edits one model in place and mirrors the change into the JSON the save button reads. */
  const editPreviewModel = (apiId: string, change: { enabled?: boolean; defaultReasoningLevel?: string }): void => {
    const next = previewModels.map((model) => {
      if (model.api_id !== apiId) return model
      if (change.enabled !== undefined) return { ...model, enabled: change.enabled }
      const level = change.defaultReasoningLevel ?? ""
      return { ...model, defaultReasoningLevel: level === "" ? undefined : level }
    })
    setPreviewModels(next)
    setModelsJson(JSON.stringify(next, null, 2))
    setModelsError(null)
  }

  const submit = async () => {
    let models: CustomProvider["models"]
    try {
      models = parseCustomModels(modelsJson)
      // The new-provider form starts from a placeholder row so the table is not empty. Saving is
      // the moment the reader is done with it: drop it instead of shipping "My Model / model-id"
      // as a real model the picker would offer.
      if (provider === null && models.length > 1)
        models = models.filter((model) => !(model.api_id === PLACEHOLDER_MODEL_ID && model.label === PLACEHOLDER_MODEL_LABEL))
      setModelsError(null)
    } catch (error) {
      setModelsError(describe(error))
      setModelsOpen(true)
      return
    }
    const saved = await onSave(revision, {
      id,
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      models,
      ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() })
    })
    if (saved) onSaved(id)
  }

  return (
    <div className="space-y-5 rounded-xl border p-5">
      <div className="flex items-center gap-3">
        <ServerIcon className="size-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium break-words">{provider?.name || t("provider.addCustom")}</h3>
          <div className="mt-0.5 text-xs text-muted-foreground">{t("provider.customDescription")}</div>
        </div>
        {provider && <span className="shrink-0 text-xs text-muted-foreground">{t("provider.configured")}</span>}
      </div>
      <Separator />
      <section className="space-y-4" aria-labelledby={`${id}-connection`}>
        <h4 id={`${id}-connection`} className="text-sm font-medium">
          {t("provider.connectionSettings")}
        </h4>
        <Field className="gap-2">
          <FieldLabel htmlFor={nameInputId}>{t("provider.name")}</FieldLabel>
          <Input id={nameInputId} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={urlInputId}>{t("provider.baseUrl")}</FieldLabel>
          <Input
            id={urlInputId}
            type="url"
            placeholder="https://.../v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={keyInputId}>{t("provider.apiKey")}</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id={keyInputId}
              type={showKey ? "text" : "password"}
              autoComplete="off"
              placeholder={provider ? t("provider.apiKeyKept") : t("provider.apiKeyPlaceholder")}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label={t(showKey ? "provider.hideKey" : "provider.showKey")}
                onClick={() => setShowKey((value) => !value)}
              >
                {showKey ? <EyeIcon /> : <EyeOffIcon />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
      </section>
      <Separator />
      <Collapsible open={modelsOpen} onOpenChange={changeModelsOpen} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium">{t("provider.models")}</h4>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || syncing}
              onClick={() => void syncModels()}
            >
              {syncing ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              {t("provider.syncModels")}
            </Button>
          </div>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
            {t(modelsOpen ? "provider.previewModels" : "provider.editModels")}
            <ChevronDownIcon className={cn("size-4", modelsOpen && "rotate-180")} />
          </CollapsibleTrigger>
        </div>
        <p className="text-xs text-muted-foreground">{t("provider.syncModelsDescription")}</p>
        {discoveryError && (
          <p className="text-xs text-destructive" role="alert">
            {discoveryError}
          </p>
        )}
        {discoveryMessage && (
          <p className="text-xs text-muted-foreground" role="status">
            {discoveryMessage}
          </p>
        )}
        {!modelsOpen && (
          // One table for both lists: the built-in provider's rows and these share the column
          // rhythm, the card per row, the switch, the effort dropdown and the trash. A custom
          // model edits in place and writes back to the JSON, so the two surfaces cannot drift.
          <div className="space-y-2">
            {previewModels.length > 0 && (
              <div className="hidden items-center gap-2 px-3 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[1.25rem_minmax(0,1fr)_3rem_5.5rem_2rem_2rem]">
                <span aria-hidden="true" />
                <span>{t("provider.columnName")}</span>
                <span className="text-center">{t("provider.columnEnabled")}</span>
                <span>{t("provider.columnEffort")}</span>
                <span className="text-center">{t("provider.columnFast")}</span>
                <span className="text-center">{t("provider.columnDelete")}</span>
              </div>
            )}
            <div ref={customListRef} className="space-y-2">
              {previewModels.map((model) => (
                <div
                  key={model.api_id}
                  className={cn(
                    "grid items-center gap-2 rounded-xl border px-3 py-2",
                    "sm:grid-cols-[1.25rem_minmax(0,1fr)_3rem_5.5rem_2rem_2rem]",
                    model.enabled === false && "opacity-60",
                    dragModelId === model.api_id && "opacity-70 ring-2 ring-primary/40"
                  )}
                >
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={t("provider.dragModel")}
                    title={t("provider.dragModel")}
                    className="cursor-grab touch-none text-muted-foreground opacity-60 transition-opacity select-none hover:opacity-100 active:cursor-grabbing"
                    onPointerDown={(event) => {
                      event.preventDefault()
                      event.currentTarget.setPointerCapture(event.pointerId)
                      setDragModelId(model.api_id)
                    }}
                    onPointerMove={(event) => {
                      if (dragModelId === null) return
                      moveDraggedModel(event.clientY)
                    }}
                    onPointerUp={(event) => {
                      event.currentTarget.releasePointerCapture(event.pointerId)
                      setDragModelId(null)
                    }}
                    onPointerCancel={() => setDragModelId(null)}
                  >
                    <GripVerticalIcon className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="min-w-0 truncate text-sm leading-4">{model.label}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-[10px] leading-3.5 text-muted-foreground">
                      <span className="min-w-0 truncate font-mono">{model.api_id}</span>
                      {model.contextWindow != null && (
                        <span className="shrink-0">
                          {t("provider.contextWindowBadge", { value: model.contextWindow.toLocaleString() })}
                        </span>
                      )}
                    </span>
                  </span>
                  <Switch
                    aria-label={t("provider.modelEnabled")}
                    title={t("provider.modelEnabled")}
                    checked={model.enabled !== false}
                    onCheckedChange={(next) => editPreviewModel(model.api_id, { enabled: next })}
                    className="justify-self-center"
                  />
                  <Select
                    value={model.defaultReasoningLevel ?? ""}
                    onValueChange={(value: string | null) =>
                      editPreviewModel(model.api_id, { defaultReasoningLevel: value ?? "" })
                    }
                  >
                    <SelectTrigger
                      className="h-8 w-full text-xs"
                      aria-label={t("provider.modelDefaultEffort")}
                      title={t("provider.modelDefaultEffortHint")}
                      disabled={(model.reasoningLevels ?? []).length === 0}
                    >
                      <SelectValue placeholder={t("provider.modelEffortAuto")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{t("provider.modelEffortAuto")}</SelectItem>
                      {(model.reasoningLevels ?? []).map((level) => (
                        <SelectItem key={level} value={level}>
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* Acceleration is a built-in-provider capability; keep the column so both
                      tables line up, exactly as the built-in table does for gateways. */}
                  <span className="text-center text-xs text-muted-foreground">-</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="justify-self-center text-muted-foreground transition-colors hover:text-destructive"
                    aria-label={t("provider.removeModelFromList")}
                    title={t("provider.removeModelFromList")}
                    disabled={busy || syncing}
                    onClick={() => toggleDiscovered(model)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* The fetched models sit right under the saved list, grouped by vendor family and
            collapsed to a name each: + adds one to the list above, - removes it. */}
        {discovered.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h5 className="text-xs font-medium">{t("provider.discoveredModels")}</h5>
              <span className="text-xs text-muted-foreground">{t("provider.discoveredModelsHint")}</span>
            </div>
            <div className="space-y-2">
              {modelFamilies(discovered).map(([family, models]) => (
                <Collapsible key={family} className="group rounded-lg border bg-muted/40">
                  <div className="flex items-center justify-between px-3 py-2">
                    <CollapsibleTrigger
                      render={<button type="button" className="flex items-center gap-1.5 text-xs font-medium" />}
                    >
                      <ChevronDownIcon className="size-3.5 transition-transform group-aria-expanded:rotate-180" />
                      {family}
                      <span className="text-muted-foreground">{models.length}</span>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent>
                    <ul className="divide-y border-t px-3">
                      {models.map((model) => {
                        const listed = listedModels.has(model.api_id)
                        return (
                          <li
                            key={model.api_id}
                            className={cn(
                              "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 text-sm",
                              listed && "bg-emerald-500/10"
                            )}
                          >
                            <span className="min-w-0 break-all">{model.label}</span>
                            <Button
                              variant="outline"
                              size="icon-sm"
                              aria-label={listed ? t("provider.removeModelFromList") : t("provider.addModelToList")}
                              title={listed ? t("provider.removeModelFromList") : t("provider.addModelToList")}
                              aria-pressed={listed}
                              disabled={busy || syncing}
                              onClick={() => toggleDiscovered(model)}
                            >
                              {listed ? <MinusIcon className="size-4" /> : <PlusIcon className="size-4" />}
                            </Button>
                          </li>
                        )
                      })}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </div>
        )}
        <CollapsibleContent>
          <Field className="gap-2" data-invalid={modelsError !== null}>
            <FieldLabel htmlFor={modelsInputId}>{t("provider.modelsJson")}</FieldLabel>
            <Textarea
              id={modelsInputId}
              aria-invalid={modelsError !== null}
              aria-describedby={`${modelsInputId}-description`}
              spellCheck={false}
              className="min-h-44 font-mono text-xs"
              value={modelsJson}
              onChange={(event) => {
                setModelsJson(event.target.value)
                setModelsError(null)
                setDiscoveryError(null)
                setDiscoveryMessage(null)
              }}
            />
            <FieldDescription
              id={`${modelsInputId}-description`}
              className={cn("text-xs", modelsError && "text-destructive")}
              role={modelsError ? "alert" : undefined}
            >
              {modelsError ?? t("provider.modelsJsonDescription")}
            </FieldDescription>
          </Field>
        </CollapsibleContent>
      </Collapsible>
      <ProviderActions
        busy={busy || syncing}
        canTest={!dirty}
        onTest={provider ? onTest : undefined}
        onRemove={provider ? onRemove : undefined}
        result={!dirty ? testResult : undefined}
      >
        <Button
          size="sm"
          disabled={
            busy ||
            syncing ||
            !dirty ||
            name.trim() === "" ||
            baseUrl.trim() === "" ||
            (!provider && apiKey.trim() === "")
          }
          onClick={() => void submit()}
        >
          {(busy || syncing) && <Spinner data-icon="inline-start" />}
          {t("provider.saveButton")}
        </Button>
      </ProviderActions>
    </div>
  )
}
