import { invoke, isTauri } from "@tauri-apps/api/core"
import { info } from "@tauri-apps/plugin-log"
import { toast } from "sonner"

import i18n from "@/lib/i18n"
import { modelFastModeFor } from "@/lib/model-fast-mode"

/** The per-model overrides mirrored by the settings window (`alwith:native-model-overrides`). */
function readNativeEffortOverrides(): Array<{
  api_id: string
  defaultReasoningLevel?: string | null
  enabled?: boolean
}> {
  try {
    const raw = localStorage.getItem("alwith:native-model-overrides")
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? (parsed as Array<{
          api_id: string
          defaultReasoningLevel?: string | null
          enabled?: boolean
        }>)
      : []
  } catch {
    return []
  }
}

// U's Codex client: `@nyssance/codex-acp-v2/client`'s CodexClient (which is `@alwith/api/client`'s
// SessionClient plus the adapter's `_codex/*` extensions) with what only this product does: two chat
// slots (main window and floating chat) that each hold a draft and remember a model, gateway model
// hints, project grouping of the list, and fork titles.
//
// 2026-10-27 chat-layer extraction: the engine-neutral orchestration moved to `@alwith/api/client`,
// the Codex extensions (history, skills, plugins, rate limits, file search, lineage) to the adapter.
import { isBooleanOption, isGroupedSelect, isSelectOption, type RuntimeClient, type Session, type SessionRunState, textOf } from "@alwith/api"
import {
  type ClientOptions as BaseClientOptions,
  mergeMeta,
  type NewSessionOptions,
  type PendingAction,
  type PromptOptions,
  type SessionOperation,
  type SessionRequestOptions,
  type ListSessionsOptions,
  type SessionSummary,
  type StateSetter
} from "@alwith/api/client"
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import {
  CodexClient as CodexAcpClient,
  type CodexClientState,
  type ForkOptions,
  type ForkOrigin
} from "@nyssance/codex-acp-v2/client"

import { getActivePreview } from "@/lib/active-preview"
import { getQueueSendMode } from "@/lib/chat-display-preferences"
import { pendingPlanFor, setPendingPlan, type PendingPlan } from "@/lib/pending-plan"
import { GROUP_TURN_PREFIX, groupTurnPrompt, type GroupRoundRecord, type GroupSpeechRecord, type GroupTurn } from "@/agent/group-turns"
import { announceGroupSpeaker, clearGroupControl, groupControlFor, patchGroupDiscussion, setGroupPaused, subscribeGroupControl } from "@/lib/group-runtime"
import {
  automationTitleOf,
  isAutomationSessionId,
  rememberAutomationSessionRow,
  replaceAutomationSessionRows
} from "@/lib/automation-sessions"
import { rememberGroupSessionRow, replaceGroupSessionRows } from "@/lib/group-sessions"
import { groupByDirectory } from "@/lib/groups"
import { isModelRetired, retireModel, reviveModel } from "@/lib/retired-models"
import { beginQueuedPrompt, cancelQueuedPrompt, endQueuedPrompt, QueueCancelledError } from "@/lib/queued-prompt"
import {
  type ApprovalRequestLike,
  sandboxCapability,
  sandboxGrants,
  sandboxMode,
  sandboxSettings
} from "@/lib/sandbox-preference"
import { orchestrationFor, type SessionOrchestration } from "@/lib/session-orchestration"

import { forkTitle } from "./fork-title"
import {
  hasUsableEffortCatalog,
  isNativeModel,
  nativeModelCatalog,
  NATIVE_MODEL_GROUP,
  selectedModelId
} from "./native-models"

export type { ForkOrigin, PendingAction }

export { NATIVE_MODEL_GROUP } from "./native-models"

/** A model the gateway serves; Codex cannot list them, the client says what exists. */
export type GatewayModel = { id: string; label?: string; description?: string }

/** Fires when a session's selected model is known; `isGateway` tells whose model it is. */
export type SessionModelListener = (sessionId: string, modelId: string, isGateway: boolean) => void

export type { SessionSummary } from "@alwith/api/client"

/** What the Runtime starts the agent with: the engine, plus whatever the engine table takes (env, args…). */
export type Launch = { engine: string; [key: string]: unknown }

export type ClientOptions = BaseClientOptions & {
  /** Resolve a slot selection against the host's applied provider configuration. */
  resolveModel?: (model: string | null) => Promise<string | null>
  /**
   * The effort a brand-new conversation starts on, or null for the model's own default.
   *
   * Applied once when the session is created, before the surface confirms the selection, so the
   * value is persisted with it. Existing conversations keep their own saved effort.
   */
  defaultEffort?: () => string | null
  /**
   * The model a brand-new conversation starts on, or null when the user configured none.
   *
   * Consulted only when the caller names no model. It outranks the model inherited from the
   * previous conversation in this slot, which is what makes the settings default actually win.
   */
  defaultModel?: () => string | null
  /**
   * Whether a brand-new conversation should start in GPT acceleration ("fast mode").
   *
   * Applied only when the session publishes a boolean `fast-mode` config; models without it keep
   * their normal speed, so a stored flag can never break a model that does not support it.
   */
  defaultFastMode?: () => boolean
}

export type DraftOwner = "main" | "chat"

export type AppState = CodexClientState & {
  /** Window ownership survives switching the visible conversation; never persisted. */
  sessionWindows: Record<string, DraftOwner>
  /** Only drafts created by this connection are eligible for automatic cleanup. */
  draftSessions: Record<string, DraftOwner>
}

/** `_meta.alwith.model`: open the thread on that gateway model (codex-acp-v2 catalog mode). */
function modelHint(model: string | null): Record<string, unknown> | undefined {
  return model === null ? undefined : { alwith: { model } }
}

const selectedModel = selectedModelId

/** `YYYY-MM-DD HH:mm` in local time: the stamp a group record's rounds and speeches carry. */
function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/**
 * How long a Runtime "running" entry may show no activity before the client stops believing it.
 *
 * A turn that dies with the engine (provider switch, app-server crash) leaves its entry behind;
 * a live turn reports `state_update` or activity far inside this window.
 */
const STALE_RUN_STATE_MS = 60_000

/** How often a parked model switch re-checks a settled conversation (see `parkModelSwitch`). */
const PENDING_MODEL_RETRY_MS = 2_000


/**
 * Extracts the refused id from the two shapes the layers use, or null for any other failure.
 *
 * - The ACP adapter: `Unsupported model: 'gpt-6.1-terra'` / `Unsupported model: gpt-6.1-terra`.
 * - The Runtime's catalog check, which arrives as a whole sentence carrying every model it does
 *   serve: `model offers gpt-6.1-sol, …, gateway:kimi:kimi-k3.1-pro; "gpt-6.1-terra" is not one of
 *   them`. This one used to be invisible here, so a retired row left the switch dead.
 */
function unsupportedModel(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const quoted = /Unsupported model:\s*'([^']+)'/.exec(message)
  if (quoted?.[1] !== undefined) return quoted[1]
  const listed = /is not one of them/.test(message)
    ? /["“]([^"”]+)["”]\s*is not one of them/.exec(message)
    : null
  if (listed?.[1] !== undefined) return listed[1]
  const bare = /Unsupported model:\s*(\S+)/.exec(message)
  return bare?.[1] ?? null
}

/**
 * True only for the wording the Responses API uses when it refuses a replayed history.
 *
 * A bare `invalid_request` is not a signal: every gateway words its 400s that way, so treating it
 * as a broken transcript told the reader to start a new chat whenever a vendor disliked a model id.
 */
function replayRefusal(message: string): boolean {
  return /array too long|Invalid 'input\[\d+\]\.content'|input\[\d+\]\.content/i.test(message)
}

/** Every model id the session's picker offers right now, flat across its groups. */
function modelValues(options: acp.SessionConfigOption[]): string[] {
  const option = options.find((entry) => entry.category === "model" && entry.type === "select")
  if (option === undefined || !isSelectOption(option)) return []
  return isGroupedSelect(option.options)
    ? option.options.flatMap((entry) => entry.options.map((model) => model.value))
    : option.options.map((model) => model.value)
}

/**
 * Picks a replacement for `unsupported`: same family first (`gpt-6.1-terra` → `gpt-6.1-sol`), then
 * the same group, then anything the catalog still offers. A retired id usually has a live sibling
 * that differs in one segment, and landing on a model from a whole other vendor would silently move
 * the conversation to a different price and context window.
 */
function fallbackModel(options: acp.SessionConfigOption[], unsupported: string): string | null {
  const option = options.find((entry) => entry.category === "model" && entry.type === "select")
  if (option === undefined || !isSelectOption(option)) return null
  const usable = modelValues(options).filter((value) => value !== unsupported && !isModelRetired(value))
  if (usable.length === 0) return null
  // `gateway:vendor:model` is routing, not a family: only bare ids share a `gpt-6.1-` stem.
  const stem = unsupported.includes(":") ? null : unsupported.slice(0, unsupported.lastIndexOf("-") + 1)
  if (stem !== null && stem !== "") {
    const sibling = usable.find((value) => value.startsWith(stem))
    if (sibling !== undefined) return sibling
  }
  const group = isGroupedSelect(option.options)
    ? option.options.find((entry) => entry.options.some((model) => model.value === unsupported))
    : undefined
  const inGroup = (group?.options ?? []).map((model) => model.value).find((value) => usable.includes(value))
  return inGroup ?? usable[0] ?? null
}

/** Joins the text blocks of a prompt; non-text blocks are carried by the original content. */
function promptText(content: acp.ContentBlock[]): string {
  return content
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter((text) => text !== "")
    .join("\n")
}

/** One line for the "排队中" chip: the message's first line, trimmed; null when it is all files. */
function promptSummary(content: acp.ContentBlock[]): string | null {
  const first = promptText(content).split("\n", 1)[0]?.trim() ?? ""
  if (first === "") return null
  return first.length > 32 ? `${first.slice(0, 32)}…` : first
}

/** The planner half of an orchestrated turn: frame the work, do not execute it. */
function plannerInstruction(): acp.ContentBlock {
  return {
    type: "text",
    text: "【分工模式·规划】你是规划者。只输出一份可执行的计划：目标、步骤（按顺序）、验收标准，以及给执行模型的明确指令。不要执行、不要调用任何工具、不要写代码。执行模型会按你的计划去做。不要写模型切换、身份说明、会话状态之类的元信息。"
  }
}

/**
 * The planner sometimes opens its plan with a note about the model switch itself — "模型已从 A
 * 更改为 B（新会话才会使用 B 的身份说明）". The parenthetical is noise, but the switch itself is
 * worth keeping, so the line is rewritten as "—— 模型已从 A 更改为 B ——" instead of being dropped.
 */
export function withoutModelSwitchNotes(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const zh = line.match(
        /(?:模型已从|已从)\s*(.+?)\s*更改为\s*(.+?)\s*(?:（[^）]*）|\([^)]*\))?\s*$/
      )
      if (zh !== null) return `—— 模型已从 ${zh[1]?.trim() ?? ""} 更改为 ${zh[2]?.trim() ?? ""} ——`
      const en = line.match(/(?:model\s+)?switched from\s+(.+?)\s+to\s+(.+?)\s*(?:\([^)]*\))?\s*$/i)
      if (en !== null) return `—— switched from ${en[1]?.trim() ?? ""} to ${en[2]?.trim() ?? ""} ——`
      return line
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** The worker half: a self-contained brief built from the approved plan and the original request. */
function workerInstruction(plan: PendingPlan): string {
  const trimmed = withoutModelSwitchNotes(plan.plan)
  const body = trimmed === "" ? "（规划模型没有返回计划，按用户原始请求执行。）" : trimmed
  return `【分工模式·执行】请按下面的计划直接执行并交付结果。\n\n计划：\n${body}\n\n用户原始请求：\n${plan.request}`
}

export class CodexClient extends CodexAcpClient<AppState> {
  private readonly modelListeners = new Set<SessionModelListener>()
  private readonly confirmedModelListeners = new Set<(owner: DraftOwner, model: string) => void>()
  private savedModels: Record<DraftOwner, string | null> = {
    main: null,
    chat: null
  }
  private slotModels: Record<DraftOwner, string | null> = {
    main: null,
    chat: null
  }
  private slotTargets: Record<DraftOwner, string | null> = {
    main: null,
    chat: null
  }
  private slotVersions: Record<DraftOwner, number> = { main: 0, chat: 0 }
  private readonly draftOperations = new Map<DraftOwner, Promise<unknown>>()
  /** Attached session selections, retained for forks and event-stream repair only. */
  private readonly gatewayModels = new Map<string, string>()
  /**
   * Per-session model and effort, persisted across app restarts. The agent only keeps these in
   * memory (see `savedModels`/`slotModels`), so without this a conversation relaunched after a
   * Cmd+Q falls back to the provider default instead of the model the user chose. Keyed by the
   * stable gateway session id; restored in `noteModel` once a replay brings the config back.
   */
  private readonly sessionModels = new Map<
    string,
    {
      model: string | null
      effort: string | null
      fastMode?: boolean
      /** True when the user moved this chat off the model row's own default level. */
      effortExplicit?: boolean
      /** True when the user flipped this chat's acceleration away from the model row's switch. */
      fastExplicit?: boolean
    }
  >()
  /** Sessions whose saved model/effort is being re-applied, so replays cannot stack writes. */
  private readonly restoring = new Set<string>()
  /** Sessions whose planner turn is running, so orchestration cannot recurse into itself. */
  private readonly orchestrating = new Set<string>()
  /** Sessions where a plan/execute role is picking its own model and effort pair. */
  private readonly selectingRole = new Set<string>()
  /** Live orchestration phase per session, so the status row can name the active role. A running
   *  orchestrated turn is always planner or worker, but the session's selected id is only switched
   *  part-way through, so reading it back gives the wrong role until the swap lands. */
  private readonly orchestrationPhase = new Map<string, "planner" | "worker">()
  private readonly orchestrationPhaseListeners = new Set<() => void>()
  /** Which slot asked for a configuration write, so a confirmed model lands in that slot's memory. */
  private readonly configOwners = new Map<string, DraftOwner>()
  /** Which slot is opening a session, so its replay resolves that slot's model once the replay has started. */
  private readonly openingOwners = new Map<string, DraftOwner>()
  private readonly resolveModelOption: ClientOptions["resolveModel"]
  private readonly defaultEffortOption: ClientOptions["defaultEffort"]
  private readonly defaultModelOption: ClientOptions["defaultModel"]
  private readonly defaultFastModeOption: ClientOptions["defaultFastMode"]

