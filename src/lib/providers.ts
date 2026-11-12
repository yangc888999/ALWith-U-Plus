// Model providers as per-session gateways (codex-acp-v2 catalog mode): every provider with a
// saved key registers its models in every chat's model picker under its own group; a chat
// runs on that provider only while one of its models is selected. Nothing in ~/.codex changes.
// Only providers that speak the OpenAI Responses API natively are listed (Codex dropped chat
// completions); Kimi, MiniMax and Zhipu are reached through OpenRouter.

import { listen } from "@tauri-apps/api/event"
import { SparklesIcon } from "lucide-react"
import type { ComponentType, SVGProps } from "react"

import type { GatewayModel } from "@/agent/client"
import type {
  CustomInput,
  CustomModel,
  CustomModel_Serialize,
  Input,
  Metadata,
  PublicCustomProvider,
  Snapshot,
  TestResult
} from "@/bindings"
import { commands, events } from "@/bindings"
import { DeepSeekLogo } from "@/components/icons/deepseek-logo"
import { GrokLogo } from "@/components/icons/grok-logo"
import { HakimiLogo } from "@/components/icons/hakimi-logo"
import { MimoLogo } from "@/components/icons/mimo-logo"
import { OpenAILogo } from "@/components/icons/openai-logo"
import { OpenRouterLogo } from "@/components/icons/openrouter-logo"
import { QwenLogo } from "@/components/icons/qwen-logo"

import catalog from "./provider-catalog.json"
import { defaultModelChoice } from "./default-model"
import {
  ENTERPRISE_PROVIDER_PREFIX,
  enterpriseCatalog,
  isEnterpriseModel,
  projectEnterpriseProviders
} from "@/features/auth/enterprise-providers"

export type { CustomModel } from "@/bindings"
export type ProviderKey = Metadata
export type ProviderInput = Input
export type CustomProvider = PublicCustomProvider
export type CustomProviderInput = CustomInput & { id: string }
export type ProviderSnapshot = Snapshot
export type ProviderTestResult = TestResult
export type ProviderDiscoveryInput = { baseUrl: string; apiKey?: string; providerId?: string }
export type ProviderDiscoveryMerge = { models: CustomModel[]; added: number; updated: number }

export type ProviderRegion = { id: string; baseUrl: string; keyUrl: string }

/**
 * The gateway appends `/responses` (and `/models`) to the saved base URL, so the field is an API
 * root, never a concrete endpoint. Pasting the URL from a vendor's curl example — e.g.
 * `https://openrouter.ai/api/v1/chat/completions` — would produce
 * `.../chat/completions/responses` and 404 on every turn. This is provider-agnostic.
 */
const ENDPOINT_SUFFIX = /\/(?:chat\/completions|responses|completions|models|embeddings)\/?$/i

export function baseUrlLooksLikeEndpoint(raw: string): boolean {
  return ENDPOINT_SUFFIX.test(raw.trim())
}

export function normalizeProviderBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "")
  while (ENDPOINT_SUFFIX.test(url)) {
    url = url.replace(ENDPOINT_SUFFIX, "").replace(/\/+$/, "")
  }
  return url
}

export type Provider = {
  id: string
  name: string
  logo: ComponentType<SVGProps<SVGSVGElement>>
  /** Retired providers stay readable for saved credentials but never enter a picker. */
  retired?: boolean
  /** Single endpoint, or one per region (first region is the default). */
  baseUrl?: string
  regions?: ProviderRegion[]
  keyUrl?: string
  /** Catalog-supplied icon for vendors whose `/favicon.ico` is not an image. */
  favicon?: string
  models: GatewayModel[]
  /**
   * Runs on the Codex sign-in instead of an API key: no connection settings, and its model list
   * is the engine's own GPT catalog that the user may rename, trim or extend.
   */
  native?: boolean
  /** Bundled Codex model catalog (resource path) giving the thread real efforts and modalities. */
  catalog?: string
  /** Extra Codex thread-config keys for threads on this provider. */
  config?: Record<string, unknown>
}