  constructor(openPort: () => Promise<RuntimeClient<Launch>>, options: ClientOptions) {
    const { resolveModel, defaultEffort, defaultModel, defaultFastMode, ...base } = options
    super(
      openPort,
      { info: { name: "alwith-u", version: "0.1.0" }, ...base },
      { sessionWindows: {}, draftSessions: {} }
    )
    this.resolveModelOption = resolveModel
    this.defaultEffortOption = defaultEffort
    this.defaultModelOption = defaultModel
    this.defaultFastModeOption = defaultFastMode
    this.loadSessionModels()
    this.prefillSandboxApprovals()
  }

  /**
   * Answers the sandbox's own approval requests for capabilities the user already allowed.
   *
   * The sandbox still enforces its boundary; the switches only decide whether a permission it would
   * ask for still interrupts the turn. A capability left off keeps the normal prompt, so nothing is
   * silently denied — the user still sees the request and can allow it once.
   */
  private prefillSandboxApprovals(): void {
    this.requests.onReceived((request) => {
      if (request.kind !== "permission") return
      const settings = sandboxSettings()
      if (!settings.enabled) return
      const session = this.state.sessions[request.sessionId]
      const capability = sandboxCapability(
        {
          sessionId: request.sessionId,
          params: request.params as ApprovalRequestLike["params"]
        },
        session?.cwd ?? null
      )
      if (!sandboxGrants(settings, capability)) return
      const options = request.params.options
      const option =
        options.find((entry) => entry.kind === "allow_once") ?? options.find((entry) => entry.kind === "allow_always")
      if (option === undefined) return
      this.requests.answer(request.key, {
        outcome: "selected",
        optionId: option.optionId
      })
    })
  }

  /** Loads the per-session model/effort map saved on a previous launch. */
  private loadSessionModels(): void {
    try {
      const raw = localStorage.getItem("alwith:session-models")
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<
        string,
        {
          model?: string | null
          effort?: string | null
          fastMode?: boolean
          effortExplicit?: boolean
          fastExplicit?: boolean
        }
      >
      for (const [id, value] of Object.entries(parsed)) {
        if (typeof id !== "string") continue
        this.sessionModels.set(id, {
          model: value.model ?? null,
          effort: value.effort ?? null,
          ...(typeof value.fastMode === "boolean" ? { fastMode: value.fastMode } : {}),
          // A record written before the flags existed cannot prove the user changed anything:
          // it is treated as the model row's default, which is what the row now decides.
          ...(value.effortExplicit === true ? { effortExplicit: true } : {}),
          ...(value.fastExplicit === true ? { fastExplicit: true } : {})
        })
      }
    } catch {
      // A corrupt store must not block the app; selections just start empty.
    }
  }

  /** Writes the per-session model/effort map back to disk. */
  private persistSessionModels(): void {
    try {
      const obj: Record<
        string,
        {
          model: string | null
          effort: string | null
          fastMode?: boolean
          effortExplicit?: boolean
          fastExplicit?: boolean
        }
      > = {}
      for (const [id, value] of this.sessionModels) obj[id] = value
      localStorage.setItem("alwith:session-models", JSON.stringify(obj))
    } catch {
      // Storage can be unavailable (private mode); the in-memory map still works for this launch.
    }
  }

  /** Merges a model/effort patch for one session and persists the result (only when it changed). */
  private saveSessionModel(
    id: string,
    patch: {
      model?: string | null
      effort?: string | null
      fastMode?: boolean
      effortExplicit?: boolean
      fastExplicit?: boolean
    }
  ): void {
    const current = this.sessionModels.get(id) ?? { model: null, effort: null }
    const next = { ...current, ...patch }
    if (
      next.model === current.model &&
      next.effort === current.effort &&
      next.fastMode === current.fastMode &&
      next.effortExplicit === current.effortExplicit &&
      next.fastExplicit === current.fastExplicit
    )
      return
    this.sessionModels.set(id, next)
    this.persistSessionModels()
  }

  /**
   * The config id the agent exposes for reasoning effort.
   *
   * Codex names it `reasoning_effort`; a client that writes the id the composer shows (`effort`)
   * gets "session offers no config option effort" and the pin is silently lost, which is why a
   * pinned level never reached the model. Prefer the exact id, fall back to the effort category.
   */
  private effortConfigId(options: acp.SessionConfigOption[]): string | null {
    const exact = options.find((entry) => entry.configId === "effort" || entry.configId === "reasoning_effort")
    if (exact !== undefined) return exact.configId
    return options.find((entry) => entry.category === "thought_level")?.configId ?? null
  }

  /** The session's current reasoning effort, for surfaces that only display it. */
  effortOf(id: string): string | null {
    const session = this.holds(id) ? this.session(id) : undefined
    return session === undefined ? null : this.selectedEffort(session.configOptions)
  }


  /**
   * The selected model's default effort: the user's per-model override first, then the catalog's
   * own default from the picker metadata.
   *
   * Overrides are read from the same localStorage mirror the settings window writes
   * (`alwith:native-model-overrides`), because native providers (OpenAI) have no bundled catalog
   * for the Rust side to rewrite — the only place their default effort can come from is here.
   * `_meta.alwith.defaultReasoningEffort` remains the fallback (it is the catalog's
   * `default_reasoning_level` for gateway models).
   */
  private modelDefaultEffort(id: string): string | null {
    const session = this.holds(id) ? this.session(id) : undefined
    if (session === undefined) return null
    const option = session.configOptions.find((entry) => entry.category === "model" && entry.type === "select")
    if (option === undefined || !isSelectOption(option)) return null
    const current = typeof option.currentValue === "string" ? option.currentValue : null
    if (current === null) return null
    return this.defaultEffortForModel(session, current)
  }

  /** The default effort one specific model publishes, whether or not the chat is on it yet. */
  private defaultEffortForModel(session: Session, model: string): string | null {
    // Per-model override wins (settings -> model row -> default effort).
    const overridden = readNativeEffortOverrides().find((entry) => entry.api_id === model && entry.enabled !== false)
    const fromOverride = overridden?.defaultReasoningLevel
    if (typeof fromOverride === "string" && fromOverride !== "") return fromOverride
    const option = session.configOptions.find((entry) => entry.category === "model" && entry.type === "select")
    if (option === undefined || !isSelectOption(option)) return null
    const choices = isGroupedSelect(option.options) ? option.options.flatMap((group) => group.options) : option.options
    const choice = choices.find((entry) => entry.value === model)
    const meta = choice?._meta as { alwith?: { defaultReasoningEffort?: string } } | null | undefined
    const value = meta?.alwith?.defaultReasoningEffort
    return typeof value === "string" && value !== "" ? value : null
  }

  /**
   * Puts a just-switched chat on the new model's own default effort.
   *
   * Settings → 大模型 → 可用模型 stores one default level per model, but it only reached a
   * conversation when that conversation was created, so switching models mid-chat kept the level
   * the previous model ran on (usually Max). The level is only written when the new model really
   * publishes it: an invented effort would be rejected and lose the pin instead.
   */
  private async applyEffortForModel(id: string, model: string): Promise<void> {
    if (!this.holds(id)) return
    // Internal selections carry their own effort: a restored chat replays its saved level, and an
    // orchestration role resolves one against the new model a line later. Writing a default under
    // them would either win the race or waste an agent round trip.
    if (this.restoring.has(id) || this.selectingRole.has(id)) return
    // The config options that describe the new model arrive with the same response; one turn of
    // the event loop lets that patch reach the store before the ladder is read.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (!this.holds(id)) return
    const session = this.session(id)
    const effort = this.defaultEffortForModel(session, model)
    if (effort === null) return
    if (this.selectedEffort(session.configOptions) === effort) return
    const supported = this.supportedEfforts(id)
    if (supported === null || !supported.includes(effort)) return
    try {
      await this.setConfig(id, "effort", effort)
    } catch {
      // A rejected level must not cost the model switch; the model keeps its own default.
    }
  }

  /**
   * Applies the model's saved acceleration switch after a model change.
   *
   * 设置 → 大模型 → 可用模型 stores one fast-mode preference per GPT model; switching a chat to
   * that model must honour it. Orchestration roles write their own value right after the switch,
   * so they are skipped here to avoid two competing writes.
   */
  private async applyModelFastMode(id: string, model: string): Promise<void> {
    if (this.selectingRole.has(id)) return
    if (!this.holds(id)) return
    const desired = modelFastModeFor(model)
    const session = this.session(id)
  const option = session.configOptions.find((entry) => entry.configId === "fast-mode")
  // No fast-mode option in this session. That is ambiguous — the model may be non-GPT (never
  // capable of acceleration), or a GPT model whose config options have not arrived yet, or a role
  // that never exposes the switch. Wiping the saved preference here deletes a GPT model's enabled
  // flag on a transient gap and it would never be re-applied. Leave the preference untouched.
  if (option === undefined || !isBooleanOption(option)) return
    if (option.currentValue === desired) return
    try {
      await this.setConfig(id, "fast-mode", desired)
    } catch {
      // A model that refuses the flag keeps its own speed; the model switch already succeeded.
    }
  }

  /**
   * Applies a scheduled run's saved effort and acceleration.
   *
   * A task stores one level per model, but that model can be re-pointed in 设置 afterwards, or the
   * provider can stop publishing a level. Writing an unsupported one makes the agent reject the
   * write and the run fails as "unknown config option" even though the model itself is fine.
   * Everything else here treats both as best-effort (`applyEffortForModel`, `applyModelFastMode`),
   * so a task does too: a scheduled job must not die because a preference stopped applying.
   */
  async applyRunOverrides(id: string, effort: string, fastMode: boolean): Promise<void> {
    if (!this.holds(id)) return
    // The config options describing the *new* model arrive with the same response that carried the
    // switch; one turn of the event loop lets that patch reach the store. Reading the ladder before
    // it lands judges the new model by the old model's levels — one is dropped that exists, or one
    // is sent that does not.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (!this.holds(id)) return
    if (effort !== "") {
      const supported = this.supportedEfforts(id)
      // `null` = the catalog publishes no ladder for this model; let the engine judge.
      if (supported === null || supported.includes(effort)) {
        try {
          await this.setConfig(id, "effort", effort)
        } catch (error) {
          void info(`[automation] effort ${effort} rejected for ${id}: ${String(error).slice(0, 200)}`)
        }
      } else {
        void info(`[automation] effort ${effort} is not served by this model; keeping its default`)
      }
    }
    if (!fastMode) return
    const option = this.session(id).configOptions.find((entry) => entry.configId === "fast-mode")
    // A non-GPT model has no such option: the task simply runs at normal speed.
    if (option === undefined || !isBooleanOption(option) || option.currentValue === true) return
    try {
      await this.setConfig(id, "fast-mode", true)
    } catch (error) {
      void info(`[automation] fast mode rejected for ${id}: ${String(error).slice(0, 200)}`)
    }
  }

  /** Reads the session's selected effort, if the agent exposes one. */
  private selectedEffort(options: acp.SessionConfigOption[]): string | null {
    const id = this.effortConfigId(options)
    if (id === null) return null
    const option = options.find((entry) => entry.configId === id)
    return option && isSelectOption(option) && typeof option.currentValue === "string" ? option.currentValue : null
  }

  /**
   * Model/effort parked for the next conversation when the context is cleared.
   *
   * "Clear context" drops the session, but it must not drop what the user had dialled in —
   * otherwise the next chat silently falls back to the provider default and the effort has to be
   * picked again. The pair is parked here and applied to the draft and its first turn.
   */
  private inherited: { model: string | null; effort: string | null } | null = null

  /** Parks a model/effort pair for the next conversation. */
  rememberForNextChat(model: string | null, effort: string | null): void {
    this.inherited = { model, effort }
  }

  /** Consumes the parked pair; null when nothing is being carried over. */
  takeInherited(): { model: string | null; effort: string | null } | null {
    const value = this.inherited
    this.inherited = null
    return value
  }

  /** Parks whatever the conversation is currently on, so the next chat starts from it. */
  rememberCurrentForNextChat(id: string): void {
    const session = this.holds(id) ? this.session(id) : undefined
    if (session === undefined) return
    this.rememberForNextChat(selectedModel(session.configOptions), this.selectedEffort(session.configOptions))
  }

  private setApp(partial: StateSetter<AppState>): void {
    this.store.setState(partial)
  }

  // ── List by project ──

  /** Project views share the complete in-memory list with the sidebar. */
  async listProjectSessions(cwd: string): Promise<SessionSummary[]> {
    await this.listSessions()
    const project = this.projectPath(cwd)
    return this.state.sessionList.filter((item) => item.cwd === project)
  }

  // ── Group conversations live in the 群聊 panel, not under 项目 ──

  /**
   * A group's conversations are conversations of a *group*, not of a project the user picked.
   * The sidebar list reads `state.sessionList` directly, so the row is diverted here instead of
   * being rendered and hidden later: it lands in the group panel's own small store.
   *
   * Scheduled `codex exec` runs take the same road: their thread title is the first line of the
   * prompt file (`# 提额监控表盘每日更新任务`), and one row per run would bury the project's real
   * conversations. They get their own collapsible section instead.
   */
  private divertSessionRow(summary: SessionSummary): boolean {
    if (groupByDirectory(summary.cwd) !== null) {
      rememberGroupSessionRow(summary)
      return true
    }
    if (automationTitleOf(summary.title) !== null || isAutomationSessionId(summary.sessionId)) {
      rememberAutomationSessionRow(summary)
      return true
    }
    return false
  }

  override includeSession(summary: SessionSummary): void {
    if (this.divertSessionRow(summary)) return
    super.includeSession(summary)
  }

  protected override listSession(summary: SessionSummary): void {
    if (this.divertSessionRow(summary)) return
    super.listSession(summary)
  }

  override listSessions(options?: ListSessionsOptions): Promise<void> {
    // Concurrent callers get the same promise back (the base dedupes its own request, and callers
    // that compare promises rely on it); the group/automation split rides along once, after the
    // list lands.
    if (this.listSplit === null)
      this.listSplit = super
        .listSessions(options)
        .then(() => this.splitSessionRows())
        .finally(() => {
          this.listSplit = null
        })
    return this.listSplit
  }

  private listSplit: Promise<void> | null = null

  private splitSessionRows(): void {
    const rows = this.state.sessionList
    // A scheduled run is recognised either by its `codex exec` heading or by the id the scheduler
    // recorded when it created the session — a task's first prompt has no heading.
    const isAutomation = (row: SessionSummary): boolean =>
      automationTitleOf(row.title) !== null || isAutomationSessionId(row.sessionId)
    const groupRows = rows.filter((row) => groupByDirectory(row.cwd) !== null)
    const automationRows = rows.filter(
      (row) => groupByDirectory(row.cwd) === null && isAutomation(row)
    )
    const kept = rows.filter((row) => groupByDirectory(row.cwd) === null && !isAutomation(row))
    if (groupRows.length === 0 && automationRows.length === 0) return
    if (groupRows.length > 0) replaceGroupSessionRows(groupRows)
    if (automationRows.length > 0) replaceAutomationSessionRows(automationRows)
    if (kept.length !== rows.length) this.patch({ sessionList: kept })
  }

  // ── Slots: create, open, configure ──

  /** `newSession(cwd, model, owner)` creates a listed chat in a slot; the options form is the base client's. */
  override async newSession(
    cwd: string,
    model: string | null | NewSessionOptions = null,
    owner: DraftOwner = "main"
  ): Promise<string> {
    if (model !== null && typeof model === "object") return super.newSession(cwd, model)
    const version = ++this.slotVersions[owner]
    const id = await this.createNativeSession(cwd, model, null)
    this.activateSlot(owner, id, version)
    return id
  }

  private async createNativeSession(cwd: string, model: string | null, owner: DraftOwner | null): Promise<string> {
    // No project chosen: the session must live in the quick-chat folder. An empty cwd made codex
    // fall back to process.cwd() (inside the app bundle), so the conversation was filed under a
    // bogus "project" and looked lost in the sidebar.
    let directory = cwd
    if (directory.trim() === "" && isTauri()) {
      directory = await invoke<string>("quick_chat_directory").catch(() => cwd)
    }
    const id = await super.newSession(directory, {
      draft: owner !== null,
      meta: mergeMeta(
        modelHint(model),
        { codex: { mode: sandboxMode() } },
        owner === null ? undefined : { alwith: { draft: true } }
      )
    })
    if (owner !== null)
      this.setApp((state) => ({
        draftSessions: { ...state.draftSessions, [id]: owner }
      }))
    this.noteModel(this.session(id))
    // The default effort lands before the caller confirms the selection, so it is persisted with
    // it instead of being overwritten by the model's own default a tick later.
    await this.applyDefaultEffort(id)
    await this.applyDefaultFastMode(id)
    return id
  }

  /**
   * Starts a brand-new conversation on the configured default effort.
   *
   * Only new conversations are touched: an existing one carries its own saved effort, restored by
   * `restoreSessionModel`. A model that does not publish the level keeps its own default — never
   * invent an effort the agent would reject.
   */
  private async applyDefaultEffort(id: string): Promise<void> {
    if (!this.holds(id)) return
    // 新建会话路径：描述刚打开模型的 config options 与创建会话的响应同批到达；让出一次事件循环，
    // 等补丁落到 store 再读 effort 阶梯（与 applyEffortForModel / applyRunOverrides 同样的守卫）。
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    // 设置 → 可用模型 is the per-model default and wins; the 「默认会话模型」 effort is the fallback
    // for a model that publishes no level of its own. Without a fallback the agent's global config
    // (~/.codex/config.toml `model_reasoning_effort`, often "low" left by another app) silently
    // overrode every model default, so a catalog saying "max" still opened on Low.
    const effort = this.modelDefaultEffort(id) ?? this.defaultEffortOption?.() ?? null
    if (effort === null) return
    const session = this.session(id)
    if (this.selectedEffort(session.configOptions) === effort) return
    const supported = this.supportedEfforts(id)
    if (supported === null || !supported.includes(effort)) return
    try {
      await this.setConfig(id, "effort", effort)
    } catch {
      // A rejected default must not cost the conversation; the model's own default applies.
    }
  }

  /**
   * Last gate before a turn: repair config this app does not own.
   *
   * `~/.codex/config.toml` is shared with the ChatGPT desktop app (and editable by hand). A bad
   * top-level `model_reasoning_effort` there is sent verbatim on every native turn and the backend
   * answers 400 `invalid_value`; a withdrawn `model = "gpt-6.1-terra"` is accepted by Codex but
   * has no upstream capacity. Both read to the user as "GPT is broken today" with no hint that the
   * cause is local. Rust removes the bad effort at startup/apply, and this catches a value written
   * back afterwards — including on a session resumed from an old rollout.
   *
   * A healthy turn must not even cost a microtask: the local user echo is published synchronously
   * by the dispatch below, and callers read it right after calling `prompt`. So this split is a
   * synchronous check returning `null` when nothing is wrong, and only a real repair returns a
   * promise the caller has to await. Everything is best effort — a rejected repair must not cost
   * the conversation.
   */
  private ensureRunnableConfig(id: string): Promise<void> | null {
    if (!this.holds(id)) return null
    const options = this.session(id).configOptions

    const current = this.selectedEffort(options)
    const supported = this.supportedEfforts(id)
    const badEffort =
      current !== null && supported !== null && supported.length > 0 && !supported.includes(current)

    // Gateway ids are resolved per request by the router, so only bare (native) ids can be judged
    // against the engine's own catalog. No catalog means we cannot tell — never guess here.
    const model = selectedModel(options)
    const catalog = nativeModelCatalog(options)
    const badModel =
      model !== null &&
      !model.includes(":") &&
      catalog.length > 0 &&
      !catalog.some((entry) => entry.id === model) &&
      fallbackModel(options, model) !== null

    if (!badEffort && !badModel) return null
    return this.repairRunnableConfig(id, badEffort, badModel)
  }

  private async repairRunnableConfig(id: string, badEffort: boolean, badModel: boolean): Promise<void> {
    if (badEffort) {
      const session = this.holds(id) ? this.session(id) : undefined
      if (session === undefined) return
      const options = session.configOptions
      const current = this.selectedEffort(options)
      const supported = this.supportedEfforts(id) ?? []
      const model = selectedModel(options)
      const preferred = model === null ? null : this.defaultEffortForModel(session, model)
      const effort =
        preferred !== null && supported.includes(preferred)
          ? preferred
          : (supported.includes("medium") ? "medium" : (supported[0] ?? null))
      const configId = this.effortConfigId(options)
      if (effort !== null && configId !== null && effort !== current) {
        void info(`[config-repair] effort=${current} -> ${effort} id=${id}`)
        try {
          await this.setConfig(id, configId, effort)
        } catch {
          // The model keeps its own default; the turn still goes out with the engine's value.
        }
      }
    }

    if (badModel) {
      if (!this.holds(id)) return
      const options = this.session(id).configOptions
      const model = selectedModel(options)
      if (model === null) return
      const fallback = fallbackModel(options, model)
      if (fallback === null || fallback === model) return
      void info(`[config-repair] model=${model} -> ${fallback} id=${id}`)
      try {
        await this.setConfig(id, "model", fallback)
      } catch {
        // A busy provider rebind can refuse the switch; the caller's own retry still applies.
      }
    }
  }

  /**
   * Starts a brand-new conversation in GPT acceleration when the user asked for it.
   *
   * The flag is honoured only when the current model publishes a boolean `fast-mode` config: the
   * settings window cannot see a session, so it may carry a stale value after the model changed.
   * A model without the option simply runs at normal speed instead of failing the creation.
   */
  private async applyDefaultFastMode(id: string): Promise<void> {
    if (!this.holds(id)) return
    // 同样让出一次事件循环：刚打开模型的 fast-mode 开关随会话创建响应到达，先等它落地再读。
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const session = this.session(id)
    // The model the session actually opened on wins: a draft may have been prepared with an
    // explicit pick that differs from the configured default. Only fall back to the legacy
    // default flag when the engine did not report a model.
    const model = selectedModel(session.configOptions)
    const desired = model !== null ? modelFastModeFor(model) : this.defaultFastModeOption?.() === true
    if (!desired) return
  const option = session.configOptions.find((entry) => entry.configId === "fast-mode")
  // No fast-mode option in this session. As in `applyModelFastMode`, that is ambiguous — a GPT
  // model the user enabled may simply not have published its config options yet. Wiping the saved
  // preference on that transient gap would delete a real enabled flag, so leave it untouched.
  if (option === undefined || !isBooleanOption(option)) return
    if (option.currentValue === true) return
    try {
      await this.setConfig(id, "fast-mode", true)
    } catch {
      // A model that rejects the flag keeps its normal speed; the conversation still opens.
    }
  }

  /** `open(id, cwd, owner)` shows a session in a slot; the options form is the base client's. */
  override async open(id: string, cwd: string, owner: DraftOwner | SessionRequestOptions = "main"): Promise<void> {
    if (typeof owner !== "string") return super.open(id, cwd, owner)
    this.bindSlot(owner, id)
    ++this.slotVersions[owner]
    const existing = this.holds(id) ? this.session(id) : undefined
    // A replay in flight already carries this open. A read-only attach (another client holds the
    // writer) is resumed again: the writer may have let go since.
    if (existing?.attached && !existing.restoring && !existing.readOnly && !this.lifecycle.operations.busy(id)) {
      this.followModel(owner, existing)
      return
    }
    await this.replayForOwner(id, cwd, owner)
  }