const logos: Record<string, Provider["logo"]> = {
  deepseek: DeepSeekLogo,
  openai: OpenAILogo,
  hakimi: HakimiLogo,
  openrouter: OpenRouterLogo,
  qwen: QwenLogo,
  xai: GrokLogo,
  mimo: MimoLogo
}
/**
 * The site's own favicon, used as the icon of a provider that has no drawn mark.
 *
 * Auto-discovered endpoints all look the same otherwise; falling back to `origin/favicon.ico`
 * gives each one the badge its vendor publishes. Nothing is fetched at build time — the image is
 * just loaded in the webview, and a missing one falls back to the neutral glyph in the UI.
 */
export function faviconUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null
  try {
    const url = new URL(baseUrl.trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    return `${url.origin}/favicon.ico`
  } catch {
    return null
  }
}

// Providers without a drawn mark keep a neutral glyph: rendering `undefined` as a component
// would crash the settings row for every newly added built-in provider.
export const ALL_PROVIDERS: Provider[] = catalog.map((provider) => ({
  ...provider,
  logo: logos[provider.id] ?? SparklesIcon
}))
export const PROVIDERS = ALL_PROVIDERS.filter((provider) => !provider.retired)

/**
 * The built-in gateway selected for a new chat when no valid saved selection exists.
 *
 * Keep this on a first-party, app-bundled provider: the previous default pointed at a
 * third-party relay (`gateway:hakimi:claude-opus-5-5`), which a fresh machine usually has no
 * key for — so a brand-new chat could start on a model that cannot be served. The company no
 * longer offers DeepSeek (its credential is closed by default), so the fallback moved to the
 * bundled Qwen catalog: `resources/qwen/models.json` lists `qwen4-max-preview` first.
 * `resolveSessionModel` still falls back to `models[0]` when it is not configured.
 */
export const DEFAULT_PROVIDER_ID = "qwen"
export const DEFAULT_MODEL_ID = "qwen4-max-preview"

const REASONING_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"])

export function parseCustomModels(source: string): CustomModel[] {
  const value: unknown = JSON.parse(source)
  if (!Array.isArray(value) || value.length === 0) throw new Error("Add at least one model")
  const ids = new Set<string>()
  return value.map((item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new Error("Each model must be an object")
    const model = item as Record<string, unknown>
    const label = typeof model.label === "string" ? model.label.trim() : ""
    const apiId = typeof model.api_id === "string" ? model.api_id.trim() : ""
    if (label === "" || apiId === "") throw new Error("Model label and API ID cannot be empty")
    if (ids.has(apiId)) throw new Error("Model IDs must be unique")
    ids.add(apiId)
    if (
      model.contextWindow !== undefined &&
      model.contextWindow !== null &&
      (!Number.isSafeInteger(model.contextWindow) || (model.contextWindow as number) <= 0)
    )
      throw new Error("Model contextWindow must be a positive integer")
    if (model.description !== undefined && typeof model.description !== "string")
      throw new Error("Model description must be a string")
    let reasoningLevels: string[] | undefined
    if (model.reasoningLevels !== undefined) {
      if (!Array.isArray(model.reasoningLevels) || model.reasoningLevels.length === 0)
        throw new Error("Model reasoningLevels must be a non-empty array")
      const seen = new Set<string>()
      reasoningLevels = model.reasoningLevels.map((level: unknown) => {
        if (typeof level !== "string" || level.trim() === "")
          throw new Error("Each reasoning level must be a non-empty string")
        const normalized = level.trim().toLowerCase()
        if (!REASONING_LEVELS.has(normalized)) throw new Error(`Unknown reasoning effort: ${normalized}`)
        if (seen.has(normalized)) throw new Error(`Duplicate reasoning effort: ${normalized}`)
        seen.add(normalized)
        return normalized
      })
    }
    let defaultReasoningLevel: string | undefined
    if (model.defaultReasoningLevel !== undefined) {
      if (typeof model.defaultReasoningLevel !== "string" || model.defaultReasoningLevel.trim() === "")
        throw new Error("Model defaultReasoningLevel must be a non-empty string")
      defaultReasoningLevel = model.defaultReasoningLevel.trim().toLowerCase()
      if (!REASONING_LEVELS.has(defaultReasoningLevel))
        throw new Error(`Unknown default reasoning effort: ${defaultReasoningLevel}`)
      if (reasoningLevels && !reasoningLevels.includes(defaultReasoningLevel))
        throw new Error("defaultReasoningLevel must be one of reasoningLevels")
    }
    return {
      label,
      api_id: apiId,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow as number | null }),
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(reasoningLevels === undefined ? {} : { reasoningLevels }),
      ...(defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel })
    }
  })
}