  /** A replay a slot asked for resolves the slot's model after the replay has started, so the session shows as restoring meanwhile. */
  private async replayForOwner(id: string, cwd: string, owner: DraftOwner): Promise<void> {
    // Snapshot before replay: replay's noteModel seeds the live config into the same map, which
    // would otherwise overwrite the selection we are about to restore.
    const saved = this.sessionModels.get(id)
    this.openingOwners.set(id, owner)
    try {
      // Resume on the model the thread was recorded with. Codex replays the recorded history
      // through whatever provider it is asked to use; replaying a gateway (Claude/DeepSeek)
      // history through native OpenAI makes the Responses API reject it with
      // `input[n].content` 400s — which surfaced as "打开这个聊天" cards and
      // "api request internal error". The rollout's last turn names the right model.
      // No hint: the adapter reads the provider recorded in the thread itself, which is the
      // one codex accepts. The rollout's original provider goes stale after a model switch and
      // only misleads the route.
      const options = undefined
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.replay(id, cwd, options)
          break
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          // Repair only on the two real replay signatures: it rewrites the rollout, so a generic
          // `invalid_request` from a gateway must not trigger it.
          const providerMismatch = /internal error/i.test(text) || replayRefusal(text)
          // A chat that needs another provider makes the agent restart only its Codex process; a
          // request that happened to be in flight is refused while that runs. Transient — retry it.
          if (attempt === 0 && /restarted for a provider change while this request ran/i.test(text)) {
            await new Promise((resolve) => setTimeout(resolve, 400))
            continue
          }
          // Self-repair: gateway histories carry reasoning items the Responses API rejects when
          // replayed. Dropping them (keeping every user/assistant turn and tool call) makes the
          // conversation resumable again — verified by hand on two broken sessions.
          if (providerMismatch && isTauri()) {
            try {
              const removed = await invoke<number>("repair_session_rollout", {
                sessionId: id
              })
              if (removed > 0) {
                await this.replay(id, cwd, options)
                toast.success(i18n.t("chat.repairDone", { count: removed }))
                break
              }
            } catch {
              // Repair is best effort; fall through to the retry below.
            }
          }
          // Second chance without a hint: the agent then reads the provider recorded in the
          // thread itself instead of trusting our guess from the rollout.
          if (providerMismatch && options !== undefined) {
            try {
              await this.replay(id, cwd)
              break
            } catch {
              // fall through to the guidance below
            }
          }
          // codex runs one provider per process. The agent now restarts its own Codex process for the
          // chat's provider and retries the resume, so reaching this point means that restart could
          // not happen at all (crashed engine, unsupported override). Name both sides so the user
          // knows what is going on instead of reading a bare "internal error".
          const providerConflict = /This chat uses (.+?), but your current provider is (.+?)\./.exec(text)
          const deletedProvider = /This chat uses model provider [“"]([^”"]+)[”"], which is (?:no longer configured|not found)/.exec(text)
          if (deletedProvider !== null) {
            // The chat's provider was removed from settings, so nothing can serve it: say that
            // instead of offering a switch that cannot happen. `alwith` is this app's own router
            // (Rust `bridge::ROUTER_ID`), not a vendor the reader added — "restore that provider"
            // would send them looking for a setting that does not exist.
            //
            // The router is injected into every engine this app spawns (`-c model_providers.alwith.*`
            // in `codex_launcher.rs`), so the engine only reports it as missing when the replay
            // landed on a process started before that injection existed. Reopening the conversation
            // is the real remedy, the provider name is noise, and 15 s of red is what made this
            // look like a permanent failure (2026-11-08). Keep it short and name the action.
            const provider = deletedProvider[1]
            toast.error(i18n.t(provider === "alwith" ? "chat.routerRecovering" : "chat.providerDeleted", { provider }), {
              duration: provider === "alwith" ? 6_000 : 15_000
            })
          } else if (providerConflict !== null) {
            toast.error(
              i18n.t("chat.providerLocked", {
                from: providerConflict[1],
                to: providerConflict[2]
              }),
              {
                duration: 15_000
              }
            )
          } else if (providerMismatch) {
            // A replay the agent cannot honour (mixed-provider history) leaves the "打开这个聊天"
            // card. Say what the user can actually do about it.
            toast.error(i18n.t("chat.historyUnreplayable"), {
              duration: 15_000
            })
          }
          throw error
        }
      }
    } finally {
      if (this.openingOwners.get(id) === owner) this.openingOwners.delete(id)
    }
    // Only after the replay has fully landed: re-applying a saved model from inside a config
    // callback would enqueue a second write while the first transaction is still pending, which
    // deadlocks the draft/replacement hand-off.
    if (this.holds(id)) this.restoreSessionModel(this.session(id), saved)
  }

  /**
   * A conversation is bound to its own model and effort: an existing session resumes on the model
   * persisted for it (then its live config, then the gateway memory) and never borrows another
   * conversation's slot choice. Only a draft — a conversation that does not exist yet — inherits
   * the slot's last confirmed choice. This is what keeps switching one chat to Qwen from dragging
   * an unrelated GPT conversation along when it is opened.
   */
  protected override async requestContext(
    cwd: string,
    operation: SessionOperation,
    options: SessionRequestOptions
  ): ReturnType<CodexAcpClient<AppState>["requestContext"]> {
    // While the sandbox is on it is authoritative: every resumed conversation follows the same
    // policy as a new one, so switching it off does not leave old chats blocked by a boundary the
    // user removed. With the sandbox off the session keeps its own mode (read-only, agent or
    // unrestricted), so an approval level picked for one chat survives reconnects and rebinds.
    const sandboxEnabled = sandboxSettings().enabled
    const sandboxMeta = (request: SessionRequestOptions): SessionRequestOptions =>
      sandboxEnabled
        ? {
            ...request,
            meta: mergeMeta(request.meta, { codex: { mode: sandboxMode() } })
          }
        : request
    if (operation.kind !== "resume") return super.requestContext(cwd, operation, options)
    if ((options.meta?.["alwith"] as { model?: unknown } | undefined)?.model !== undefined)
      return super.requestContext(cwd, operation, sandboxMeta(options))
    const id = operation.sessionId
    const owner = this.openingOwners.get(id)
    const session = this.holds(id) ? this.session(id) : undefined
    const draft = this.state.draftSessions[id] !== undefined
    const model =
      draft && owner !== undefined
        ? await this.resolveModel(this.slotModels[owner])
        : (this.sessionModels.get(id)?.model ??
          (session ? selectedModel(session.configOptions) : null) ??
          this.gatewayModels.get(id) ??
          null)
    return super.requestContext(
      cwd,
      operation,
      sandboxMeta({
        ...options,
        meta: mergeMeta(modelHint(model), options.meta)
      })
    )
  }

  /** Model picked while a turn was still running, applied as soon as that turn settles. */
  private readonly pendingModelSwitches = new Map<string, string>()
  private readonly pendingModelWatchers = new Map<string, () => void>()
  /** In-flight applications of a parked switch, so the next prompt can await them. */
  private readonly pendingModelApplies = new Map<string, Promise<void>>()
  private readonly pendingModelListeners = new Set<() => void>()
  /** When each parked choice was requested, so a wedged liveness clock cannot hold it forever. */
  private readonly parkedAt = new Map<string, number>()
  /**
   * Chats whose last user gesture was Stop, so the next model pick is applied instead of parked.
   *
   * A set, not a timestamp: the question is "is there still a turn to wait for?", and the answer is
   * decided by what happened since the stop — any new turn clears the entry in `prompt`. A clock
   * would have to guess at that, and a chat left alone for ten minutes is exactly as finished as
   * one left for ten seconds.
   */
  private readonly stoppedSessions = new Set<string>()
  /** The last time a session's Runtime run row actually changed (see `runtimeRunningFresh`). */
  private readonly runChanges = new Map<string, { signature: string; at: number }>()

  /**
   * Whether the conversation is mid-turn right now.
   *
   * Two clocks report liveness and they do not flip together: the Runtime's run state turns
   * "running" the moment a prompt is dispatched, while the session's own state only follows once
   * the first `state_update` arrives. A model write that slips between them still tears down the
   * stream the agent is opening — that is the "stream disconnected before completion" seen when
   * switching models repeatedly. Both clocks must read idle before a switch is safe.
   *
   * The Runtime's clock can also get stuck: a turn that died with the engine (provider switch,
   * crash, interrupted app-server) leaves its "running" entry behind with no one to clear it, and
   * an entry that never clears wedges every parked model switch and queued message forever. While
   * the session itself reads idle, a run state that has shown no activity for a minute is treated
   * as that leftover — a live turn always reports `state_update` or activity well inside that
   * window, so the protection against switching mid-turn is unchanged.
   */
  private sessionBusy(id: string): boolean {
    const session = this.state.sessions[id]
    if (session !== undefined && session.state !== "idle") return true
    return this.runtimeRunningFresh(id)
  }

  /** True while the Runtime reports a turn that is genuinely still alive (see `sessionBusy`). */
  private runtimeRunningFresh(id: string): boolean {
    const run = this.state.runStates[id]
    if (run === undefined) return false
    if (run.state !== "running" && run.state !== "requires_action") return false
    // Freshness is measured from the last time this row actually *changed*, not from the Runtime's
    // own `lastActivityAt`: that stamp is refreshed on every republish, so a row left behind by a
    // turn that died with the engine keeps looking alive forever. A parked model switch then waits
    // on a turn that will never settle — the "本轮后切换" badge stuck on screen while every retry
    // reads busy. A live turn republishes with a new version well inside this window, so the guard
    // against switching mid-turn is unchanged.
    const changed = this.runChanges.get(id)?.at ?? 0
    return Date.now() - changed < STALE_RUN_STATE_MS
  }

  override applyRunStates(sessions: SessionRunState[], source?: "snapshot" | "event"): void {
    const now = Date.now()
    for (const run of sessions) {
      // `lastActivityAt` is deliberately left out of the signature: it is the Runtime's heartbeat,
      // not a change.
      const signature = `${run.state}|${run.version}|${run.since}|${run.executionId ?? ""}|${run.tasks.length}|${run.interruption ?? ""}`
      if (this.runChanges.get(run.sessionId)?.signature === signature) continue
      // A row seen for the first time carries its own age, so a leftover from a turn that died
      // minutes ago reads stale on arrival instead of buying another full window.
      const born = Math.min(now, run.lastActivityAt || now)
      this.runChanges.set(run.sessionId, { signature, at: born })
    }
    super.applyRunStates(sessions, source)
  }

  /** The rejection the agent answers a mid-turn provider change with. */
  private turnBusyRejection(message: string): boolean {
    return /wait for (?:the|a) current turn|turn (?:is )?(?:still )?(?:running|in progress|busy)|session is (?:busy|running)|(?:another|previous) (?:turn|request|prompt) (?:is )?(?:still )?(?:running|in progress)/i.test(
      message
    )
  }

  override async setConfig(
    id: string,
    configId: string,
    value: string | boolean,
    owner: DraftOwner = "main"
  ): Promise<void> {
    // The composer reports reasoning effort under the common name `effort`, but the Codex agent serves
    // it as `reasoning_effort` (category `thought_level`). Writing `effort` is rejected and the pin is
    // silently lost, so the model keeps its own default — exactly the "I picked an effort but it ran
    // as Low" confusion. Rewrite to the id the agent actually serves before the write.
    if (configId === "effort") {
      const session = this.holds(id) ? this.session(id) : undefined
      const real = session === undefined ? null : this.effortConfigId(session.configOptions)
      if (real !== null) configId = real
    }
    // Keep the owner under the effective id. Otherwise an `effort` alias leaves a stale entry while
    // the agent reports the real `reasoning_effort` id in its response.
    this.configOwners.set(`${id}:${configId}`, owner)
    // The agent refuses a provider change mid-turn ("Wait for the current turn"), and forcing one
    // tears down the running stream — that is what surfaced as
    // "stream disconnected before completion". Park the choice instead of erroring, then apply it
    // the moment the turn settles, so switching stays unrestricted for the user.
    if (configId === "model" && typeof value === "string") {
      // What the user actually asked for. `value` is rewritten below (a retired model hops to a
      // live sibling), and the parked entry is keyed on the request — clearing it with the rewritten
      // value left the choice parked forever, so the badge never went away and the model never moved.
      const requested = value
      // A model the agent does not serve. 设置 → 可用模型 keeps the user's rows even after the
      // provider stops advertising one (`gpt-6.1-terra`), and the picker now mirrors that list, so
      // this write can name an id the engine never returns. It does not fail either — the agent
      // ignores the unknown id and the turn runs on whatever the chat was already on, leaving the
      // trigger reading "6.1 Terra" over Sol output. Hop to a live sibling before the write and say
      // so; a silent hop is worse than a visible one.
      //
      // An empty `known` means the catalog has not landed yet, so nothing is judged: every switch
      // made while a chat is still opening would otherwise look unsupported.
      const live = this.holds(id) ? this.session(id) : undefined
      if (live !== undefined) {
        const known = modelValues(live.configOptions)
        // Only the integrated GPT group is checked. A gateway id (`gateway:vendor:model`) reaches
        // the session through the provider snapshot, which can be a step ahead of this chat's own
        // config options — judging those would bounce a model the user just added in 设置.
        const nativeId = !value.includes(":")
        if (nativeId && known.length > 0 && !known.includes(value)) {
          const sibling = fallbackModel(live.configOptions, value)
          if (sibling !== null) {
            toast.info(i18n.t("chat.modelRetired", { from: value, to: sibling }), { duration: 8000 })
            value = sibling
          }
        }
      }
      // Every gateway now shares one Codex provider, so a model from another vendor is just a
      // different model string — no rebind, no engine restart. Only chats written before the
      // shared provider are still pinned; the agent says so and the catch below explains it.
      try {
        await this.landModelSwitch(id, configId, value, requested)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const busy = this.turnBusyRejection(message)
        void info(`[pending-model] setConfig rejected id=${id} requested=${requested} value=${value} busy=${busy} message=${message.slice(0, 240)}`)
        // A chat opened from before the shared provider stays on its vendor. It is reported like
        // every other failure -- once, through `describeError` -- so there is no second toast.
        const unsupported = unsupportedModel(error)
        if (unsupported !== null) {
          // The picked model no longer exists. Parking it would retry a choice that can never
          // apply; remember the refusal and move to a sibling the catalog still offers instead.
          retireModel(unsupported)
          const session = this.holds(id) ? this.session(id) : undefined
          const fallback = session ? fallbackModel(session.configOptions, unsupported) : null
          if (fallback === null) throw error
          if (busy) {
            this.parkModelSwitch(id, fallback)
            return
          }
          await super.setConfig(id, configId, fallback)
          this.clearParkedModel(id, requested)
          await this.applyEffortForModel(id, fallback)
          await this.applyModelFastMode(id, fallback)
          // The picker no longer offers it, so say why the selection moved instead of letting the
          // badge change on its own.
          if (value !== fallback)
            toast.info(i18n.t("chat.modelRetired", { from: value, to: fallback }), { duration: 8000 })
          return
        }
        if (busy) {
          // A stop is still unwinding on the agent's side. The pick that follows it means "switch
          // now": end the turn and write the choice instead of parking it behind a turn that is
          // already over.
          if (await this.switchRightAfterStop(id, configId, value, requested)) return
          this.parkModelSwitch(id, value)
          return
        }
        // The thread's history belongs to the provider that wrote it. Codex rejects a replay it
        // cannot honour, and the agent rolls the switch back; say what happened instead of the
        // raw ACP error, and leave the conversation on its old model.
        //
        // `invalid_request` used to stand in for that, but every gateway words its 400s that way,
        // so a vendor refusing a model id was reported as a broken transcript. Match the two
        // shapes the Responses API uses for a refused replay, and name the model case separately.
        if (/This chat uses|no longer configured/i.test(message) || replayRefusal(message)) {
          toast.error(i18n.t("chat.historyUnreplayable"), { duration: 12_000 })
          return
        }
        const served = /supported API model names are (.+?), but you passed (\S+?)[.\s]*$/i.exec(message)
        if (served !== null) {
          toast.error(i18n.t("error.gatewayModel", { model: served[2], served: served[1] }), {
            duration: 12_000
          })
          return
        }
        throw error
      }
    }
    await super.setConfig(id, configId, value)
    // Mirror the write into this chat's record. A value that equals the model row's own default is
    // not a deviation: it stays re-derivable, so a later change to that row still reaches the chat.
    if (this.holds(id) && !this.selectingRole.has(id) && !this.orchestrating.has(id)) {
      const session = this.session(id)
      const model = selectedModel(session.configOptions)
      if (configId === "fast-mode" && typeof value === "boolean")
        this.saveSessionModel(id, {
          fastMode: value,
          fastExplicit: model !== null && value !== modelFastModeFor(model)
        })
      else if (typeof value === "string" && configId === this.effortConfigId(session.configOptions))
        this.saveSessionModel(id, {
          effort: value,
          effortExplicit: model !== null && value !== this.defaultEffortForModel(session, model)
        })
    }
  }

  /**
   * Writes a model switch and does the bookkeeping every successful switch needs.
   *
   * Split out so the post-stop retry lands through exactly the same path as a normal pick: a
   * second write that skipped the effort/fast-mode follow-up would leave the new model running on
   * the previous model's effort.
   */
  private async landModelSwitch(id: string, configId: string, value: string, requested: string): Promise<void> {
    await super.setConfig(id, configId, value)
    void info(`[pending-model] setConfig ok id=${id} model=${value} requested=${requested}`)
    // The provider serves it after all (re-added, or the tombstone aged out): stop avoiding it.
    reviveModel(value)
    // Clear the parked entry only when it is still this choice: a newer pick made while the write
    // was in flight must survive it.
    this.clearParkedModel(id, requested)
    this.clearParkedModel(id, value)
    // Settings know one default effort per model; a switch should land on it instead of inheriting
    // the level the previous model happened to run on.
    await this.applyEffortForModel(id, value)
    await this.applyModelFastMode(id, value)
  }

  /**
   * A model picked after Stop is a "switch now", not a "switch after this turn".
   *
   * The agent refuses a provider rebind while a turn is unwinding (`Wait for the current turn…`),
   * and a native model always takes that path: its gateway resolves to null while the thread's
   * provider is the shared router, so `rebindSessionProvider` reaches the busy check. Every gateway
   * model resolves to the same runtime id as the thread, so gateway -> gateway returns before that
   * check — which is why, after a stop, GPT -> GPT looked dead while another vendor's model went
   * straight through.
   *
   * The decision is state, not elapsed time: `stoppedSessions` says the last thing that happened in
   * this chat was a stop, and any new turn clears that entry in `prompt`. So a pick is forced
   * whenever there is nothing left to wait for, and parked whenever a real turn is running.
   */
  private async switchRightAfterStop(
    id: string,
    configId: string,
    value: string,
    requested: string
  ): Promise<boolean> {
    // The gate is state, not time: nothing has been sent since the stop, so there is no turn left
    // to wait for — however long ago that stop was.
    if (!this.stoppedSessions.has(id)) return false
    // This pick supersedes anything parked earlier: cancelling below would otherwise apply the old
    // choice first and the two writes would race for the model string.
    const parked = this.pendingModelSwitches.get(id)
    if (parked !== undefined && parked !== value) this.clearParkedModel(id, parked)
    // End the turn even if its last token is still arriving: the user stopped it.
    await this.cancel(id).catch(() => {})
    this.stoppedSessions.delete(id)
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && this.state.sessions[id]?.state !== "idle")
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    try {
      await this.landModelSwitch(id, configId, value, requested)
      void info(`[pending-model] post-stop switch landed id=${id} model=${value}`)
      return true
    } catch (error) {
      void info(`[pending-model] post-stop switch failed id=${id} model=${value} error=${String(error).slice(0, 200)}`)
      return false
    }
  }

  /**
   * The stop button: the one gesture that means "this turn is over".
   *
   * A message queued behind the turn would otherwise be sent the instant it settles — the extra
   * round that appears right after pressing stop. Dropping the queue here is what makes the stop
   * final; the composer puts the cancelled text back into the input.
   */
  override async cancel(id: string): Promise<void> {
    cancelQueuedPrompt(id)
    this.stoppedSessions.add(id)
    await super.cancel(id)
    // A choice parked behind this turn must not outlive it. Left alone, the "下一轮" badge sits on
    // the composer waiting for a turn the user just ended, and the picker keeps showing the old
    // model — which is exactly what a stop followed by a model pick looked like.
    if (this.pendingModelSwitches.has(id) && !this.pendingModelApplies.has(id))
      void this.applyParkedModel(id, true)
  }

  /**
   * Remembers a model chosen while the conversation was busy and reapplies it once idle.
   *
   * Without this the pick would silently never take effect: the agent keeps the previous provider,
   * so the next prompt still goes to the old gateway and comes back as 503 / no channel available.
   * The application is also awaited by the next prompt, so a choice parked one second before the
   * send still routes that turn to the new model.
   */
  private parkModelSwitch(id: string, model: string): void {
    void info(`[pending-model] park id=${id} model=${model} busy=${this.sessionBusy(id)} state=${this.state.sessions[id]?.state ?? "?"}`)
    this.pendingModelSwitches.set(id, model)
    this.parkedAt.set(id, Date.now())
    this.emitPendingModel()
    if (this.pendingModelWatchers.has(id)) return
    let stop = (): void => {}
    stop = this.store.subscribe(() => {
      void this.applyParkedModel(id)
    })
    // A store tick is the usual trigger, but a settled conversation can stop ticking altogether —
    // nothing is streaming, nothing is being read — and then the parked pick waits on an event that
    // never comes ("本轮后切换" stuck on screen while the next turn still runs the old model).
    // The timer is the safety net; both it and the subscription die with the parked entry.
    const retry = setInterval(() => {
      if (this.pendingModelSwitches.get(id) === undefined) return
      void this.applyParkedModel(id)
    }, PENDING_MODEL_RETRY_MS)
    this.pendingModelWatchers.set(id, () => {
      stop()
      clearInterval(retry)
    })
  }

  /** Drops a parked choice once the write it stood for has landed (or moved to a substitute). */
  private clearParkedModel(id: string, requested: string): void {
    if (this.pendingModelSwitches.get(id) !== requested) return
    this.pendingModelSwitches.delete(id)
    this.parkedAt.delete(id)
    const stop = this.pendingModelWatchers.get(id)
    this.pendingModelWatchers.delete(id)
    stop?.()
    this.emitPendingModel()
  }

  /**
   * A parked choice this conversation has read idle long enough to apply, whatever the Runtime says.
   *
   * The Runtime's run row is the only clock that can get stuck — a turn that died with the engine
   * leaves its "running" entry behind. Waiting on it forever is what kept "本轮后切换" on screen.
   * A session that reports idle is not mid-turn, so after a full stale window the write is safe.
   */
  private parkedSwitchOverdue(id: string): boolean {
    const session = this.state.sessions[id]
    if (session === undefined || session.state !== "idle") return false
    const at = this.parkedAt.get(id)
    return at !== undefined && Date.now() - at >= STALE_RUN_STATE_MS
  }

  /**
   * Applies the parked choice immediately, ending the running turn first.
   *
   * The agent refuses a provider change mid-turn, so "switch now" means "stop this answer and
   * switch": that is exactly the choice the user makes when the current turn keeps running and the
   * picker keeps saying 本轮后切换.
   */
  async applyPendingModelNow(id: string): Promise<void> {
    const pending = this.pendingModelSwitches.get(id)
    if (pending === undefined) return
    void info(`[pending-model] applyNow id=${id} model=${pending} busy=${this.sessionBusy(id)} state=${this.state.sessions[id]?.state ?? "?"}`)
    if (this.sessionBusy(id)) {
      await this.cancel(id).catch(() => {})
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline && this.state.sessions[id]?.state !== "idle")
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    // Clicking the chip means "switch now". Go through the very same setConfig the model picker
    // uses: the parked-watcher path has its own busy gate and can silently decline the write.
    try {
      await this.withTimeout(this.setConfig(id, "model", pending), 20_000, "setConfig(model)")
    } catch (error) {
      void info(`[pending-model] applyNow failed id=${id} error=${String(error)}`)
    }
    if (this.pendingModelSwitches.get(id) !== undefined) {
      void info(`[pending-model] applyNow still parked id=${id} model=${pending}`)
      toast.error(i18n.t("chat.pendingModelBusy"))
    } else {
      void info(`[pending-model] applyNow landed id=${id} model=${pending}`)
    }
  }

  /** Applies the parked choice now, or joins the application already in flight. */
  private applyParkedModel(id: string, force = false): Promise<void> {
    const applying = this.pendingModelApplies.get(id)
    if (applying !== undefined) return applying
    const pending = this.pendingModelSwitches.get(id)
    if (pending === undefined) return Promise.resolve()
    if (!force && this.sessionBusy(id) && !this.parkedSwitchOverdue(id)) return Promise.resolve()
    // Deferred by one microtask on purpose: `setConfig` publishes a store patch synchronously,
    // and the watcher — which runs inside that patch — must already see this entry, or it would
    // start a second write for the same choice and recurse until the stack overflows.
    const apply = Promise.resolve()
      .then(() => this.withTimeout(this.setConfig(id, "model", pending), 20_000, "setConfig(model)"))
      .then(
        () => { void info(`[pending-model] apply landed id=${id} model=${pending} force=${force} stillParked=${this.pendingModelSwitches.has(id)}`) },
        (error: unknown) => {
          void info(`[pending-model] apply threw id=${id} model=${pending} error=${String(error).slice(0, 240)}`)
          // A busy rejection re-parks the choice inside setConfig and the watcher retries when
          // the turn settles. Any other failure means this choice cannot apply at all — drop it,
          // or every store tick would start another write and starve the app's timers.
          if (!this.turnBusyRejection(error instanceof Error ? error.message : String(error)))
            this.clearParkedModel(id, pending)
        }
      )
    this.pendingModelApplies.set(id, apply)
    return apply.finally(() => {
      this.pendingModelApplies.delete(id)
      // A turn that started while applying re-parks the choice and keeps this watcher alive.
      if (this.pendingModelSwitches.get(id) === undefined) {
        const stop = this.pendingModelWatchers.get(id)
        this.pendingModelWatchers.delete(id)
        stop?.()
        this.emitPendingModel()
      }
    })
  }

  /**
   * Applies a switch parked during a running turn before the next prompt is dispatched.
   *
   * The watcher normally lands the choice the moment the session goes idle; this covers the gap
   * where the user sends immediately after the turn ends and the store has not ticked since.
   * Returns null when there is nothing to apply, so the prompt dispatch stays synchronous.
   */
  private flushPendingModelSwitch(id: string): Promise<void> | null {
    const applying = this.pendingModelApplies.get(id)
    if (applying !== undefined) return applying
    const pending = this.pendingModelSwitches.get(id)
    if (pending === undefined) return null
    const busy = this.sessionBusy(id)
    void info(`[pending-model] flush id=${id} model=${pending} busy=${busy} overdue=${this.parkedSwitchOverdue(id)} state=${this.state.sessions[id]?.state ?? "?"}`)
    // Returning null here used to dispatch the next prompt on the OLD model: a Runtime run row
    // left behind by a stopped turn keeps `busy` true for a full stale window. The user's
    // "本轮后切换" choice must win that race, so force the write instead of dropping it.
    return this.applyParkedModel(id, busy && !this.parkedSwitchOverdue(id))
  }

  /** The model a conversation switches to once its current turn settles, for status surfaces. */
  pendingModelFor(id: string): string | null {
    return this.pendingModelSwitches.get(id) ?? null
  }

  onPendingModelChange(listener: () => void): () => void {
    this.pendingModelListeners.add(listener)
    return () => this.pendingModelListeners.delete(listener)
  }

  private emitPendingModel(): void {
    for (const listener of this.pendingModelListeners) listener()
  }

  /**
   * Waits for the session's running turn to settle (bounded), then sends the queued prompt.
   *
   * Registered in `queued-prompt` so the composer can show "排队中…（点击取消）": cancelling there
   * rejects this wait, which makes the composer restore the message into its input instead of
   * sending it.
   */
  private async waitForIdleThenPrompt(
    id: string,
    prompt: acp.ContentBlock[],
    options?: PromptOptions
  ): Promise<string> {
    const entry = beginQueuedPrompt(id, promptSummary(prompt))
    const deadline = Date.now() + 15 * 60_000
    try {
      while (Date.now() < deadline) {
        if (entry.cancelled) throw new QueueCancelledError()
        const session = this.holds(id) ? this.session(id) : undefined
        if (session === undefined) break
        // Same two clocks as a parked model switch: the ACP state alone can say idle a beat before
        // the Runtime does, and sending into that gap is what tore down the opening stream.
        if (session.state === "idle" && !this.runtimeRunningFresh(id))
          return await this.sendPrompt(id, prompt, options)
        await new Promise<void>((resolve) => setTimeout(resolve, 500))
      }
      if (entry.cancelled) throw new QueueCancelledError()
      // Session gone or waited out: send anyway rather than dropping the user's words.
      return await this.sendPrompt(id, prompt, options)
    } finally {
      endQueuedPrompt(id, entry)
    }
  }

  /**
   * Tells the agent which document the user is looking at when the preview pane is open.
   *
   * The context goes into the prompt the agent receives, while `display` keeps the user's own
   * bubble exactly as typed (the base client stores `display ?? prompt` in the timeline). Scoped to
   * the preview's project so a prompt aimed at another project is never polluted, and skipped for
   * non-text prompts so file/voice-only sends are untouched.
   */
  override prompt(id: string, prompt: acp.ContentBlock[], options?: PromptOptions): Promise<string> {
    // A new turn means the stop no longer describes this chat: the next model pick has a live turn
    // to wait for again, so it parks the ordinary way.
    this.stoppedSessions.delete(id)
    // Queued send mode: a message typed while a turn is running waits for that turn to settle
    // and goes out on its own, instead of steering into the running answer. Waiting here keeps
    // the composer's own echo/sending state, and consecutive sends naturally line up because
    // each one re-checks the session state once it reaches the front.
    if (getQueueSendMode() === "queued") {
      const busy = this.holds(id) ? this.session(id) : undefined
      if (busy !== undefined && busy.state !== "idle") {
        return this.waitForIdleThenPrompt(id, prompt, options)
      }
    }
    const doc = getActivePreview()
    if (doc === null) return this.sendPrompt(id, prompt, options)
    const session = this.holds(id) ? this.session(id) : undefined
    const trim = (path: string): string => path.replace(/[\\/]+$/, "")
    if (session !== undefined && doc.root !== "" && trim(session.cwd) !== trim(doc.root))
      return this.sendPrompt(id, prompt, options)
    if (!prompt.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== ""))
      return this.sendPrompt(id, prompt, options)
    const note: acp.ContentBlock = {
      type: "text",
      text: `【当前预览文档】${doc.title}\n${doc.path}\n（下面这条消息针对预览中打开的该文档/内容）`
    }
    return this.sendPrompt(id, [note, ...prompt], {
      ...options,
      display: options?.display ?? prompt
    })
  }

  /**
   * Sends a prompt and recovers once from a model the upstream retired.
   *
   * A thread pinned to an unsupported id rejects every prompt with `Unsupported model: '<id>'`,
   * which used to leave the conversation dead. Forget the stale selection, move the thread to the
   * next model the catalog still offers (same group first), and resend the same message once.
   */
  private async sendPrompt(id: string, prompt: acp.ContentBlock[], options?: PromptOptions): Promise<string> {
    // A model parked during the previous turn lands before this one is dispatched, so the turn
    // goes to the gateway the user last picked instead of the one the agent still remembers.
    // Nothing pending must not even cost a microtask: the local user echo is published
    // synchronously by the dispatch below, and callers read it right after calling prompt.
    const flush = this.flushPendingModelSwitch(id)
    if (flush !== null) await flush
    // config.toml is shared with other Codex apps. A bad effort or a withdrawn default model there
    // is not visible to the picker, so this is the last point where the turn can still be repaired.
    // `null` on a healthy session: awaiting it would delay the synchronous local echo by a tick.
    const repair = this.ensureRunnableConfig(id)
    if (repair !== null) await repair
    const orchestration = orchestrationFor(id)
    if (
      orchestration !== null &&
      !this.orchestrating.has(id) &&
      prompt.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
    )
      return this.planPrompt(id, prompt, options, orchestration)
    try {
      return await this.promptWithTimeout(id, prompt, options)
    } catch (error) {
      const unsupported = unsupportedModel(error)
      if (unsupported === null) throw error
      // Remember it: a saved 可用模型 row would otherwise keep sending the same dead id.
      retireModel(unsupported)
      const session = this.holds(id) ? this.session(id) : undefined
      const fallback = session ? fallbackModel(session.configOptions, unsupported) : null
      if (fallback === null) throw error
      const saved = this.sessionModels.get(id)
      this.sessionModels.set(id, {
        model: null,
        effort: saved?.effort ?? null,
        ...(saved?.fastMode !== undefined ? { fastMode: saved.fastMode } : {})
      })
      this.persistSessionModels()
      try {
        await this.setConfig(id, "model", fallback)
      } catch {
        throw error
      }
      return this.promptWithTimeout(id, prompt, options)
    }
  }

  /**
   * Runs the planner half of an orchestrated turn and parks the plan for the user to approve.
   *
   * The session is put in `read-only` first when the engine exposes that mode: the planner must not
   * edit files or run commands, and a prompt-only guard cannot guarantee that. The mode is restored
   * before the plan is published, so the worker runs with the user's normal permissions.
   */
  private async planPrompt(
    id: string,
    prompt: acp.ContentBlock[],
    options: PromptOptions | undefined,
    orchestration: SessionOrchestration
  ): Promise<string> {
    const roles = this.orchestrationRoles(id, orchestration)
    this.orchestrating.add(id)
    this.setOrchestrationPhase(id, "planner")
    const previousMode = this.sessionMode(id)
    if (previousMode !== null && this.modeSupports(id, "read-only")) await this.setConfig(id, "mode", "read-only")
    try {
      const receipt = await this.withMainSelection(id, async () => {
        await this.applyOrchestrationRole(id, "planner", roles.planner)
        const next = await this.promptWithTimeout(id, [plannerInstruction(), ...prompt], {
          ...options,
          display: options?.display ?? prompt
        })
        await this.waitForTurn(id, next)
        return next
      })
      setPendingPlan(id, {
        plan: this.lastAssistantText(id),
        request: promptText(prompt)
      })
      return receipt
    } finally {
      if (previousMode !== null) await this.setConfig(id, "mode", previousMode).catch(() => {})
      this.orchestrating.delete(id)
      this.setOrchestrationPhase(id, null)
    }
  }

  /** Runs the approved plan on the worker model. Returns null when there is nothing to execute. */
  async executePlan(id: string): Promise<string | null> {
    const pending = pendingPlanFor(id)
    if (pending === null) return null
    const orchestration = orchestrationFor(id)
    if (orchestration === null) {
      setPendingPlan(id, null)
      return null
    }
    setPendingPlan(id, null)
    let prompted = false
    this.setOrchestrationPhase(id, "worker")
    try {
      const roles = this.orchestrationRoles(id, orchestration)
      return await this.withMainSelection(id, async () => {
        await this.applyOrchestrationRole(id, "worker", roles.worker)
        const receipt = await this.promptWithTimeout(id, [{ type: "text", text: workerInstruction(pending) }], {
          display: [{ type: "text", text: "执行计划" }]
        })
        prompted = true
        await this.waitForTurn(id, receipt)
        return receipt
      })
    } catch (error) {
      // Put the plan back so the user can retry without asking the planner again.
      if (!prompted) setPendingPlan(id, pending)
      throw error
    } finally {
      this.setOrchestrationPhase(id, null)
    }
  }

  /** The phase an orchestrated turn is in, or null when no orchestrated turn is running. */
  orchestrationPhaseFor(id: string): "planner" | "worker" | null {
    return this.orchestrationPhase.get(id) ?? null
  }

  /** Subscribe to phase changes; the status row re-renders as the planner hands off to the worker. */
  subscribeOrchestrationPhase(listener: () => void): () => void {
    this.orchestrationPhaseListeners.add(listener)
    return () => {
      this.orchestrationPhaseListeners.delete(listener)
    }
  }

  private setOrchestrationPhase(id: string, phase: "planner" | "worker" | null): void {
    if (phase === null) {
      if (!this.orchestrationPhase.delete(id)) return
    } else {
      this.orchestrationPhase.set(id, phase)
    }
    for (const listener of this.orchestrationPhaseListeners) listener()
  }

  /**
   * Runs one throwaway turn on another model and returns what it answered.
   *
   * A reviewing model must never become a conversation in the sidebar, so the turn runs in a draft
   * session: `draft` keeps it out of `session/list`, and deleting it the moment it settles keeps
   * the on-disk thread count flat instead of growing by one per review. The reviewer sees only the
   * prompt it is given — a second full copy of the conversation would cost as much as the turn
   * being reviewed and tell it nothing new.
   */
  async runIsolatedTurn(cwd: string, model: string, prompt: string): Promise<string> {
    const id = await this.openIsolatedSession(cwd, model)
    try {
      const receipt = await this.promptWithTimeout(id, [{ type: "text", text: prompt }], undefined)
      // A draft is listed the instant its first prompt is dispatched; hide it again before the
      // sidebar's next refresh can show a conversation the user never started.
      this.unlistSession(id)
      await this.waitForTurn(id, receipt)
      const answer = this.lastAssistantText(id)
      if (answer.trim() === "") {
        const reason = this.state.sessions[id]?.lastStopReason ?? null
        throw new Error(reason === null ? "该模型没有返回内容" : `该模型提前结束（${reason}）`)
      }
      return answer
    } finally {
      await this.delete(id).catch(() => {})
    }
  }

  /** A hidden session already switched to `model` (see `runIsolatedTurn`). */
  private async openIsolatedSession(cwd: string, model: string): Promise<string> {
    let directory = cwd
    if (directory.trim() === "" && isTauri()) {
      directory = await invoke<string>("quick_chat_directory").catch(() => cwd)
    }
    const id = await super.newSession(directory, {
      draft: true,
      meta: mergeMeta(modelHint(model), { codex: { mode: sandboxMode() } }, { alwith: { draft: true } })
    })
    this.noteModel(this.session(id))
    if (selectedModel(this.session(id).configOptions) !== model) await this.setConfig(id, "model", model)
    // A reviewer only reads the plan; it must not edit files or run commands on the side.
    if (this.modeSupports(id, "read-only")) await this.setConfig(id, "mode", "read-only").catch(() => {})
    return id
  }

  /** Sends a prompt and resolves once that turn has actually settled, not when it is accepted. */
  async promptAndWait(id: string, prompt: acp.ContentBlock[], options?: PromptOptions): Promise<string> {
    const receipt = await this.promptWithTimeout(id, prompt, options)
    await this.waitForTurn(id, receipt)
    return receipt
  }

  /**
   * Runs the group's roster: every role speaks once per round, then the moderator closes.
   *
   * The discussion lives in one conversation, so the members read each other's turns for free —
   * that is what makes a group more than three independent answers. Each turn switches the shared
   * session to that role's model, says who is speaking in the user's own bubble, and waits for the
   * turn to settle before the next role takes over. The user's own model is restored at the end,
   * so the composer still shows what they had.
   *
   * The user keeps the brake: between turns the roster honours a pause (the turn in flight always
   * finishes, so nothing already written is thrown away) and ends on a stop. A message the user
   * sends while paused is an interjection — it restarts the rounds, because the roster now argues
   * from a premise none of its earlier speeches had.
   */
  async runGroupDiscussion(
    id: string,
    turns: GroupTurn[],
    rounds: number,
    document: string,
    summaryTemplate: string
  ): Promise<{ outcome: "done" | "stopped"; rounds: GroupRoundRecord[] }> {
    if (turns.length === 0) return { outcome: "done", rounds: [] }
    const selection = this.currentSelection(id)
    if (selection === null) throw new Error("群会话没有当前模型")
    const speakers = turns.filter((turn) => !turn.moderator)
    const moderator = turns.find((turn) => turn.moderator)
    const records: GroupRoundRecord[] = []
    let baseline = this.lastUserTurnKey(id)
    // A member whose model cannot take the floor is skipped, not fatal: one broken provider must
    // not cancel a discussion the others can still hold. Reported once, at the end.
    const absent: string[] = []
    let speechFailures = 0
    const speak = async (turn: GroupTurn, at: number, kind: "speech" | "summary"): Promise<string | null> => {
      try {
        await this.speakAsRole(id, turn, at, document, kind, summaryTemplate)
        return this.lastAssistantText(id)
      } catch (error) {
        absent.push(`${turn.name}（${error instanceof Error ? error.message : String(error)}）`)
        // Every speaker failing means the discussion itself cannot run — surface that, do not
        // report a "finished" discussion that never happened.
        if (kind === "speech") {
          speechFailures += 1
          if (speechFailures >= speakers.length) throw error
        }
        return null
      }
    }
    try {
      let round = 0
      let index = 0
      let speeches: GroupSpeechRecord[] = []
      let startedAt = stamp()
      for (;;) {
        const gate = await this.groupGate(id, selection, baseline)
        baseline = gate.baseline
        if (gate.action === "stop") return { outcome: "stopped", rounds: records }
        if (gate.action === "restart") {
          // The user's interjection invalidated the premise: the record starts over with the rounds.
          round = 0
          index = 0
          speeches = []
          records.length = 0
          startedAt = stamp()
          continue
        }
        if (index < speakers.length) {
          const turn = speakers[index]
          index += 1
          if (turn !== undefined) {
            if (speeches.length === 0) startedAt = stamp()
            const text = await speak(turn, round, "speech")
            if (text !== null) speeches.push({ name: turn.name, at: stamp(), text })
          }
          continue
        }
        // The roster has gone round: the moderator summarizes this round before the next one.
        const summary = moderator === undefined ? null : await speak(moderator, round, "summary")
        records.push({ round, startedAt, summary: summary ?? "", speeches })
        speeches = []
        round += 1
        index = 0
        if (round >= rounds) return { outcome: "done", rounds: records }
      }
    } finally {
      announceGroupSpeaker(null, 0)
      clearGroupControl(id)
      if (absent.length > 0) patchGroupDiscussion(id, { error: `缺席：${absent.join("；")}` })
      await this.restoreMainSelection(id, selection).catch(() => {})
    }
  }

  /**
   * The brake between two speakers: stop, pause, or "the user just said something".
   *
   * Returns the key it settled on so the caller keeps one baseline for the whole discussion — a
   * group turn is itself a user message, which is why `lastUserTurnKey` skips the 〔…〕 markers.
   */
  private async groupGate(
    id: string,
    selection: { model: string; effort: string | null; fastMode: boolean },
    baseline: string
  ): Promise<{ action: "go" | "restart" | "stop"; baseline: string }> {
    // An interjection is a turn of its own: the roster waits for the user's answer to land before
    // it takes the floor back, or the next speaker would queue behind it.
    await this.waitForIdle(id)
    const control = groupControlFor(id)
    if (control.stop) return { action: "stop", baseline }
    const current = this.lastUserTurnKey(id)
    if (current !== baseline) return { action: "restart", baseline: current }
    if (!control.paused) return { action: "go", baseline }
    // The floor goes back to the user while the roster waits: an interjection is theirs, answered
    // by their own model, not by whichever member happened to speak last.
    await this.restoreMainSelection(id, selection).catch(() => {})
    const outcome = await this.waitForGroupGate(id, baseline)
    if (outcome === "stop") return { action: "stop", baseline }
    // An interjection restarts the rounds and runs them out: the brake was only there to let the
    // user take the floor, not to keep the roster parked after they spoke.
    if (outcome === "interject") setGroupPaused(id, false)
    return { action: outcome === "interject" ? "restart" : "go", baseline: this.lastUserTurnKey(id) }
  }

  /** Resolves once this conversation is idle again (or the user asked the roster to stop). */
  private async waitForIdle(id: string): Promise<void> {
    // A closed session has no state to wait for; the caller's next turn simply fails and is caught.
    const settled = (): boolean => {
      const state = this.state.sessions[id]?.state
      return state === undefined || state === "idle"
    }
    if (settled()) return
    await new Promise<void>((resolve) => {
      let done = false
      let detach = (): void => {}
      const finish = (): void => {
        if (done) return
        done = true
        detach()
        resolve()
      }
      const check = (): void => {
        if (groupControlFor(id).stop || settled()) finish()
      }
      detach = this.store.subscribe(check)
      check()
    })
  }

  /** Resolves when the user resumes, stops, or takes the floor with a message of their own. */
  private waitForGroupGate(id: string, baseline: string): Promise<"resume" | "stop" | "interject"> {
    return new Promise((resolve) => {
      let done = false
      let detachControl = (): void => {}
      let detachStore = (): void => {}
      const finish = (value: "resume" | "stop" | "interject"): void => {
        if (done) return
        done = true
        detachControl()
        detachStore()
        resolve(value)
      }
      const check = (): void => {
        const control = groupControlFor(id)
        if (control.stop) finish("stop")
        else if (this.lastUserTurnKey(id) !== baseline) finish("interject")
        else if (!control.paused) finish("resume")
      }
      detachControl = subscribeGroupControl(check)
      detachStore = this.store.subscribe(check)
      check()
    })
  }

  /** The id of the last message the *user* wrote in this conversation, ignoring the roster's own. */
  private lastUserTurnKey(id: string): string {
    const session = this.holds(id) ? this.session(id) : undefined
    if (session === undefined) return ""
    for (let index = session.items.length - 1; index >= 0; index -= 1) {
      const item = session.items[index]
      if (item?.kind !== "user") continue
      if (textOf(item.content).trim().startsWith(GROUP_TURN_PREFIX)) continue
      return item.id
    }
    return ""
  }

  /** One role's turn: switch to its model, say who speaks, wait for the answer. */
  private async speakAsRole(
    id: string,
    turn: GroupTurn,
    round: number,
    document: string,
    kind: "speech" | "summary",
    template: string
  ): Promise<void> {
    announceGroupSpeaker(turn.name, round + 1)
    await this.switchSelectionModel(id, turn.model, turn.name)
    if (turn.effort !== null) {
      const session = this.holds(id) ? this.session(id) : undefined
      const configId = session === undefined ? null : this.effortConfigId(session.configOptions)
      const supported = this.supportedEfforts(id)
      if (configId !== null && supported !== null && supported.includes(turn.effort))
        await this.setConfig(id, configId, turn.effort)
    }
    if (turn.fastMode !== undefined) {
      const session = this.holds(id) ? this.session(id) : undefined
      const fast = session?.configOptions.find((entry) => entry.configId === "fast-mode")
      if (fast !== undefined && isBooleanOption(fast) && fast.currentValue !== turn.fastMode)
        await this.setConfig(id, "fast-mode", turn.fastMode)
    }
    const receipt = await this.promptWithTimeout(
      id,
      [{ type: "text", text: groupTurnPrompt(turn, round, document, kind, template) }],
      {
        display: [
          {
            type: "text",
            text:
              kind === "summary"
                ? `〔${turn.name}〕第 ${round + 1} 轮总结`
                : `〔${turn.name}〕第 ${round + 1} 轮`
          }
        ]
      }
    )
    await this.waitForTurn(id, receipt)
  }

  /**
   * Validates both role selections against the session's model catalog before a turn changes the
   * session. A split must never fall back to the current chat model or the other role's effort.
   *
   * Every model the session's picker offers is eligible — the native ChatGPT group and each
   * gateway alike; a role only needs its choice to still exist. A model that publishes no effort
   * ladder is allowed as well: that role runs on the model's own default and no effort is written,
   * so pinning one on it is the only rejected case.
   */
  private orchestrationRoles(
    id: string,
    orchestration: SessionOrchestration
  ): Record<"planner" | "worker", { model: string; effort: string | null; fastMode: boolean }> {
    const session = this.holds(id) ? this.session(id) : undefined
    if (session === undefined) throw new Error("分工模式会话不存在")
    const current = selectedModel(session.configOptions)
    if (!isNativeModel(session.configOptions, current)) throw new Error("当前会话模型不在模型列表中，无法使用分工模式")

    const catalog = nativeModelCatalog(session.configOptions)
    const resolve = (
      label: "规划模型" | "执行模型",
      role: { model: string; effort: string | null; fastMode?: boolean }
    ): { model: string; effort: string | null; fastMode: boolean } => {
      const model = catalog.find((entry) => entry.id === role.model)
      if (model === undefined) throw new Error(`${label}“${role.model}”不在当前会话的模型列表中`)
      if (role.effort !== null) {
        // Only a model that publishes its own ladder can carry a pinned effort.
        if (!hasUsableEffortCatalog(model)) throw new Error(`${label}“${model.id}”没有可用的 Effort 目录`)
        if (!model.efforts.includes(role.effort)) throw new Error(`${label}“${model.id}”不支持 Effort“${role.effort}”`)
      }
      return { model: model.id, effort: role.effort, fastMode: role.fastMode === true }
    }

    return {
      planner: resolve("规划模型", orchestration.planner),
      worker: resolve("执行模型", orchestration.worker)
    }
  }

  /**
   * Applies one role's model/effort pair.
   *
   * The order is part of the contract: switch the model, wait for the agent's new config, resolve
   * effort against that model's own catalog/default, write the effort option under its real id,
   * read both values back, then let the caller send the prompt. Any mismatch aborts the turn.
   * A model without a published effort ladder skips the effort half entirely.
   */
  private async applyOrchestrationRole(
    id: string,
    roleName: "planner" | "worker",
    role: { model: string; effort: string | null; fastMode?: boolean }
  ): Promise<void> {
    const label = roleName === "planner" ? "规划模型" : "执行模型"
    this.selectingRole.add(id)
    try {
      const session = await this.switchSelectionModel(id, role.model, label)

      const model = nativeModelCatalog(session.configOptions).find((entry) => entry.id === role.model)
      if (model === undefined) throw new Error(`${label}“${role.model}”不在当前会话的模型列表中`)
      if (!hasUsableEffortCatalog(model)) {
        if (role.effort !== null) throw new Error(`${label}“${model.id}”没有可用的 Effort 目录`)
        await this.applyRoleFastMode(id, label, role.model, role.fastMode === true)
        return
      }

      const effort = role.effort ?? model.defaultEffort
      if (effort === null) throw new Error(`${label}“${model.id}”没有声明默认 Effort`)
      if (!model.efforts.includes(effort)) throw new Error(`${label}“${model.id}”不支持 Effort“${effort}”`)

      await this.writeSelectionEffort(id, label, role.model, effort)
      await this.applyRoleFastMode(id, label, role.model, role.fastMode === true)
    } finally {
      this.selectingRole.delete(id)
    }
  }

  /**
   * Applies one role's acceleration flag and reads it back.
   *
   * Switching the model resets the session's `fast-mode`, so the flag is written after the model
   * and effort are in place. A role that asks for acceleration on a model without that config is
   * rejected loudly — silently running slower than configured is exactly the "设了却没生效" case.
   */
  private async applyRoleFastMode(
    id: string,
    label: string,
    model: string,
    desired: boolean
  ): Promise<void> {
    const session = this.holds(id) ? this.session(id) : undefined
    if (session === undefined) throw new Error("分工模式会话不存在")
    const option = session.configOptions.find((entry) => entry.configId === "fast-mode")
    if (option === undefined) {
      if (desired) throw new Error(`${label}“${model}”不支持加速模式`)
      return
    }
    if (!isBooleanOption(option)) throw new Error(`${label}“${model}”的加速模式配置不可用`)
    if (option.currentValue === desired) return
    await this.setConfig(id, "fast-mode", desired)
    const after = this.holds(id) ? this.session(id) : undefined
    const actual = after?.configOptions.find((entry) => entry.configId === "fast-mode")
    if (after === undefined || actual === undefined || !isBooleanOption(actual) || actual.currentValue !== desired)
      throw new Error(`分工配置回读不一致：${label}加速模式未${desired ? "开启" : "关闭"}`)
  }

  /** Captures the main conversation's selection before a role takes over the shared session. */
  private currentSelection(id: string): { model: string; effort: string | null; fastMode: boolean } | null {
    const session = this.holds(id) ? this.session(id) : undefined
    if (session === undefined) return null
    const model = selectedModel(session.configOptions)
    if (model === null) return null
    const fast = session.configOptions.find((entry) => entry.configId === "fast-mode")
    return {
      model,
      effort: this.selectedEffort(session.configOptions),
      fastMode: fast !== undefined && isBooleanOption(fast) ? fast.currentValue === true : false
    }
  }

  /** Switches the session model and confirms the agent actually applied it. */
  private async switchSelectionModel(id: string, model: string, label: string): Promise<Session> {
    const before = this.holds(id) ? this.session(id) : undefined
    if (before === undefined) throw new Error("分工模式会话不存在")
    if (selectedModel(before.configOptions) !== model) await this.setConfig(id, "model", model)

    const after = this.holds(id) ? this.session(id) : undefined
    if (after === undefined) throw new Error("分工模式会话不存在")
    if (selectedModel(after.configOptions) !== model)
      throw new Error(`分工配置回读不一致：${label}模型未切换到“${model}”`)
    return after
  }

  /** Writes one selection's effort under the config id the adapter exposes, then reads it back. */
  private async writeSelectionEffort(id: string, label: string, model: string, effort: string): Promise<void> {
    let session = this.holds(id) ? this.session(id) : undefined
    if (session === undefined) throw new Error("分工模式会话不存在")
    const configId = this.effortConfigId(session.configOptions)
    if (configId === null) throw new Error(`${label}“${model}”未暴露 Effort 配置`)
    const supported = this.supportedEfforts(id)
    if (supported === null || !supported.includes(effort)) throw new Error(`${label}“${model}”不支持 Effort“${effort}”`)

    await this.setConfig(id, configId, effort)

    session = this.holds(id) ? this.session(id) : undefined
    if (session === undefined) throw new Error("分工模式会话不存在")
    const actualModel = selectedModel(session.configOptions)
    const actualEffort = this.selectedEffort(session.configOptions)
    if (actualModel !== model || actualEffort !== effort)
      throw new Error(
        `分工配置回读不一致：${label}期望 ${model} + ${effort}，实际 ${actualModel ?? "无"} + ${actualEffort ?? "无"}`
      )
  }

  /** Restores the main selection after a role finishes, without writing an unsupported effort. */
  private async restoreMainSelection(
    id: string,
    selection: { model: string; effort: string | null; fastMode: boolean }
  ): Promise<void> {
    // The saved pair is authoritative here; the model's own default must not slip in between.
    this.selectingRole.add(id)
    try {
      await this.switchSelectionModel(id, selection.model, "主会话")
      const session = this.holds(id) ? this.session(id) : undefined
      if (session === undefined) throw new Error("分工模式会话不存在")
      if (selection.effort !== null) {
        const configId = this.effortConfigId(session.configOptions)
        const supported = this.supportedEfforts(id)
        if (configId === null || supported === null || !supported.includes(selection.effort))
          throw new Error(`主会话“${selection.model}”不支持 Effort“${selection.effort}”`)
        await this.writeSelectionEffort(id, "主会话", selection.model, selection.effort)
      }
      // A role may have turned acceleration on/off; hand the main conversation back with its own.
      const after = this.holds(id) ? this.session(id) : undefined
      const fast = after?.configOptions.find((entry) => entry.configId === "fast-mode")
      if (
        after !== undefined &&
        fast !== undefined &&
        isBooleanOption(fast) &&
        fast.currentValue !== selection.fastMode
      )
        await this.setConfig(id, "fast-mode", selection.fastMode)
    } finally {
      this.selectingRole.delete(id)
    }
  }

  /** Runs a role request and always returns the shared session to the user's main selection. */
  private async withMainSelection<T>(id: string, run: () => Promise<T>): Promise<T> {
    const selection = this.currentSelection(id)
    if (selection === null) throw new Error("分工模式会话没有当前模型")

    let outcome: { ok: true; value: T } | { ok: false; error: unknown }
    try {
      outcome = { ok: true, value: await run() }
    } catch (error) {
      outcome = { ok: false, error }
    }

    let restoreFailure: unknown = null
    try {
      await this.restoreMainSelection(id, selection)
    } catch (error) {
      restoreFailure = error
    }

    // Roles no longer write the session store; persist the real main selection once it is back.
    if (restoreFailure === null)
      this.saveSessionModel(id, {
        model: selection.model,
        effort: selection.effort,
        fastMode: selection.fastMode
      })

    const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
    if (!outcome.ok) {
      if (restoreFailure !== null)
        throw new Error(`${messageOf(outcome.error)}；主会话配置恢复失败：${messageOf(restoreFailure)}`)
      throw outcome.error
    }
    if (restoreFailure !== null) throw restoreFailure
    return outcome.value
  }

  /** Effort levels the session's current model declares, or null when it declares none. */
  private supportedEfforts(id: string): string[] | null {
    const session = this.holds(id) ? this.session(id) : undefined
    if (session === undefined) return null
    const configId = this.effortConfigId(session.configOptions)
    if (configId === null) return null
    const option = session.configOptions.find((entry) => entry.configId === configId)
    if (option === undefined || !isSelectOption(option)) return null
    const choices = isGroupedSelect(option.options) ? option.options.flatMap((group) => group.options) : option.options
    return choices.map((choice) => choice.value)
  }

  /** Resolves once the turn started by `messageId` has settled (or the safety timer fires). */
  private waitForTurn(id: string, messageId: string): Promise<void> {
    const ended = (): boolean => this.state.sessions[id]?.turnEndedAt[messageId] !== undefined
    if (ended()) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      let stop = (): void => {}
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        if (settled) return
        settled = true
        stop()
        if (timer !== null) clearTimeout(timer)
        resolve()
      }
      stop = this.store.subscribe(() => {
        if (ended()) finish()
      })
      timer = setTimeout(finish, 15 * 60 * 1000)
    })
  }

  /** Rejects `promise` after `ms` instead of leaving it pending forever. */
  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  /**
   * Sends a prompt but never lets a stuck agent turn freeze the whole app.
   *
   * Every chat shares one Codex agent. A turn that hangs on the model — a misconfigured
   * gateway, a dropped provider connection, a retired model — blocks that single process, so
   * the composer spins forever and other sessions stop responding because their `replay` waits
   * on the same agent. We watch this session for any progress; if it goes quiet for `IDLE_MS`
   * with no token or state change, we cancel the turn so the agent recovers and the rest of the
   * app becomes usable again.
   *
   * 90 seconds used to be the cutoff, which was shorter than a high-effort reasoning model's
   * first token: a `max` effort GPT turn routinely thinks for two minutes before it emits
   * anything, so the watchdog was cancelling healthy turns and the reader saw a bare 已停止.
   * Measured on a healthy `gpt-6.1-sol` thread, a single turn ran 853s and one gap between two
   * tool results was 309s — with reasoning effort only `low`. Worse, the ChatGPT backend answers
   * `server_is_overloaded` with `retry-after: 300` during capacity dips, and the engine sleeps
   * that long and retries without emitting anything, so a healthy turn can legitimately sit
   * quiet for five to ten minutes. The idle cutoff is therefore set to `IDLE_MS` — well past a
   * couple of those retry windows — while a dead socket is still reported earlier by the bridge
   * (600s without a byte) with a concrete reason. The hard cap exists so a turn that keeps
   * emitting events forever cannot pin the shared agent for an afternoon.
   */
  private promptWithTimeout(
    id: string,
    prompt: acp.ContentBlock[],
    options: PromptOptions | undefined
  ): Promise<string> {
    const IDLE_MS = 20 * 60_000
    const HARD_MS = 60 * 60_000
    const signature = (session: Session | undefined): string =>
      session === undefined ? "none" : `${session.state}:${session.items.length}:${session.clock}`
    return new Promise<string>((resolve, reject) => {
      let settled = false
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let hardTimer: ReturnType<typeof setTimeout> | null = null
      let unsubscribe: (() => void) | null = null
      let last = signature(this.state.sessions[id])
      const clear = (): void => {
        if (idleTimer !== null) clearTimeout(idleTimer)
        if (hardTimer !== null) clearTimeout(hardTimer)
        if (unsubscribe !== null) unsubscribe()
      }
      const fail = (message: string): void => {
        if (settled) return
        settled = true
        clear()
        // Free the shared agent so the rest of the app recovers.
        void this.cancel(id).catch(() => {})
        reject(new Error(message))
      }
      const armIdle = (): void => {
        if (idleTimer !== null) clearTimeout(idleTimer)
        idleTimer = setTimeout(
          () => fail("已 20 分钟没有任何输出，按超时停止本次请求。多为上游过载持续重试，可换模型或稍后重试。"),
          IDLE_MS
        )
      }
      unsubscribe = this.store.subscribe(() => {
        const next = signature(this.state.sessions[id])
        if (next !== last) {
          last = next
          armIdle()
        }
      })
      armIdle()
      hardTimer = setTimeout(() => fail("请求超时，已自动取消。"), HARD_MS)
      super.prompt(id, prompt, options).then(
        (receipt) => {
          if (settled) return
          settled = true
          clear()
          resolve(receipt)
        },
        (error) => {
          if (settled) return
          settled = true
          clear()
          // A turn that failed is over. Nothing is left to wait for, so the model picked next must
          // land at once instead of parking behind a turn that no longer exists — the capacity
          // failure that ends a turn is precisely when the user reaches for the picker.
          this.stoppedSessions.add(id)
          reject(error)
        }
      )
    })
  }

  /** The last assistant message of a session, used as the plan text. */
  private lastAssistantText(id: string): string {
    const items = this.state.sessions[id]?.items ?? []
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item.kind === "assistant") return textOf(item.content)
    }
    return ""
  }

  /**
   * The agent's actual answer from the turn that began at item index `since`.
   * Scheduled pushes and run records must carry what the agent wrote, not the ACP stop reason
   * (`end_turn`) or a session id. Empty assistant items (tool-only turns) are skipped so a
   * trailing tool call cannot turn the result into an empty string.
   */
  answerSince(id: string, since: number): string {
    const items = this.state.sessions[id]?.items ?? []
    for (let index = items.length - 1; index >= Math.max(0, since); index -= 1) {
      const item = items[index]
      if (item.kind === "assistant") {
        const text = textOf(item.content)
        if (text.trim() !== "") return text
      }
    }
    return ""
  }

  /** The session's current `mode` value, when the engine exposes one. */
  private sessionMode(id: string): string | null {
    const session = this.holds(id) ? this.session(id) : undefined
    const option = session?.configOptions.find((entry) => entry.configId === "mode")
    return option !== undefined && isSelectOption(option) && typeof option.currentValue === "string"
      ? option.currentValue
      : null
  }

  /** Whether the engine's `mode` option actually offers `value`. */
  private modeSupports(id: string, value: string): boolean {
    const session = this.holds(id) ? this.session(id) : undefined
    const option = session?.configOptions.find((entry) => entry.configId === "mode")
    if (option === undefined || !isSelectOption(option)) return false
    const choices = isGroupedSelect(option.options) ? option.options.flatMap((group) => group.options) : option.options
    return choices.some((choice) => choice.value === value)
  }

  protected override onConfigChanged(id: string, configId: string, response: acp.SetSessionConfigOptionResponse): void {
    super.onConfigChanged(id, configId, response)
    this.noteModel(this.session(id))
    const owner = this.configOwners.get(`${id}:${configId}`) ?? "main"
    this.configOwners.delete(`${id}:${configId}`)
    if (response.configOptions.some((option) => option.configId === configId && option.category === "model"))
      this.confirmModel(owner, this.session(id))
    // Persist an explicit effort change for this conversation. The agent normally calls this
    // `reasoning_effort`, while a few adapters use `effort`; `noteModel` persists either form,
    // and this direct branch keeps the intent explicit for adapters that omit model metadata.
    const effortConfigId = this.effortConfigId(response.configOptions)
    if (effortConfigId !== null && configId === effortConfigId) {
      const option = response.configOptions.find((entry) => entry.configId === configId)
      if (option && isSelectOption(option) && typeof option.currentValue === "string")
        this.saveSessionModel(id, { effort: option.currentValue })
    }
  }

  // ── Drafts ──

  /** Ownership changes are serialized independently of individual session operations. */
  private changeDraft<T>(owners: DraftOwner[], operation: () => Promise<T>): Promise<T> {
    const next = Promise.allSettled(
      owners.map((owner) => this.draftOperations.get(owner)).filter((operation) => operation !== undefined)
    ).then(operation)
    for (const owner of owners) this.draftOperations.set(owner, next)
    return next
  }

  prepareDraft(owner: DraftOwner, cwd: string, model: string | null = null): Promise<string> {
    const version = ++this.slotVersions[owner]
    return this.changeDraft([owner], async () => {
      const existing = Object.keys(this.state.draftSessions).find((id) => this.state.draftSessions[id] === owner)
      if (existing) await this.lifecycle.admission.pending(existing)
      if (
        existing &&
        this.session(existing).cwd === cwd &&
        (model === null || selectedModel(this.session(existing).configOptions) === model)
      ) {
        this.activateSlot(owner, existing, version)
        if (!this.session(existing).attached) await this.replayForOwner(existing, cwd, owner)
        if (model !== null) this.confirmModel(owner, this.session(existing))
        return existing
      }
      // The caller's explicit pick wins; otherwise a brand-new draft prefers the configured
      // default model and only falls back to the model the previous conversation used. Without
      // this the inherited model silently overrode the default and new chats kept opening on
      // whatever came before.
      const inherited = existing
        ? selectedModel(this.session(existing).configOptions)
        : (this.defaultModelOption?.() ?? this.savedModels[owner] ?? this.slotModels[owner])
      const id = await this.createNativeSession(cwd, await this.resolveModel(model ?? inherited), owner)
      try {
        // An unsent model change starts directly on the target provider. Resuming
        // the default-model thread creates a misleading model-change warning.
        if (existing && this.session(existing).cwd === cwd) {
          for (const option of this.session(existing).configOptions) {
            if (option.category === "model") continue
            const target = this.session(id).configOptions.find((entry) => entry.configId === option.configId)
            if (!target || target.currentValue === option.currentValue) continue
            if (isBooleanOption(option) && isBooleanOption(target)) {
              await this.setConfig(id, option.configId, option.currentValue)
            } else if (isSelectOption(option) && isSelectOption(target)) {
              const choices = isGroupedSelect(target.options)
                ? target.options.flatMap((group) => group.options)
                : target.options
              if (choices.some((choice) => choice.value === option.currentValue))
                await this.setConfig(id, option.configId, option.currentValue)
            }
          }
        }
        if (existing) await this.deleteEmptyDraft(existing)
      } catch (error) {
        await this.deleteEmptyDraft(id)
        throw error
      }
      this.activateSlot(owner, id, version)
      if (model !== null) this.confirmModel(owner, this.session(id))
      return id
    })
  }

  /** `discardDraft("main" | "chat")` drops that slot's draft; `discardDraft(id)` is the base client's form. */
  override discardDraft(owner: string): Promise<void> {
    if (owner !== "main" && owner !== "chat") return super.discardDraft(owner)
    return this.changeDraft([owner], async () => {
      for (const [id, current] of Object.entries(this.state.draftSessions))
        if (current === owner) await this.deleteEmptyDraft(id)
    })
  }

  transferDraft(id: string, owner: DraftOwner): Promise<void> {
    return this.changeDraft(["main", "chat"], async () => {
      if (!this.state.draftSessions[id] || this.state.draftSessions[id] === owner) return
      for (const [other, current] of Object.entries(this.state.draftSessions))
        if (current === owner) await this.deleteEmptyDraft(other)
      this.setApp((state) =>
        state.draftSessions[id] ? { draftSessions: { ...state.draftSessions, [id]: owner } } : {}
      )
    })
  }

  private deleteEmptyDraft(id: string): Promise<void> {
    return this.enqueueSession(id, async () => {
      if (!this.state.draftSessions[id]) return
      await this.delete(id)
      this.gatewayModels.delete(id)
    })
  }

  protected override onDraftMaterialized(id: string): void {
    super.onDraftMaterialized(id)
    this.setApp((state) => {
      const { [id]: _draft, ...draftSessions } = state.draftSessions
      return { draftSessions }
    })
    this.noteModel(this.session(id))
  }

  protected override onSessionDropped(id: string): void {
    super.onSessionDropped(id)
    this.gatewayModels.delete(id)
    this.setApp((state) => {
      const { [id]: _draft, ...draftSessions } = state.draftSessions
      const { [id]: _window, ...sessionWindows } = state.sessionWindows
      return { draftSessions, sessionWindows }
    })
  }

  // ── Fork with a counted title ──

  /** `fork(id, cwd, lastTurnId)` forks at a native turn; the options form is the base client's. */
  override fork(id: string, cwd: string, lastTurnId?: string | ForkOptions): Promise<string> {
    const options: ForkOptions =
      typeof lastTurnId === "object" ? lastTurnId : lastTurnId === undefined ? {} : { lastTurnId }
    return super.fork(id, cwd, options)
  }

  /** Runs inside the adapter's one-at-a-time fork lane: the title is counted against what is listed at that moment. */
  protected override async forkInternal(id: string, cwd: string, options: ForkOptions): Promise<string> {
    const indexes = await Promise.all([this.indexSessions(), this.indexSessions(undefined, true)])
    const known = [...indexes.flat(), ...this.state.sessionList, ...this.state.archivedSessions]
    const sourceTitle =
      (this.holds(id) ? this.session(id).title : null) ?? known.find((item) => item.sessionId === id)?.title
    const forked = await super.forkInternal(id, cwd, {
      ...options,
      meta: mergeMeta(modelHint(this.gatewayModels.get(id) ?? null), options.meta)
    })
    const title = sourceTitle ?? this.session(forked).title
    if (title)
      await this.renameSession(
        forked,
        forkTitle(
          title,
          known.flatMap((item) => (item.title ? [item.title] : []))
        )
      )
    return forked
  }

  protected override onForked(id: string, response: acp.ForkSessionResponse): void {
    super.onForked(id, response)
    this.noteModel(this.session(id))
  }

  protected override onReplayed(id: string, response: acp.ResumeSessionResponse): void {
    super.onReplayed(id, response)
    this.noteModel(this.session(id))
  }

  // ── Model memory per slot ──

  /** Desktop keeps explicit selections per chat slot, never in historical session bindings. */
  setModelSelections(models: Record<DraftOwner, string | null>): void {
    this.savedModels = { ...models }
    this.slotModels = { ...models }
  }

  onConfirmedModel(listener: (owner: DraftOwner, model: string) => void): () => void {
    this.confirmedModelListeners.add(listener)
    return () => this.confirmedModelListeners.delete(listener)
  }

  protected override onSessionChanged(session: Session): void {
    super.onSessionChanged(session)
    this.followModel("main", session)
    this.followModel("chat", session)
  }

  private followModel(owner: DraftOwner, session: Session): void {
    if (this.slotTargets[owner] !== session.id || !session.attached || session.restoring) return
    const model = selectedModel(session.configOptions)
    if (model !== null) {
      this.slotModels[owner] = model
      return
    }
    // A conversation whose model was never explicitly chosen would otherwise fall back to the
    // engine default (native GPT) the instant the user switches to it, because the model menu
    // reads the session's own config. Inherit the slot's last confirmed model so the selection
    // stays put across conversations instead of drifting to GPT.
    const fallback = this.savedModels[owner] ?? this.slotModels[owner]
    if (fallback !== null && fallback !== undefined) {
      void this.setConfig(session.id, "model", fallback).catch(() => {})
    }
  }

  private activateSlot(owner: DraftOwner, id: string, version: number): void {
    if (this.slotVersions[owner] !== version) return
    this.bindSlot(owner, id)
    this.followModel(owner, this.session(id))
  }

  private bindSlot(owner: DraftOwner, id: string): void {
    // A conversation is handed between surfaces, never displayed in both at once.
    const other = owner === "main" ? "chat" : "main"
    if (this.slotTargets[other] === id) {
      this.slotTargets[other] = null
      ++this.slotVersions[other]
    }
    this.slotTargets[owner] = id
    this.setApp((state) => ({
      sessionWindows: { ...state.sessionWindows, [id]: owner }
    }))
  }

  private confirmModel(owner: DraftOwner, session: Session): void {
    const model = selectedModel(session.configOptions)
    if (model === null) throw new Error("Model selection did not return the current model")
    this.followModel(owner, session)
    this.savedModels[owner] = model
    // Remember the chosen model (and current effort) for this conversation so a later relaunch
    // can restore it instead of drifting to the provider default. Effort and acceleration are only
    // pinned when they differ from the model row: everything else is re-derived on open, so a
    // changed 设置 → 可用模型 row reaches the conversation instead of being frozen here.
    const fastOption = session.configOptions.find((entry) => entry.configId === "fast-mode")
    const effort = this.selectedEffort(session.configOptions)
    const fastMode = fastOption !== undefined && isBooleanOption(fastOption) ? fastOption.currentValue === true : false
    const tableEffort = this.defaultEffortForModel(session, model)
    const tableFast = modelFastModeFor(model)
    if (!this.selectingRole.has(session.id) && !this.orchestrating.has(session.id))
      this.saveSessionModel(session.id, {
        model,
        effort,
        effortExplicit: effort !== null && effort !== tableEffort,
        fastMode,
        fastExplicit: fastOption !== undefined && isBooleanOption(fastOption) && fastMode !== tableFast
      })
    for (const listener of this.confirmedModelListeners) listener(owner, model)
  }

  private resolveModel(model: string | null): Promise<string | null> {
    return this.resolveModelOption ? this.resolveModelOption(model) : Promise.resolve(model)
  }

  onSessionModel(listener: SessionModelListener): () => void {
    this.modelListeners.add(listener)
    return () => this.modelListeners.delete(listener)
  }

  /** Reads the session's selected model and tells listeners whether it is a gateway model. */
  private noteModel(session: Session): void {
    const modelId = selectedModel(session.configOptions)
    if (modelId === null) return
    // Only the model is seeded from the agent's own state. Its effort/acceleration are whatever the
    // engine happened to open with, not a user choice: recording them made the first value a chat
    // ever saw (often a global Low/Max) stick forever. `confirmModel` writes them when the user
    // actually picks, and `restoreSessionModel` otherwise follows the model row.
    if (!this.selectingRole.has(session.id)) this.saveSessionModel(session.id, { model: modelId })
    const option = session.configOptions.find((entry) => entry.category === "model" && entry.type === "select")
    const isGateway =
      option !== undefined &&
      isSelectOption(option) &&
      option.options.some(
        (group) =>
          "groupId" in group &&
          group.groupId !== NATIVE_MODEL_GROUP.id &&
          group.options.some((model) => model.value === modelId)
      )
    if (isGateway) this.gatewayModels.set(session.id, modelId)
    else this.gatewayModels.delete(session.id)
    if (!this.state.draftSessions[session.id])
      for (const listener of this.modelListeners) listener(session.id, modelId, isGateway)
  }

  /**
   * Re-applies the persisted model/effort for a session once its config is available.
   *
   * Runs from `noteModel` (replay, materialize, fork, config change) but only writes when the
   * saved value differs from what the agent currently reports, so it settles after one write and
   * never fights an explicit selection made in this launch. A saved model that no longer resolves
   * against the applied providers is skipped rather than replayed, so a removed model cannot make
   * the resume fail.
   */
  private restoreSessionModel(
    session: Session,
    saved:
      | {
          model: string | null
          effort: string | null
          fastMode?: boolean
          effortExplicit?: boolean
          fastExplicit?: boolean
        }
      | undefined = this.sessionModels.get(session.id)
  ): void {
    if (!saved || this.restoring.has(session.id)) return
    // A chat that never left the model row's own defaults is not pinned to the values it opened
    // with; the row can change and the next open follows it. Only a real deviation — recorded as
    // `effortExplicit` / `fastExplicit` — is replayed verbatim.
    const desiredFor = (target: Session): { effort: string | null; fast: boolean | undefined } => {
      const model = selectedModel(target.configOptions)
      const effort =
        saved.effortExplicit === true
          ? saved.effort
          : model === null
            ? saved.effort
            : (this.defaultEffortForModel(target, model) ?? saved.effort)
      const fast = saved.fastExplicit === true ? saved.fastMode : model === null ? saved.fastMode : modelFastModeFor(model)
      return { effort, fast }
    }
    const fastOptionOf = (target: Session) => target.configOptions.find((entry) => entry.configId === "fast-mode")
    const desired = desiredFor(session)
    const currentFast = fastOptionOf(session)
    const fastDiffers =
      desired.fast !== undefined &&
      currentFast !== undefined &&
      isBooleanOption(currentFast) &&
      currentFast.currentValue !== desired.fast
    const modelDiffers = saved.model !== null && saved.model !== selectedModel(session.configOptions)
    const effortDiffers = desired.effort !== null && desired.effort !== this.selectedEffort(session.configOptions)
    if (!modelDiffers && !effortDiffers && !fastDiffers) return
    this.restoring.add(session.id)
    const apply = async (): Promise<void> => {
      if (modelDiffers) {
        const resolved = await this.withTimeout(this.resolveModel(saved.model as string), 15_000, "resolveModel").catch(
          () => null
        )
        const latest = this.holds(session.id) ? this.session(session.id) : session
        if (resolved !== null && resolved !== selectedModel(latest.configOptions))
          await this.withTimeout(this.setConfig(session.id, "model", resolved), 20_000, "setConfig(model)").catch(
            () => {}
          )
        // 切模型会重置 effort 阶梯与 fast-mode 开关；让出一次事件循环，等切后 config options 落到
        // store 再读取，避免按旧模型的档位判断（与 applyEffortForModel 的守卫一致）。
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
      // Model changes reset reasoning effort. Read the post-switch session rather than reusing a
      // pre-switch comparison: it may have matched before the switch and become the model default
      // afterwards. Never invent a level the target model does not expose.
      const latest = this.holds(session.id) ? this.session(session.id) : session
      const wanted = desiredFor(latest)
      const effortConfigId = this.effortConfigId(latest.configOptions)
      const supported = this.supportedEfforts(session.id)
      if (
        wanted.effort !== null &&
        wanted.effort !== this.selectedEffort(latest.configOptions) &&
        effortConfigId !== null &&
        supported?.includes(wanted.effort)
      )
        await this.withTimeout(
          this.setConfig(session.id, effortConfigId, wanted.effort),
          20_000,
          "setConfig(effort)"
        ).catch(() => {})
      // Acceleration last: a model switch may reset it, and a saved deviation outranks the row.
      const afterFast = this.holds(session.id) ? this.session(session.id) : session
      const fast = afterFast.configOptions.find((entry) => entry.configId === "fast-mode")
      if (wanted.fast !== undefined && fast !== undefined && isBooleanOption(fast) && fast.currentValue !== wanted.fast)
        await this.withTimeout(
          this.setConfig(session.id, "fast-mode", wanted.fast),
          20_000,
          "setConfig(fast-mode)"
        ).catch(() => {})
    }
    void apply()
      .catch(() => {})
      .finally(() => this.restoring.delete(session.id))
  }
}