export function providerGroups(
  snapshot: ProviderSnapshot
): Array<{ id: string; name: string; models: GatewayModel[] }> {
  return [
    // A closed provider keeps its key and metadata (disabled=true) but must leave every picker and
    // fallback: the engine catalog already drops it, so offering it here only yields rejected picks.
    ...PROVIDERS.filter((provider) => {
      const meta = snapshot.providers[provider.id]
      return meta !== undefined && meta.disabled !== true
    }).map((provider) => {
      const overridden = snapshot.builtInModels?.[provider.id]
      return {
        id: provider.id,
        name: provider.name,
        models: overridden
          ? overridden
              .filter((model) => model.enabled !== false)
              .map((model) => ({
                id: model.api_id,
                label: model.label,
                ...(model.description == null ? {} : { description: model.description })
              }))
          : provider.models
      }
    }),
    ...snapshot.customProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => ({
        id: model.api_id,
        label: model.label,
        ...(model.description == null ? {} : { description: model.description })
      }))
    })),
    // Managed providers are saved through a different path but reach the engine through the
    // same catalog. Leaving them out made a saved managed model invisible to every picker.
    ...(snapshot.managedProviders ?? []).map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => ({
        id: model.api_id,
        label: model.label,
        ...(model.description == null ? {} : { description: model.description })
      }))
    }))
  ]
}
/** Picker-only policy: keep the legacy account provider resolvable, but never offer it twice. */
export function pickerProviderGroups(snapshot: ProviderSnapshot): ReturnType<typeof providerGroups> {
  return providerGroups(snapshot).filter((provider) => provider.id !== "litellm")
}

export function gatewayModelId(providerId: string, modelId: string): string {
  // Keep persisted IDs stable; the adapter accepts only [a-z0-9-]+. Match providers.rs.
  const runtimeId = providerId.startsWith("custom_")
    ? `custom-${Array.from(new TextEncoder().encode(providerId), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    : providerId
  return `gateway:${encodeURIComponent(runtimeId)}:${encodeURIComponent(modelId)}`
}

/** Account-owned models: the ALwith account catalog (litellm) and the Finture enterprise gateway. */
export function isAccountModel(model: string | null | undefined): boolean {
  return (!!model && model.startsWith("gateway:litellm:")) || isEnterpriseModel(model)
}

/** Desktop's default selection prefers a user-configured provider; native defaults stay engine-owned. */
export function resolveSessionModel(
  model: string | null,
  snapshot: ProviderSnapshot,
  purpose: "session" | "draft" = "session"
): string | null {
  const models = providerGroups(snapshot).flatMap((group) =>
    group.models.map((entry) => gatewayModelId(group.id, entry.id))
  )
  if (model?.startsWith("gateway:finture-enterprise:")) {
    const apiId = model.slice("gateway:finture-enterprise:".length)
    const migrated = (snapshot.managedProviders ?? [])
      .filter((provider) => provider.id.startsWith(ENTERPRISE_PROVIDER_PREFIX))
      .flatMap((provider) => provider.models.map((entry) => gatewayModelId(provider.id, entry.api_id)))
      .find((candidate) => candidate.endsWith(`:${apiId}`))
    if (migrated) return migrated
  }
  if (model !== null && (!model.startsWith("gateway:") || models.includes(model))) return model
  if (isAccountModel(model) && purpose === "session")
    throw new Error("The selected ALwith account model is unavailable. Select another model before sending.")
  return models.find((entry) => entry === gatewayModelId(DEFAULT_PROVIDER_ID, DEFAULT_MODEL_ID)) ?? models[0] ?? null
}

/**
 * The user's configured default model when it still resolves against the applied catalog.
 *
 * A gateway id survives only while its provider is still configured; a native id is passed
 * through for the agent to validate. Returns null when no default is set or it went stale, so
 * the caller keeps the built-in fallback.
 */
export function defaultModelFallback(snapshot: ProviderSnapshot): string | null {
  const model = defaultModelChoice()?.model ?? null
  if (model === null) return null
  if (!model.startsWith("gateway:")) return model
  const models = providerGroups(snapshot).flatMap((group) =>
    group.models.map((entry) => gatewayModelId(group.id, entry.id))
  )
  return models.includes(model) ? model : null
}

export function providerRegion(provider: Provider, regionId: string | null | undefined): ProviderRegion | null {
  if (!provider.regions) return null
  const region = provider.regions.find((entry) => entry.id === regionId) ?? provider.regions[0]
  if (!region) throw new Error(`Provider ${provider.id} declares no regions`)
  return region
}

export function providerKeyUrl(provider: Provider, regionId: string | null | undefined): string | null {
  return providerRegion(provider, regionId)?.keyUrl ?? provider.keyUrl ?? null
}

/** Enterprise metadata joins every snapshot; relay credentials stay in native memory. */
async function withEnterpriseCatalog(snapshot: ProviderSnapshot): Promise<ProviderSnapshot> {
  return projectEnterpriseProviders(snapshot, enterpriseCatalog(await commands.enterpriseCatalog()))
}

// All reads and notifications share ordering, including across multiple mounted hooks.
let projectionRequest = 0
let subscriptionGeneration = 0
let latestRawSnapshot: ProviderSnapshot | null = null
let latestProjection: Promise<ProviderSnapshot> | null = null
const snapshotListeners = new Set<(snapshot: ProviderSnapshot) => void>()

function refreshProviderSnapshot(raw?: ProviderSnapshot | Promise<ProviderSnapshot>): Promise<ProviderSnapshot> {
  let request = ++projectionRequest
  const generation = subscriptionGeneration
  // The first await runs before either this operation or acceptedSnapshot can reference it.
  let operation!: Promise<ProviderSnapshot>
  operation = (async () => {
    let snapshot = await (raw ?? commands.providersRead())
    if (generation !== subscriptionGeneration) throw new Error("Provider snapshot subscription ended")
    const revision = Math.max(latestRawSnapshot?.revision ?? -1, cachedSnapshot?.revision ?? -1)
    if (request !== projectionRequest && snapshot.revision <= revision) return acceptedSnapshot()
    if (snapshot.revision < revision) snapshot = latestRawSnapshot ?? cachedSnapshot!
    // An older read may discover a newer native revision. Project it afresh, never reuse an
    // enterprise response obtained before a subsequent login/logout notification.
    if (request !== projectionRequest) {
      request = ++projectionRequest
      latestProjection = operation
    }
    latestRawSnapshot = snapshot
    const projected = await withEnterpriseCatalog(snapshot)
    if (generation !== subscriptionGeneration) throw new Error("Provider snapshot subscription ended")
    if (request !== projectionRequest) return acceptedSnapshot()
    setProviderSnapshot(projected)
    return projected
  })()
  function acceptedSnapshot(): ProviderSnapshot | Promise<ProviderSnapshot> {
    if (latestProjection && latestProjection !== operation) return latestProjection
    if (cachedSnapshot) return cachedSnapshot
    throw new Error("Provider snapshot was superseded")
  }
  latestProjection = operation
  return operation
}

export function loadProviders(): Promise<ProviderSnapshot> {
  return refreshProviderSnapshot()
}

/** Subscribe before reading; every consumer receives the same accepted, projected snapshot. */
export async function listenProviderSnapshots(
  listener: (snapshot: ProviderSnapshot) => void,
  onError: (error: unknown) => void
): Promise<() => void> {
  let active = true
  snapshotListeners.add(listener)
  if (cachedSnapshot) listener(cachedSnapshot)
  const refresh = (snapshot?: ProviderSnapshot) => {
    if (!active) return
    void refreshProviderSnapshot(snapshot).catch((error: unknown) => {
      if (active) onError(error)
    })
  }
  const removeListener = () => {
    active = false
    snapshotListeners.delete(listener)
    if (snapshotListeners.size === 0) {
      projectionRequest++
      subscriptionGeneration++
      latestProjection = null
    }
  }
  let stopEnterprise: (() => void) | null = null
  let stopProviders: (() => void) | null = null
  try {
    stopEnterprise = await listen("enterprise:models-changed", () => refresh()).catch(() => null)
    stopProviders = await events["providers:changed"].listen((event) => refresh(event.payload))
    refresh()
    return () => {
      removeListener()
      stopEnterprise?.()
      stopProviders?.()
    }
  } catch (error) {
    removeListener()
    stopEnterprise?.()
    throw error
  }
}
function applyProviders(): Promise<ProviderSnapshot> {
  return refreshProviderSnapshot(commands.providersApply())
}

/**
 * A module-level cache of the last known provider snapshot.
 *
 * Model resolution (`resolveModel`) runs on the hot path of every new and restored session and
 * must not trigger a write round-trip (`providersApply`). Reading the cached snapshot keeps it
 * instant; the snapshot is refreshed by `useProviders` (on the `providers:changed` event and the
 * initial `loadProviders`) and by `loadProviders` itself.
 */
let cachedSnapshot: ProviderSnapshot | null = null

/** Record the newest snapshot we have seen. Later revisions always win. */
export function setProviderSnapshot(snapshot: ProviderSnapshot): void {
  if (cachedSnapshot !== null && cachedSnapshot.revision > snapshot.revision) return
  cachedSnapshot = snapshot
  rememberNativeOverrides(snapshot.builtInModels?.["openai"] ?? null)
  for (const listener of snapshotListeners) listener(snapshot)
}

/** Synchronous, read-only view of the last applied provider catalog. */
export function getProviderSnapshot(): ProviderSnapshot | null {
  return cachedSnapshot
}

/** Changes affecting busy provider sessions remain pending in the adapter. */
function providerApplicationPending(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(error)
  return message.includes("Provider settings are pending")
}

/**
 * Apply independent provider changes immediately. Return the current snapshot when
 * affected sessions are busy; Runtime state notifications retry the remaining changes.
 */
export async function applyProvidersWhenIdle(): Promise<ProviderSnapshot> {
  try {
    return await applyProviders()
  } catch (error) {
    if (!providerApplicationPending(error)) throw error
    return loadProviders()
  }
}

export function saveProviderKey(
  revision: number,
  providerId: string,
  input: ProviderInput | null
): Promise<ProviderSnapshot> {
  return refreshProviderSnapshot(commands.providersSave({ providerId, input, expectedRevision: revision }))
}
export function saveCustomProvider(revision: number, input: CustomProviderInput): Promise<ProviderSnapshot> {
  return refreshProviderSnapshot(commands.providersSaveCustom({ input, expectedRevision: revision }))
}
export function removeCustomProvider(revision: number, providerId: string): Promise<ProviderSnapshot> {
  return refreshProviderSnapshot(commands.providersRemoveCustom({ providerId, expectedRevision: revision }))
}
export function testProvider(providerId: string): Promise<ProviderTestResult> {
  return commands.providersTest({ providerId })
}
/** One round trip against a single model: whether it answers here at all, and how fast. */
export function testProviderModel(providerId: string, model: string): Promise<ProviderTestResult> {
  return commands.providersTestModel({ providerId, model })
}
export function discoverProviderModels(input: ProviderDiscoveryInput): Promise<CustomModel[]> {
  return commands.providersDiscoverModels({ input })
}

/** Merge API-discovered models without replacing fields the user has already filled in. */
export function mergeDiscoveredModels(current: CustomModel[], discovered: CustomModel[]): ProviderDiscoveryMerge {
  const models = current.map((model) => ({ ...model }))
  let added = 0
  let updated = 0
  for (const incoming of discovered) {
    const index = models.findIndex((model) => model.api_id === incoming.api_id)
    if (index === -1) {
      models.push({ ...incoming })
      added += 1
      continue
    }
    const existing = models[index]
    if (!existing) continue
    const merged: CustomModel = { ...existing }
    let changed = false
    if (merged.contextWindow == null && incoming.contextWindow != null) {
      merged.contextWindow = incoming.contextWindow
      changed = true
    }
    if (!merged.description && incoming.description) {
      merged.description = incoming.description
      changed = true
    }
    if ((merged.reasoningLevels == null || merged.reasoningLevels.length === 0) && incoming.reasoningLevels?.length) {
      merged.reasoningLevels = [...incoming.reasoningLevels]
      changed = true
    }
    if (
      !merged.defaultReasoningLevel &&
      incoming.defaultReasoningLevel &&
      merged.reasoningLevels?.includes(incoming.defaultReasoningLevel)
    ) {
      merged.defaultReasoningLevel = incoming.defaultReasoningLevel
      changed = true
    }
    if (changed) {
      models[index] = merged
      updated += 1
    }
  }
  return { models, added, updated }
}

/** Effective models for a built-in provider: the bundled catalog merged with the user's overrides. */

/**
 * The OpenAI provider's saved model list, mirrored into localStorage.
 *
 * The chat picker renders outside React state (the model menu's `catalog` mapper), and the
 * settings window is a separate webview, so the React snapshot hook cannot serve it. The mirror
 * is refreshed whenever a providers snapshot arrives; the picker filters its native group (and
 * applies renamed labels) from it, which is how "trim or rename the GPT models" reaches chats.
 */
const NATIVE_OVERRIDES_KEY = "alwith:native-model-overrides"

export function rememberNativeOverrides(models: CustomModel[] | null): void {
  try {
    if (models === null || models.length === 0) localStorage.removeItem(NATIVE_OVERRIDES_KEY)
    else localStorage.setItem(NATIVE_OVERRIDES_KEY, JSON.stringify(models))
  } catch {
    // Storage unavailable: the picker simply keeps the engine's full list.
  }
}

export function nativeModelOverrides(): CustomModel[] | null {
  try {
    const raw = localStorage.getItem(NATIVE_OVERRIDES_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CustomModel[]) : null
  } catch {
    return null
  }
}

/**
 * The display name of a model on every surface — the one place a rename is resolved.
 *
 * A session's `configOptions` model list is written when the thread is prepared, so renaming a
 * model in 设置 → 大模型 never reaches an already-open conversation. Reading that catalogue as the
 * name left the chat picker on the old label while 设置 and fresh drafts showed the new one (the
 * picker also preferred a bundled short alias over the user's own label). The saved overrides are
 * the only source of truth for the *name*: native GPT rows live in localStorage, gateway rows in
 * the provider snapshot. The engine catalogue is a fallback, never the answer.
 *
 * Returns null when the user never named this model, so a caller can keep its own compact alias.
 */
export function displayModelLabel(apiId: string, fallback?: string | null): string | null {
  const fallbackLabel = fallback ?? null
  if (apiId.startsWith("gateway:")) {
    const rest = apiId.slice("gateway:".length)
    const separator = rest.indexOf(":")
    if (separator < 0) return fallbackLabel
    let providerId: string
    let modelId: string
    try {
      providerId = decodeURIComponent(rest.slice(0, separator))
      modelId = decodeURIComponent(rest.slice(separator + 1))
    } catch {
      return fallbackLabel
    }
    const snapshot = getProviderSnapshot()
    if (snapshot === null) return fallbackLabel
    const builtIn = snapshot.builtInModels?.[providerId] ?? []
    const custom = snapshot.customProviders.find((entry) => entry.id === providerId)?.models ?? []
    const row = [...builtIn, ...custom].find((entry) => entry.api_id === modelId)
    const label = row?.label?.trim()
    return label !== undefined && label !== "" ? label : fallbackLabel
  }
  const row = (nativeModelOverrides() ?? []).find((entry) => entry.api_id === apiId)
  const label = row?.label?.trim()
  return label !== undefined && label !== "" ? label : fallbackLabel
}

/** What a surface knows about the engine's own catalog; only the id is required. */
export type NativeCatalogEntry = {
  id: string
  label?: string | null
  efforts?: readonly string[]
  defaultEffort?: string | null
}

/** A row ready to render: the user's order and label, the catalog's effort ladder. */
export type NativeModelRow = {
  id: string
  label: string
  efforts: string[]
  defaultEffort: string | null
}

/**
 * Why a surface has no engine catalog: still waiting for the first answer, or the engine really
 * published none. `list_models` timing out (14 times on 2026-11-05) left the GPT group empty, and
 * treating that like "not loaded yet" put every saved row — including the withdrawn
 * `gpt-6.1-terra` — back into the pickers, so a chat could be pointed at a model that cannot run.
 *
 * One function for all three surfaces: 设置 → 默认模型, the chat picker and 分工.
 */
export type NativeCatalogStatus = "ready" | "pending" | "unavailable"

export function nativeCatalogStatus(
  published: readonly NativeCatalogEntry[] | null | undefined
): NativeCatalogStatus {
  if (published === undefined) return "pending"
  if (published === null || published.length === 0) return "unavailable"
  return "ready"
}

/**
 * The single answer to "which GPT models does this app offer, and what are they called?".
 *
 * Every surface that lists GPT models asks this one function: 设置 → 默认模型, the chat picker, 分工,
 * and whatever gets added next. A new surface is one call, not a fourth copy of the rule.
 *
 * It returns finished rows — id, label, effort ladder, default effort — so a caller never has to
 * re-derive a label or decide which side wins when a saved row and the catalog disagree. Each
 * caller only maps the rows into its own option shape (a `ModelEntry`, a `ChatModelOption`, a
 * `NativeModel`).
 *
 * Rules, in order:
 * 1. No saved rows → the catalog itself is the list. First run, and the settings window before the
 *    main window has published anything.
 * 2. An empty catalog with `status === "pending"` → every saved row is kept. That is a draft before
 *    `session/new` or a settings window that has not received the engine's list yet; judging against
 *    an empty list would blank the whole picker.
 * 3. An empty catalog with `status === "unavailable"` → nothing is offered. The engine failed to
 *    publish a list (its online `list_models` timed out); replaying the saved shortlist here would
 *    offer withdrawn ids as if they were live. The settings page explains why the group is empty.
 * 4. Otherwise the saved rows are the list, in the user's order, with the user's labels, minus the
 *    models this catalog does not carry. A model the provider withdraws disappears from all three
 *    surfaces at once and returns on its own when a later catalog lists it again.
 *
 * Hiding, not greying: a greyed row had to be re-checked on every menu open
 * (`session/set_config_option`, 0.1–8s, picker locked while it ran) just to learn whether it had
 * come back. The saved row is never rewritten, so a withdrawal never turns into a deletion of the
 * user's configuration — 可用模型 still shows it, marked as 已下架, and keeps it on save.
 *
 * `retired-models` is deliberately not consulted: a tombstone records a past refusal, and reading
 * it here is what made the picker and 设置 disagree in the first place.
 */
export function servedNativeRows(
  savedModels: CustomModel[] | null,
  catalog: readonly NativeCatalogEntry[],
  status: NativeCatalogStatus
): NativeModelRow[] {
  const live = new Map(catalog.map((entry) => [entry.id, entry]))
  const saved = (savedModels ?? []).filter(
    (model) => model.enabled !== false && model.api_id.trim() !== ""
  )
  // No catalog and no prospect of one right now: do not resurrect the saved shortlist. The rows
  // stay in 可用模型 (retiredNativeRows) so a save still cannot delete the user's configuration.
  if (live.size === 0 && status === "unavailable") return []
  if (saved.length === 0)
    return catalog.map((entry) => ({
      id: entry.id,
      label: entry.label ?? entry.id,
      efforts: [...(entry.efforts ?? [])],
      defaultEffort: entry.defaultEffort ?? null
    }))
  return saved
    .filter((model) => live.size === 0 || live.has(model.api_id))
    .map((model) => {
      const entry = live.get(model.api_id)
      return {
        id: model.api_id,
        label: model.label.trim() !== "" ? model.label : (entry?.label ?? model.api_id),
        efforts: model.reasoningLevels ?? [...(entry?.efforts ?? [])],
        defaultEffort: model.defaultReasoningLevel ?? entry?.defaultEffort ?? null
      }
    })
}

/**
 * Saved rows the catalog does not carry: still part of 可用模型, hidden from every picker.
 *
 * The editable table is the one place they stay visible, because that list is what gets written on
 * save — dropping a row from the screen would drop it from the user's configuration the next time
 * they press 保存模型. The table marks them 已下架 instead.
 */
export function retiredNativeRows(
  savedModels: CustomModel[] | null,
  catalog: readonly NativeCatalogEntry[]
): string[] {
  const live = new Set(catalog.map((entry) => entry.id))
  if (live.size === 0) return []
  return (savedModels ?? [])
    .filter((model) => model.enabled !== false && model.api_id.trim() !== "" && !live.has(model.api_id))
    .map((model) => model.api_id)
}

/**
 * Whether a model id is one this session's engine actually runs.
 *
 * `servedNativeRows` above already drops rows the engine stopped serving, so pickers no longer
 * need this. It remains for callers holding an id from somewhere else — a split saved before the
 * shortlist changed, a model recorded on the thread — that must know whether the engine would
 * honour it before pointing a turn at it.
 */
export function isEngineModel(engineIds: ReadonlySet<string>, id: string): boolean {
  // An empty set means the catalog has not loaded yet. Reporting "unknown" as "unsupported"
  // would flag every model during startup and, worse, auto-disable 分工 on open.
  return engineIds.size === 0 || engineIds.has(id)
}

export function providerBuiltInModels(snapshot: ProviderSnapshot, providerId: string): CustomModel[] {
  return snapshot.builtInModels?.[providerId] ?? []
}

/** Persist a built-in provider's model overrides (full replacement of its bundled model set). */
export function saveBuiltInModels(
  revision: number,
  providerId: string,
  models: CustomModel[]
): Promise<ProviderSnapshot> {
  const serialized: CustomModel_Serialize[] = models.map((model) => {
    const entry: CustomModel_Serialize = { label: model.label, api_id: model.api_id }
    if (model.contextWindow != null) entry.contextWindow = model.contextWindow
    if (model.description != null) entry.description = model.description
    if (model.reasoningLevels != null) entry.reasoningLevels = model.reasoningLevels
    if (model.defaultReasoningLevel != null) entry.defaultReasoningLevel = model.defaultReasoningLevel
    // Keep the switch state: omitting it made every persisted row read as enabled, so a
    // switched-off model came back on after each save.
    if (model.enabled != null) entry.enabled = model.enabled
    return entry
  })
  return refreshProviderSnapshot(commands.providersSaveBuiltInModels({ providerId, models: serialized, expectedRevision: revision }))
}

export const PROVIDERS_CHANGED = events["providers:changed"].name
