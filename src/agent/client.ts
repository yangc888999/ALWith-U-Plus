import { invoke, isTauri } from "@tauri-apps/api/core"
import { info } from "@tauri-apps/plugin-log"
import { toast } from "sonner"

import { companyModelConfig } from "@/lib/company-model-config"
import { isEnterpriseModel } from "@/features/auth/enterprise-providers"
import i18n from "@/lib/i18n"
import { modelFastModeFor } from "@/lib/model-fast-mode"
import {
  canonicalModelSelection,
  modelDisplayId,
  modelVendorId
} from "@/lib/model-identity"

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
  type ReplayScope,
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
import { isThreadNotLoadedError } from "@/lib/agent-errors"
import { getQueueSendMode } from "@/lib/chat-display-preferences"
import { pendingPlanFor, setPendingPlan, type PendingPlan } from "@/lib/pending-plan"
import {
  GROUP_TURN_PREFIX,
  groupTurnPrompt,
  type FinalSummarySpeaker,
  type GroupPromptFraming,
  type GroupRoundRecord,
  type GroupSpeechRecord,
  type GroupTurn
} from "@/agent/group-turns"
import { announceGroupSpeaker, clearGroupControl, groupControlFor, patchGroupDiscussion, setGroupPaused, subscribeGroupControl } from "@/lib/group-runtime"
import { type SummaryMode } from "@/lib/group-preferences"
import { rememberAutomationSessionRow, replaceAutomationSessionRows } from "@/lib/automation-sessions"
import { groupSessionKind, rememberGroupSessionRow, replaceGroupSessionRows } from "@/lib/group-sessions"
import { isModelRetired, retireModel, reviveModel } from "@/lib/retired-models"
import { beginQueuedPrompt, cancelQueuedPrompt, endQueuedPrompt, QueueCancelledError } from "@/lib/queued-prompt"
import { sandboxAllows, sandboxCapabilities, sandboxMode, sandboxSettings } from "@/lib/sandbox-preference"
import {
  orchestrationAllowedFor,
  orchestrationFor,
  setOrchestration,
  type SessionOrchestration
} from "@/lib/session-orchestration"

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
  resolveModel?: (model: string | null, purpose: "session" | "draft") => Promise<string | null>
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
  /** Account revocation is independent of transient turn errors and mirrored to auxiliary windows. */
  accountModelRecovery: Record<string, boolean>
  /** Window ownership survives switching the visible conversation; never persisted. */
  sessionWindows: Record<string, DraftOwner>
  /** Only drafts created by this connection are eligible for automatic cleanup. */
  draftSessions: Record<string, DraftOwner>
}

/** Stop reason published when an account-owned model was revoked and the chat needs a new pick. */
const ACCOUNT_MODEL_REQUIRED = "account_model_required"

/**
 * Which vendor a model id belongs to.
 *
 * A model name does not identify a model: 哈基米 is a reseller, so its catalog carries
 * `gpt-6.1-sol` under the same words as the native one, and the two sit in different quota pools —
 * switching between them looks like a no-op in the picker but moves the request to another vendor
 * (2026-11-19). Three spellings reach this file for the same fact: the picker's
 * `gateway:<provider>:<model>`, the `<provider>/<model>` Codex hands the bridge, and a bare name
 * for one of Codex's own models. All three resolve to one vendor here.
 */
export function modelVendor(model: string): string {
  return modelVendorId(model)
}

/** `_meta.alwith.model`: open the thread on that gateway model (codex-acp-v2 catalog mode). */
function modelHint(model: string | null): Record<string, unknown> | undefined {
  return model === null ? undefined : { alwith: { model: canonicalModelSelection(model) } }
}

const selectedModel = (options: acp.SessionConfigOption[]): string | null => {
  const value = selectedModelId(options)
  return value === null ? null : canonicalModelSelection(value)
}

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
 * How many times one parked choice may be re-attempted before the app gives up on it.
 *
 * 「本轮后切换」 parked on a busy rejection and retried every 2 seconds forever: the local session
 * said idle, the adapter kept answering `Wait for the current turn before changing its provider`,
 * and each cycle re-parked itself. One real log read 90 minutes of that, and because the log is a
 * ring buffer it also erased every other symptom in the window. A choice that cannot apply is not
 * worth a permanent timer — try a few times with backoff, then say so and drop it.
 */
const PENDING_MODEL_MAX_ATTEMPTS = 5

/** First retry delay after a refused switch; doubles per attempt up to `PENDING_MODEL_RETRY_MS * 8`. */
const PENDING_MODEL_BACKOFF_MS = 2_000

/**
 * How long to wait before the next attempt, given how many have already been refused.
 *
 * Pulled out of the retry path so the ladder itself can be asserted without waiting on timers.
 */
export function parkedRetryDelay(attempts: number): number {
  const step = Math.max(1, Math.floor(attempts))
  return Math.min(PENDING_MODEL_BACKOFF_MS * 2 ** (step - 1), PENDING_MODEL_RETRY_MS * 8)
}

/**
 * How long a role waits for the previous turn's terminal update before writing its own model.
 *
 * The roster awaits the turn anyway, so this only covers the beat between the agent accepting the
 * end of a turn and the store publishing it. Waiting longer buys nothing; the write is attempted
 * either way and a refusal costs that one role, never the discussion.
 */
const ROLE_SWITCH_IDLE_MS = 3_000


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

/**
 * The one human explanation for a replay/open refusal. Callers own the toast; this function only
 * classifies the engine text so the same failure cannot be shown once here and once at the surface.
 */
export function explainReplayFailure(
  message: string,
  options: { internalError?: boolean } = {}
): string | null {
  const deletedProvider =
    /This chat uses model provider [`“"]([^`”"]+)[`”"], which is (?:no longer configured|not found)/.exec(message)
  if (deletedProvider !== null) {
    const provider = deletedProvider[1]
    return i18n.t(provider === "alwith" ? "chat.routerRecovering" : "chat.providerDeleted", { provider })
  }
  const providerChanged =
    /Cannot change this thread's model provider from [`“"]([^`”"]+)[`”"] to [`“"]([^`”"]+)[`”"]/i.exec(
      message
    )
  if (providerChanged !== null)
    return i18n.t("chat.providerLocked", { from: providerChanged[1], to: providerChanged[2] })
  const providerConflict = /This chat uses (.+?), but your current provider is (.+?)\./.exec(message)
  if (providerConflict !== null)
    return i18n.t("chat.providerLocked", { from: providerConflict[1], to: providerConflict[2] })
  if ((options.internalError !== false && /internal error/i.test(message)) || replayRefusal(message))
    return i18n.t("chat.historyUnreplayable")
  return null
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
 *
 * A tombstone is a **hint**, not a verdict. Filtering every retired id out of the candidate set
 * at once made one transient refusal cascade: a couple of failures left `usable` empty, so the
 * next prompt threw instead of switching, and every sibling model looked dead for a week. Prefer
 * un-retired ids, but never let the hints empty the list.
 */
function fallbackModel(options: acp.SessionConfigOption[], unsupported: string): string | null {
  const option = options.find((entry) => entry.category === "model" && entry.type === "select")
  if (option === undefined || !isSelectOption(option)) return null
  const all = modelValues(options)
  const preferred = all.filter((value) => value !== unsupported && !isModelRetired(value))
  const usable = preferred.length > 0 ? preferred : all.filter((value) => value !== unsupported)
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

/**
 * 引擎会在正文里写一条「模型已从 A 更改为 B」的元信息，A/B 用的是**内部 id**：
 * `gateway:custom-637573746f6d5f…:deepseek-V4.1-flash`。那串十六进制是 provider 的编码，
 * 读者既读不出是什么模型，也会误以为是乱码（2026-11-17 现场）。
 *
 * 这里只做**显示层**规范化，不改任何落盘内容：
 *   * `gateway:<runtime>:<model>` → `<model>`（model 里的 %XX 解码，`{max}` 这类 effort 后缀保留）
 *   * 句子本身改写成一行可读说明，末尾括号里的「新会话才会使用…」不再重复。
 */
export function readableModelId(value: string): string {
  const trimmed = value.trim()
  const decoded = modelDisplayId(trimmed)
  // `{max}` / `{high}` 是 effort 标记，保留它（读者靠它区分同名的两档）。
  return decoded.replace(/%7B/g, "{").replace(/%7D/g, "}")
}

/** 把正文里的模型切换元信息换成可读的一行；其余文本原样返回。 */
export function readableModelSwitchNotes(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const zh = line.match(/(?:模型已从|已从)\s*(.+?)\s*更改为\s*(.+?)\s*(?:（[^）]*）|\([^)]*\))?\s*$/)
      if (zh !== null) return `—— 模型切换到 ${readableModelId(zh[2] ?? "")}，下次会话开始生效 ——`
      const en = line.match(/(?:model\s+)?switched from\s+(.+?)\s+to\s+(.+?)\s*(?:\([^)]*\))?\s*$/i)
      if (en !== null) return `—— switched to ${readableModelId(en[2] ?? "")}; takes effect next session ——`
      return line
    })
    .join("\n")
}

export function withoutModelSwitchNotes(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      // The engine appends its own note after a model change, naming both models and explaining
      // that the persona only changes on the next session. Name the destination and the timing;
      // the old name is noise — the reader just made the switch and knows what it was.
      const zh = line.match(
        /(?:模型已从|已从)\s*(.+?)\s*更改为\s*(.+?)\s*(?:（[^）]*）|\([^)]*\))?\s*$/
      )
      if (zh !== null) return `—— 模型切换到 ${zh[2]?.trim() ?? ""} 下次会话开始生效 ——`
      const en = line.match(/(?:model\s+)?switched from\s+(.+?)\s+to\s+(.+?)\s*(?:\([^)]*\))?\s*$/i)
      if (en !== null) return `—— switched to ${en[2]?.trim() ?? ""}; takes effect next session ——`
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
  private readonly draftDirectoryIntents = new Map<string, string | undefined>()
  private readonly draftOperations = new Map<DraftOwner, Promise<unknown>>()
  /** Attached session selections, retained for forks and event-stream repair only. */
  private readonly gatewayModels = new Map<string, string>()
  /** Monotonic revocation/recovery counters so a stale recovery cannot clear a newer revocation. */
  private readonly accountRevocations = new Map<string, number>()
  private readonly accountRecoveries = new Map<string, number>()
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
  /**
   * Sessions where a role — a 分工 planner/worker or a 拉会 speaker — is writing its own model,
   * effort and acceleration, not the reader choosing one.
   *
   * A depth counter rather than a set: the scopes nest (a split wraps its whole planner turn, a
   * speaker wraps the model, effort and fast-mode writes that follow the switch), and a set would
   * drop the outer guard the moment the inner one finished — letting the role's model be saved as
   * this conversation's own choice, which is then restored on the next launch and read as the
   * vendor the reader is on.
   */
  private readonly roleScopes = new Map<string, number>()
  /** Live orchestration phase per session, so the status row can name the active role. A running
   *  orchestrated turn is always planner or worker, but the session's selected id is only switched
   *  part-way through, so reading it back gives the wrong role until the swap lands. */
  private readonly orchestrationPhase = new Map<string, "planner" | "worker">()
  private readonly orchestrationPhaseListeners = new Set<() => void>()
  /** Which slot asked for a configuration write, so a confirmed model lands in that slot's memory. */
  private readonly configOwners = new Map<string, DraftOwner>()
  /** Which slot is opening a session, so its replay resolves that slot's model once the replay has started. */
  private readonly openingOwners = new Map<string, DraftOwner>()
  /**
   * Replays that failed for a session in a slot, keyed `<owner>:<session>`.
   *
   * A refused replay publishes `restoring: false` so the surface can leave the spinner. A view that
   * reads "not restoring, not attached" as "try again" then replays on every store tick — that is
   * the loop a refused rollout produced on 2026-11-17: 62 replays in two minutes, each one a fresh
   * `session/new`, each one printing another toast. The rollout on disk cannot become replayable by
   * being asked again, so the same slot asking for the same session again gets the failure it
   * already knows. Leaving the session (another session in that slot, or another slot) clears the
   * entry — which is exactly the "reopen the chat" the card tells the reader to do.
   */
  private readonly replayFailures = new Map<string, string>()
  /** Slots whose next replay is an explicit reader Retry: the refusal is answered once more, for real. */
  private readonly replayRetryOwners = new Set<DraftOwner>()
  private readonly resolveModelOption: ClientOptions["resolveModel"]
  private readonly defaultEffortOption: ClientOptions["defaultEffort"]
  private readonly defaultModelOption: ClientOptions["defaultModel"]
  private readonly defaultFastModeOption: ClientOptions["defaultFastMode"]

  constructor(openPort: () => Promise<RuntimeClient<Launch>>, options: ClientOptions) {
    const { resolveModel, defaultEffort, defaultModel, defaultFastMode, ...base } = options
    super(
      openPort,
      { info: { name: "alwith-u", version: "0.1.0" }, ...base },
      { sessionWindows: {}, draftSessions: {}, accountModelRecovery: {} }
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
   * silently denied — the user still sees the request and can allow it once. The adapter bundles
   * network and every file path into one additional-permission request, so the whole composite is
   * pre-approved only when every capability it asks for is granted; otherwise the visible dialog
   * stays. `input.permissions` is the object itself, not the request or its params — passing either
   * of those yields no capabilities and never pre-approves.
   */
  private prefillSandboxApprovals(): void {
    this.requests.onReceived((request) => {
      if (request.kind !== "permission") return
      const settings = sandboxSettings()
      if (!settings.enabled) return
      const session = this.state.sessions[request.sessionId]
      const params = request.params as { subject?: { toolCall?: { input?: { permissions?: unknown } } } }
      const capabilities = sandboxCapabilities(params.subject?.toolCall?.input?.permissions, session?.cwd ?? null)
      if (!sandboxAllows(capabilities, settings)) return
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
          model: value.model == null ? null : canonicalModelSelection(value.model),
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
    // Nothing a role writes is the reader's choice. Guarding here as well as at the call sites
    // keeps one forgotten branch from persisting a speaker's model as this chat's own.
    if (this.inRoleScope(id)) return
    const normalized =
      patch.model === undefined || patch.model === null
        ? patch
        : { ...patch, model: canonicalModelSelection(patch.model) }
    const current = this.sessionModels.get(id) ?? { model: null, effort: null }
    const next = { ...current, ...normalized }
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
   * Whether a role currently owns this conversation's config.
   *
   * Both special chat modes run several models through one session: 分工 swaps planner/worker per
   * turn, 拉会 swaps a speaker per role. Everything they write is that role's, never the reader's
   * selection, and it must not be able to end a turn the way a user's pick may.
   */
  private inRoleScope(id: string): boolean {
    return (this.roleScopes.get(id) ?? 0) > 0 || this.orchestrating.has(id)
  }

  /** Marks the start of one role-owned stretch. Nesting is counted, so an inner scope cannot end it. */
  private enterRoleScope(id: string): void {
    this.roleScopes.set(id, (this.roleScopes.get(id) ?? 0) + 1)
  }

  /** Ends one role-owned stretch; the scope closes only when the outermost one ends. */
  private leaveRoleScope(id: string): void {
    const depth = this.roleScopes.get(id) ?? 0
    if (depth <= 1) this.roleScopes.delete(id)
    else this.roleScopes.set(id, depth - 1)
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
    // The account-managed (enterprise) model's default thinking level is configured on the 大模型
    // page and stored in `companyModelConfig`. It is the conversation's authoritative default,
    // independent of whether the engine catalog forwards the level into the session metadata. When
    // that metadata is absent the chat would otherwise fall back to the global default and silently
    // ignore this setting — the bug this branch fixes. The level is one of low/high/max and is
    // always a supported effort for the enterprise ladder, so the callers' `includes` guard is safe.
    if (isEnterpriseModel(model)) {
      try {
        // Always a supported level (low/high/max) for the enterprise ladder, so the callers'
        // `includes` guard is safe. Falls through only if storage is unavailable here.
        return companyModelConfig().reasoningLevel
      } catch {
        // localStorage unavailable (some test sandboxes); fall through to catalog metadata.
      }
    }
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
    if (this.restoring.has(id) || this.inRoleScope(id)) return
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
    if (this.inRoleScope(id)) return
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
    // `groupSessionKind`, not `groupByDirectory` alone: a meeting whose group record has not been
    // written yet — or whose folder moved / was healed / still points at the Groups root — used to
    // fail the record match and stay in `sessionList`, where the sidebar rendered it as a project.
    const kind = groupSessionKind(summary)
    if (kind === "group") {
      rememberGroupSessionRow(summary)
      return true
    }
    if (kind === "automation") {
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
    // The same one answer `divertSessionRow` uses: a meeting is a meeting whether or not its group
    // record exists yet, otherwise a restored history never leaves 项目.
    const groupRows = rows.filter((row) => groupSessionKind(row) === "group")
    const automationRows = rows.filter((row) => groupSessionKind(row) === "automation")
    const kept = rows.filter((row) => groupSessionKind(row) === "project")
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
    if (owner !== null) {
      this.draftDirectoryIntents.set(id, cwd)
      this.setApp((state) => ({
        draftSessions: { ...state.draftSessions, [id]: owner }
      }))
    }
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
    // A rollout Codex already refused is refused again: answer with that failure instead of
    // starting another replay. Without this the surface re-asks on every store tick and the app
    // spins on a conversation that needs the reader to reopen it (or switch its model).
    const refused = this.replayFailures.get(`${owner}:${id}`)
    if (refused !== undefined) {
      if (this.replayRetryOwners.delete(owner)) this.replayFailures.delete(`${owner}:${id}`)
      else {
        if (existing !== undefined) this.publishSession({ ...existing, cwd, restoring: false })
        const explanation = explainReplayFailure(refused)
        throw explanation !== null ? new Error(explanation) : new Error(refused)
      }
    }
    await this.replayForOwner(id, cwd, owner)
  }

  /**
   * The error card's 「重试」: the next replay this slot asks for is a real attempt, even if the
   * same conversation was refused before. The breaker exists to stop *automatic* re-asks (store
   * ticks, effect re-runs); an explicit press is the reader doing exactly what the card asks, and
   * answering it with the cached failure made the button look dead (2026-11-17).
   */
  retryReplay(owner: DraftOwner): void {
    this.replayRetryOwners.add(owner)
  }

  /** A replay a slot asked for resolves the slot's model after the replay has started, so the session shows as restoring meanwhile. */
  private async replayForOwner(id: string, cwd: string, owner: DraftOwner): Promise<void> {
    // A refusal is final for this slot: `prepareDraft` replays whenever the session is not attached,
    // so a refused rollout — plus one store change — is an endless replay loop on one conversation
    // (2026-11-17: 62 replays in two minutes, each printing the same toast). Answer with the failure
    // it already produced instead. `bindSlot` clears the entry when the slot moves to another chat,
    // which is the reopen the card asks for.
    const slot = `${owner}:${id}`
    const refused = this.replayFailures.get(slot)
    if (refused !== undefined) {
      // The card's 「重试」 is an explicit request to try again, not a store tick: honour it once.
      // Without this the breaker answered the retry with the cached failure and the button looked
      // dead (2026-11-17: "点了压根没反应"). Automatic re-asks still get the cached answer.
      if (this.replayRetryOwners.delete(owner)) this.replayFailures.delete(slot)
      else {
        if (this.holds(id)) this.publishSession({ ...this.session(id), cwd, restoring: false })
        const explanation = explainReplayFailure(refused)
        throw explanation !== null ? new Error(explanation) : new Error(refused)
      }
    }
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
      let currentModelFallbackAttempted = false
      // A replay that never settles looks exactly like a slow one until it is far too late, and the
      // reader is left on 「正在恢复聊天」 with no way out. Bound it: past this the session is
      // published as not-restoring and the error explains itself. A large thread replays in a few
      // seconds, so two minutes only ever fires on a genuine stall.
      const deadline = () =>
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("replay timed out")), 120_000)
        })
      for (let attempt = 0; ; attempt += 1) {
        try {
          await Promise.race([this.replay(id, cwd, options), deadline()])
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
          // If the saved provider/model is gone or differs from the current picker, retry without
          // the historical hint. This lets Codex replay through the currently configured model
          // instead of failing solely because the conversation was recorded elsewhere.
          if (!currentModelFallbackAttempted && (providerMismatch || /This chat uses|no longer configured|not found/i.test(text))) {
            currentModelFallbackAttempted = true
            try {
              const current = this.holds(id) ? selectedModel(this.session(id).configOptions) : null
              if (current !== null && current !== saved?.model) {
                await this.replay(id, cwd, { meta: modelHint(current) })
                break
              }
            } catch {
              // Continue to the existing repair and guidance paths.
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
          // Do not toast here: `open()` has many callers, and the caller that shows the failed
          // open already turns this thrown error into one toast. Toasting here as well produced
          // two stacked notices — one friendly, one the raw ACP error (2026-11-22).
          const explanation = explainReplayFailure(text)
          // Whatever happened, the surface must not keep a spinner up: this replay is over, so
          // say so before the error travels.
          this.publishSession({ ...this.session(id), cwd, restoring: false })
          // Remember the refusal for this slot so the next attempt cannot start another replay.
          // Only the reason the agent gave is kept: it is what the card and the toast show.
          this.replayFailures.set(slot, text)
          throw explanation !== null ? new Error(explanation) : error
        }
      }
    } finally {
      if (this.openingOwners.get(id) === owner) this.openingOwners.delete(id)
    }
    // The replay landed: this conversation is open in this slot again, so a stale refusal must not
    // outlive it (a model switch can make the same rollout replayable).
    this.replayFailures.delete(slot)
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
    const stored =
      draft && owner !== undefined
        ? this.slotModels[owner]
        : (this.sessionModels.get(id)?.model ??
          (session ? selectedModel(session.configOptions) : null) ??
          this.gatewayModels.get(id) ??
          null)
    // A rollout can carry a legacy bare external id. Resolve it through the same identity API as
    // every picker before it becomes the thread's model hint; otherwise the Router receives a
    // native-looking name and sends it to ChatGPT.
    const model = stored === null ? null : await this.resolveModel(stored)
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
  /** Consecutive refusals per conversation, and when the next attempt is allowed (see the cap above). */
  private readonly parkedAttempts = new Map<string, number>()
  private readonly parkedRetryAt = new Map<string, number>()
  /**
   * Chats whose last user gesture was Stop, so the next model pick is applied instead of parked.
   *
   * A set, not a timestamp: the question is "is there still a turn to wait for?", and the answer is
   * decided by what happened since the stop — any new turn clears the entry in `prompt`. A clock
   * would have to guess at that, and a chat left alone for ten minutes is exactly as finished as
   * one left for ten seconds.
   *
   * The clocks below are only used once that promise has settled. They are change detectors, not
   * heartbeats: a live turn can stream for minutes without moving either one, so they must never
   * outvote an in-flight prompt.
   */
  private readonly stoppedSessions = new Set<string>()
  /**
   * Sessions whose prompt promise has not settled yet — the only real live-turn heartbeat.
   *
   * The Runtime's `version` is monotonic per *state*, not per activity: it moves when the state or
   * the interruption changes and deliberately stays put while a turn streams in one state. The
   * session `clock` moves when a new timeline item is created, not while text chunks stream into
   * an existing one. Neither can tell a healthy turn sitting inside a long tool call from a turn
   * that died with the engine. The prompt promise can: it settles on any engine failure and is
   * bounded by the 20-minute idle / 60-minute hard watchdog below.
   */
  private readonly promptInFlight = new Map<string, number>()
  /** The last time a session's Runtime run row actually changed (see `runtimeRunningFresh`). */
  private readonly runChanges = new Map<string, { signature: string; at: number }>()
  /** The last time a session's own `clock` moved (see `sessionClockFresh`). */
  private readonly sessionClockChanges = new Map<string, { clock: number; at: number }>()

  private beginPrompt(id: string): void {
    this.promptInFlight.set(id, (this.promptInFlight.get(id) ?? 0) + 1)
  }

  private endPrompt(id: string): void {
    const remaining = (this.promptInFlight.get(id) ?? 1) - 1
    if (remaining > 0) this.promptInFlight.set(id, remaining)
    else this.promptInFlight.delete(id)
  }

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
    // An unsettled prompt is a live turn by definition, whatever the two change-detector clocks
    // say. Without this guard a healthy turn silent for five minutes inside a tool call (or the
    // backend's `retry-after: 300` sleep) reads stalled, and the parked-switch watcher lands a
    // `setConfig` plus `cancel` in the middle of its stream — "stream disconnected".
    if (this.promptInFlight.has(id)) return true
    const session = this.state.sessions[id]
    // A turn that died with an error often never delivers its final update, leaving `state` at
    // "running" forever. Trusting that flag unconditionally parked every later model pick behind
    // a turn that would never settle — one failed model made the entire conversation unusable on
    // every other model. So a ghost turn is released once **both** clocks have gone stale.
    //
    // It must be both: a healthy turn can sit silent for minutes inside a single tool call or an
    // upstream `retry-after` sleep, during which the session clock does not move. Reading only
    // that clock declares a live turn idle, and the parked-switch watcher then lands a `setConfig`
    // plus `cancel` in the middle of its stream — "stream disconnected before completion".
    if (session !== undefined && session.state !== "idle")
      return this.sessionClockFresh(id, session.clock) || this.runtimeRunningFresh(id)
    return this.runtimeRunningFresh(id)
  }

  /** Whether a session that still reads "running" has actually produced anything recently. */
  private sessionClockFresh(id: string, clock: number): boolean {
    const now = Date.now()
    const seen = this.sessionClockChanges.get(id)
    if (seen === undefined) {
      // A resumed session arrives with the clock it had: honour it, so a minutes-old dead turn
      // reads stale immediately instead of buying another full window.
      const at = clock > 0 && clock <= now ? clock : now
      this.sessionClockChanges.set(id, { clock, at })
      return now - at < STALE_RUN_STATE_MS
    }
    if (seen.clock !== clock) {
      this.sessionClockChanges.set(id, { clock, at: now })
      return true
    }
    return now - seen.at < STALE_RUN_STATE_MS
  }

  /** A turn that stopped producing without telling anyone it ended. */
  private stalledTurn(id: string): boolean {
    // Only a settled prompt can be a ghost. While the promise is still pending the app's own
    // watchdog owns the turn; declaring it stalled here would tear down a live stream.
    if (this.promptInFlight.has(id)) return false
    const session = this.state.sessions[id]
    if (session === undefined || session.state === "idle") return false
    if (this.runtimeRunningFresh(id)) return false
    return !this.sessionClockFresh(id, session.clock)
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
    // reads busy.
    //
    // This is a change detector, NOT a heartbeat: the Runtime's `version` only moves when the
    // state or the interruption changes, never with activity inside one state. A live turn is
    // kept busy by `promptInFlight`; this clock only decides whether a leftover row has gone
    // quiet once its prompt has settled.
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
            // 这里**不能**说「已被服务方下架」：本条只是「本会话的 configOptions 里没有这个 id」，
            // 可能是目录还没刷到、也可能只是该会话开在了旧目录上。2026-11-17 的日志里
            // `setConfig ok` 证明引擎照写不误，说明 terra 并没有被下架——用下架措辞是误报。
            // 真正的下架由下面 `unsupportedModel(error)` 那条（引擎明确拒绝）负责。
            void info(`[pending-model] not in session catalog, hopping ${value} -> ${sibling}`)
            toast.info(i18n.t("chat.modelNotInCatalog", { from: value, to: sibling }), { duration: 8000 })
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
          // Crossing to another vendor cannot be parked: a live turn froze its model when it
          // started, so the write lands on the thread while the turn keeps running on the old one —
          // and when it restarts, it inherits the frozen model. That is how picking a ChatGPT model
          // during a gateway turn that was still retrying left every request on the gateway: the
          // reader switched vendors and kept getting the old vendor's 429 (2026-11-19). End the
          // turn and land the choice now; a same-vendor pick stays parked as before.
          if (this.crossesVendor(id, value)) {
            if (await this.switchRightAfterStop(id, configId, value, requested, true)) return
          }
          // A turn that died with an error never delivers its final update. Parking every pick
          // behind that ghost is what made "one model failed" read as "no model works in this
          // chat": the badge stayed, the picker stayed put, and every prompt waited on a turn
          // that had already ended. When both clocks have been quiet for a full stale window,
          // end it and land the choice now.
          if (this.stalledTurn(id)) {
            const parked = this.pendingModelSwitches.get(id)
            if (parked !== undefined) this.clearParkedModel(id, parked)
            await this.cancelTurn(id).catch(() => {})
            try {
              await this.landModelSwitch(id, configId, value, requested)
              this.stoppedSessions.delete(id)
              void info(`[pending-model] ghost-turn switch landed id=${id} model=${value}`)
              return
            } catch (error) {
              void info(
                `[pending-model] ghost-turn switch failed id=${id} model=${value} error=${String(error).slice(0, 200)}`
              )
            }
          }
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
        const explanation = explainReplayFailure(message, { internalError: false })
        if (explanation !== null) {
          // The switch is refused, not deferred: drop a parked pick for this value or the two
          // second retry in `applyParkedModel` replays the refusal forever — one toast per pass,
          // and 「本轮后切换」 stuck on a conversation that will never accept it (2026-11-17).
          if (typeof value === "string") this.clearParkedModel(id, value)
          toast.error(explanation, { duration: 12_000 })
          return
        }
        const served = /supported API model names are (.+?), but you passed (\S+?)[.\s]*$/i.exec(message)
        if (served !== null) {
          if (typeof value === "string") this.clearParkedModel(id, value)
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
    if (this.holds(id) && !this.inRoleScope(id)) {
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
  /**
   * The model this chat is on right now.
   *
   * The engine's own value comes first: it is the model whose provider is actually being spent
   * when the next request leaves, which is what a cross-vendor decision is about. The recorded
   * pick is only the reader's last choice — while 分工 or 拉会 runs, the engine deliberately sits
   * on a role's model and the record still holds the reader's, so reading the record first made
   * every same-vendor comparison wrong exactly when it mattered.
   */
  private currentModelOf(id: string): string {
    if (this.holds(id)) {
      const live = this.session(id).configOptions.find((option) => option.configId === "model")?.currentValue
      if (typeof live === "string" && live !== "") return live
    }
    return this.sessionModels.get(id)?.model ?? ""
  }

  /**
   * The selection the reader is on right now, to hand the conversation back to after a role.
   *
   * `fallback` is the pair captured when the role stretch began. A reader may pick another model
   * while a discussion runs, and that pick lives only in the record: the engine is busy reporting
   * the role's model. Restoring the captured pair would silently undo their choice.
   */
  private userWantedSelection(
    id: string,
    fallback: { model: string; effort: string | null; fastMode: boolean }
  ): { model: string; effort: string | null; fastMode: boolean } {
    const recorded = this.sessionModels.get(id)
    // A pick made while a role was speaking is parked, not recorded: the engine refused the write,
    // so it never reached `saveSessionModel`. It is still the reader's newest intent, and only a
    // reader can park a pick here — roles write straight to the engine.
    const pending = this.pendingModelSwitches.get(id)
    const model = pending ?? recorded?.model
    if (model === undefined || model === null || model === "") return fallback
    // A park carries no level of its own, and a level recorded under this very model is the
    // reader's own choice for it — the captured pair is only there to fill a gap.
    if (pending !== undefined) return { model, effort: null, fastMode: false }
    return {
      model,
      effort: recorded?.effort ?? fallback.effort,
      fastMode: recorded?.fastMode ?? fallback.fastMode
    }
  }

  /**
   * Whether a pick moves to a different vendor.
   *
   * Same-vendor picks are only a model-string change: every gateway shares one Codex provider,
   * so the write can wait behind a running turn. A different vendor is a different quota pool and,
   * for a native model, a different provider binding — parking that pick means the live turn keeps
   * spending the old vendor's budget and the reader sees the old vendor's 429 after switching.
   */
  private crossesVendor(id: string, value: string): boolean {
    const current = this.currentModelOf(id)
    if (current === "") return false
    return modelVendor(current) !== modelVendor(value)
  }

  private async switchRightAfterStop(
    id: string,
    configId: string,
    value: string,
    requested: string,
    force = false
  ): Promise<boolean> {
    // The gate is state, not time: nothing has been sent since the stop, so there is no turn left
    // to wait for — however long ago that stop was. `force` is the caller saying the wait itself is
    // the problem (a vendor-line switch on a live turn); it still ends the turn, just without a
    // preceding stop to justify it.
    if (!force && !this.stoppedSessions.has(id)) return false
    // This pick supersedes anything parked earlier: cancelling below would otherwise apply the old
    // choice first and the two writes would race for the model string.
    const parked = this.pendingModelSwitches.get(id)
    if (parked !== undefined && parked !== value) this.clearParkedModel(id, parked)
    // End the turn even if its last token is still arriving: the user stopped it.
    await this.cancelTurn(id).catch(() => {})
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
   * Ends the current turn while keeping the ACP session attachable.
   *
   * Internal model-switch recovery uses this narrower stop: it needs the turn to settle so the
   * next `setConfig` can land, but it must not tear down the conversation underneath itself.
   */
  private async cancelTurn(id: string): Promise<void> {
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
   * The stop button: end this turn and close its ACP session, including every backend task it
   * started. The transcript stays in the client; the next explicit action reopens the session.
   *
   * The previous implementation only sent `session/cancel`. That returned the UI to idle while
   * shell commands, MCP calls and other work spawned by the turn could keep running. Sending the
   * cancel notification first gives the agent a clean turn boundary, then `session/close` waits for
   * the Runtime to retire the session and all of its child work.
   */
  override async cancel(id: string): Promise<void> {
    cancelQueuedPrompt(id)
    // The last gesture was Stop: a model pick made after reopening lands immediately instead of
    // parking behind a turn that no longer exists. The next prompt clears this marker.
    this.stoppedSessions.add(id)
    const pending = this.pendingModelSwitches.get(id)
    if (pending !== undefined) this.clearParkedModel(id, pending)
    // A disconnect must not prevent the close attempt: the Runtime still owns the process and is
    // the only authority that can stop the task tree.
    await Promise.try(() => this.live().notify("session/cancel", { sessionId: id })).catch(() => {})
    await this.stopSession(id)
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
    // A different target starts a fresh budget. Re-parking the same one — which is what every
    // refused retry does — keeps the count so the cap can actually be reached.
    if (this.pendingModelSwitches.get(id) !== model) {
      this.parkedAttempts.delete(id)
      this.parkedRetryAt.delete(id)
    }
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
    this.parkedAttempts.delete(id)
    this.parkedRetryAt.delete(id)
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
    const at = this.parkedAt.get(id)
    if (at === undefined || Date.now() - at < STALE_RUN_STATE_MS) return false
    const session = this.state.sessions[id]
    if (session === undefined) return false
    if (session.state === "idle") return true
    // A ghost turn never sends the idle update, but both of its clocks have stopped: waiting for
    // `idle` here kept "本轮后切换" on screen forever after an errored turn. Both must be stale —
    // `stalledTurn` also refuses while the prompt is still in flight, so a live silent turn is
    // never mistaken for a ghost.
    return this.stalledTurn(id)
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
      await this.cancelTurn(id).catch(() => {})
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
    // Inside a backoff window there is nothing to do: the interval still fires, but a choice the
    // agent just refused is not retried on the same two-second beat.
    const retryAt = this.parkedRetryAt.get(id)
    if (!force && retryAt !== undefined && Date.now() < retryAt) return Promise.resolve()
    if (!force && this.sessionBusy(id) && !this.parkedSwitchOverdue(id)) return Promise.resolve()
    // Deferred by one microtask on purpose: `setConfig` publishes a store patch synchronously,
    // and the watcher — which runs inside that patch — must already see this entry, or it would
    // start a second write for the same choice and recurse until the stack overflows.
    const apply = Promise.resolve()
      .then(() => this.withTimeout(this.setConfig(id, "model", pending), 20_000, "setConfig(model)"))
      .then(
        () => { void info(`[pending-model] apply landed id=${id} model=${pending} force=${force} stillParked=${this.pendingModelSwitches.has(id)}`) },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          void info(`[pending-model] apply threw id=${id} model=${pending} error=${message.slice(0, 240)}`)
          // A busy rejection re-parks the choice inside setConfig and the watcher retries when
          // the turn settles. Any other failure means this choice cannot apply at all — drop it,
          // or every store tick would start another write and starve the app's timers.
          if (!this.turnBusyRejection(message)) {
            this.clearParkedModel(id, pending)
            return
          }
          // A refusal that repeats is not a turn that is about to end — it is a conversation whose
          // provider can never be switched. Back off, then stop: leaving the timer armed made one
          // machine retry every two seconds for ninety minutes and drowned the log ring buffer.
          const attempts = (this.parkedAttempts.get(id) ?? 0) + 1
          if (attempts >= PENDING_MODEL_MAX_ATTEMPTS) {
            void info(`[pending-model] giving up id=${id} model=${pending} attempts=${attempts}`)
            this.clearParkedModel(id, pending)
            toast.error(i18n.t("chat.pendingModelFailed"))
            return
          }
          this.parkedAttempts.set(id, attempts)
          this.parkedRetryAt.set(id, Date.now() + parkedRetryDelay(attempts))
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
    // 分工 and 拉会 are mutually exclusive, and this gate — not the composer — is what enforces it.
    // A group conversation runs its roster by switching the shared session's model once per
    // speaker; the split would switch that same model again per role inside one turn, leaving two
    // orchestrators writing one selection with no defined outcome. A quick-chat folder renders no
    // 分工 control at all, so a plan produced there could never be approved — the "dead plan" path.
    // Both fall through to an ordinary prompt here: the stored record is the user's configuration
    // and stays untouched, it is only ignored. `runGroupDiscussion` drives its roster through
    // `promptWithTimeout` directly, so a group discussion is never blocked by this.
    const mayOrchestrate = orchestrationAllowedFor(this.holds(id) ? this.session(id).cwd : undefined)
    if (
      orchestration !== null &&
      mayOrchestrate &&
      !this.orchestrating.has(id) &&
      prompt.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
    )
      return this.planPrompt(id, prompt, options, orchestration)
    try {
      return await this.promptWithTimeout(id, prompt, options)
    } catch (error) {
      // The engine was replaced under a live conversation: its app-server starts with no threads
      // loaded, so the first turn on an open chat is refused with `thread not loaded: <id>`. The
      // thread is still on disk — resuming it turns the failure into the turn the reader asked
      // for. Replay rebuilds the transcript from the engine, so the optimistic echo of the refused
      // prompt is dropped here and the retry adds exactly one (no duplicated bubble).
      if (isThreadNotLoadedError(error)) {
        const session = this.holds(id) ? this.session(id) : undefined
        if (session !== undefined) {
          try {
            await this.replay(id, session.cwd)
            return await this.promptWithTimeout(id, prompt, options)
          } catch {
            // Nothing to resume (a draft thread Codex never wrote a rollout for, say) or the retry
            // failed for its own reason: keep the error the reader can act on.
            throw error
          }
        }
      }
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
   * Runs the group's roster: every member but the last speaks once per round, then the last member
   * closes the round as the summarizer.
   *
   * The discussion lives in one conversation, so the members read each other's turns for free —
   * that is what makes a group more than three independent answers. The human who opened it is the
   * host: their topic is the opening message (right-aligned, like any user bubble), and they stay
   * out of the AI roster — the members are the speakers, the last of them summarizes. Each turn
   * switches the shared session to that role's model, says who is speaking in the user's own bubble,
   * and waits for the turn to settle before the next role takes over. The user's own model is
   * restored at the end, so the composer still shows what they had.
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
    summaryTemplate: string,
    framing?: GroupPromptFraming,
    summaryMode: SummaryMode = "perRole"
  ): Promise<{ outcome: "done" | "stopped"; rounds: GroupRoundRecord[]; finalSummary: string | null }> {
    if (turns.length === 0) return { outcome: "done", rounds: [], finalSummary: null }
    const selection = this.currentSelection(id)
    if (selection === null) throw new Error("群会话没有当前模型")
    // The roster is an ordered list: every member but the last speaks, and the last member closes
    // the round as the summarizer. The human who opened the discussion is the host and never sits in
    // the AI roster, so the order — not a flag — decides who summarizes. A legacy `moderator` flag
    // is still honoured, but position is what the UI guarantees.
    const speakers = turns.slice(0, Math.max(0, turns.length - 1))
    const moderator = turns.find((turn) => turn.moderator) ?? (turns.length > 0 ? turns[turns.length - 1] : undefined)
    const records: GroupRoundRecord[] = []
    let baseline = this.lastUserTurnKey(id)
    // A member whose model cannot take the floor is skipped, not fatal: one broken provider must
    // not cancel a discussion the others can still hold. Reported once, at the end.
    const absent: string[] = []
    let speechFailures = 0
    const speak = async (turn: GroupTurn, at: number, kind: "speech" | "summary"): Promise<string | null> => {
      try {
        await this.speakAsRole(id, turn, at, document, kind, summaryTemplate, framing)
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
        if (gate.action === "stop") return { outcome: "stopped", rounds: records, finalSummary: null }
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
        // The roster has gone round: the last member (the summarizer) closes this round before the next one.
        const summary = moderator === undefined ? null : await speak(moderator, round, "summary")
        records.push({ round, startedAt, summary: summary ?? "", speeches })
        speeches = []
        round += 1
        index = 0
        if (round >= rounds) {
          // Every round has closed: the user's own session model writes the capstone minutes
          // (the roster spoke as the roles' models). The finally block hands the session back to
          // that same selection, so the composer stays on the user's model.
          const finalSummary = await this.runFinalSummary(id, selection, document, summaryMode, turns, summaryTemplate, framing, rounds)
          return { outcome: "done", rounds: records, finalSummary }
        }
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
  /**
   * Resolves once this conversation is idle again (or the user asked the roster to stop).
   *
   * `timeoutMs` bounds the wait for callers that must not block forever on a turn whose terminal
   * update never arrives. The roster's own gate waits without one — a speaker is allowed to take
   * its time — while a role's model switch only needs the "just finished" beat to pass.
   */
  private async waitForIdle(id: string, timeoutMs?: number): Promise<void> {
    // A closed session has no state to wait for; the caller's next turn simply fails and is caught.
    const settled = (): boolean => {
      const state = this.state.sessions[id]?.state
      return state === undefined || state === "idle"
    }
    if (settled()) return
    await new Promise<void>((resolve) => {
      let done = false
      let detach = (): void => {}
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        if (done) return
        done = true
        detach()
        if (timer !== null) clearTimeout(timer)
        resolve()
      }
      const check = (): void => {
        if (groupControlFor(id).stop || settled()) finish()
      }
      detach = this.store.subscribe(check)
      if (timeoutMs !== undefined) timer = setTimeout(finish, timeoutMs)
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

  /**
   * The capstone minutes, written by the user's own session model after every round has closed.
   *
   * The roster speaks as the roles' models; `selection` is the user's model captured at the start
   * and handed back by this method's caller (the finally block of `runGroupDiscussion`). Switching
   * to it here and letting that restore handle the hand-back keeps the composer on the user's model —
   * the final summary is theirs, not a role's. Failure is non-fatal: the rounds already happened, so
   * the discussion reports success and a missing minutes note is recorded, never thrown.
   */
  private async runFinalSummary(
    id: string,
    selection: { model: string; effort: string | null; fastMode: boolean },
    document: string,
    mode: SummaryMode,
    turns: GroupTurn[],
    template: string,
    framing: GroupPromptFraming | undefined,
    totalRounds: number
  ): Promise<string | null> {
    const reference = turns[0]
    if (reference === undefined) return null
    // The capstone is written on the reader's own model — the one they are on *now*, which may
    // differ from the pair captured when the discussion started if they picked another mid-run.
    const target = this.userWantedSelection(id, selection)
    this.enterRoleScope(id)
    try {
      announceGroupSpeaker(null, totalRounds)
      await this.switchSelectionModel(id, target.model, "最终总纪要")
      const speakers: FinalSummarySpeaker[] = turns.map((turn) => ({ name: turn.name, title: turn.title ?? "" }))
      const receipt = await this.promptWithTimeout(
        id,
        [
          {
            type: "text",
            text: groupTurnPrompt(reference, totalRounds - 1, document, "finalSummary", template, framing, mode, speakers)
          }
        ],
        { display: [{ type: "text", text: "〔最终总纪要〕" }] }
      )
      await this.waitForTurn(id, receipt)
      return this.lastAssistantText(id)
    } catch (error) {
      patchGroupDiscussion(id, { error: `最终总结失败：${error instanceof Error ? error.message : String(error)}` })
      return null
    } finally {
      this.leaveRoleScope(id)
    }
  }

  /** One role's turn: switch to its model, say who speaks, wait for the answer. */
  private async speakAsRole(
    id: string,
    turn: GroupTurn,
    round: number,
    document: string,
    kind: "speech" | "summary",
    template: string,
    framing?: GroupPromptFraming
  ): Promise<void> {
    // Everything a speaker writes is the speaker's: its model, its effort, its acceleration. The
    // scope keeps the conversation's own record on the reader's selection while the roster runs —
    // otherwise the last member's model is what the chat restores on its next launch, and what the
    // cross-vendor check reads as "the model the user is on".
    this.enterRoleScope(id)
    try {
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
      // Keep the `〔…〕` wrapper: that prefix is what marks a roster turn so the restart logic in
      // `lastUserTurnKey` skips it. The role's title (职务) is folded inside when present.
      const speakerLabel =
        turn.title !== undefined && turn.title.trim() !== "" ? `${turn.name}（${turn.title.trim()}）` : turn.name
      const receipt = await this.promptWithTimeout(
        id,
        [{ type: "text", text: groupTurnPrompt(turn, round, document, kind, template, framing) }],
        {
          display: [
            {
              type: "text",
              text:
                kind === "summary"
                  ? `〔${speakerLabel}〕总结`
                  : `〔${speakerLabel}〕第 ${round + 1} 轮`
            }
          ]
        }
      )
      await this.waitForTurn(id, receipt)
    } finally {
      this.leaveRoleScope(id)
    }
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
    if (session === undefined) throw new Error("当前会话不存在")
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
    this.enterRoleScope(id)
    try {
      // 兜底：分工里记的模型可能已经下线（`deepseek-flash` 在 DeepSeek 关闭后就是这种）。
      // 先核对目录，命中不了就换成这条会话当前可用的模型并写回配置，然后把话说明白。
      // 此前直接丢给 setConfig，引擎回「模型 X 当前不可用，请换一个模型」——可读者看到的主
      // 选择器是 Sol，根本不知道是分工在偷偷用旧模型（2026-11-17 现场）。
      const repaired = this.repairOrchestrationRole(id, roleName, role, label)
      if (repaired !== null) role = repaired
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
      this.leaveRoleScope(id)
    }
  }

  /**
   * 分工角色模型失效时换一个确定可用的，**优先留在同一个厂商**。
   *
   * 角色配的是某家中转站的模型时，那家的目录里往往还有别的模型；原来的兜底把网关全部排除，
   * 结果一条网关模型下线就把角色强行拉回原生 GPT——配额池和账号都换了，读者却只看到"已改用
   * 某模型"。同一厂商找不到才退到这条会话当前选中的模型，再退到原生分组。
   * 写回 localStorage 后，下一次发送不会再撞同一个错。
   */
  private repairOrchestrationRole(
    id: string,
    roleName: "planner" | "worker",
    role: { model: string; effort: string | null; fastMode?: boolean },
    label: string
  ): { model: string; effort: string | null; fastMode?: boolean } | null {
    const session = this.holds(id) ? this.session(id) : undefined
    if (session === undefined) return null
    const catalog = nativeModelCatalog(session.configOptions ?? [])
    if (catalog.some((entry) => entry.id === role.model)) return null
    const current = selectedModel(session.configOptions)
    const vendor = modelVendor(role.model)
    const next =
      catalog.find((entry) => entry.id !== role.model && modelVendor(entry.id) === vendor) ??
      catalog.find((entry) => entry.id === current) ??
      catalog.find((entry) => modelVendor(entry.id) === "native") ??
      catalog[0]
    if (next === undefined) return null
    const saved = orchestrationFor(id)
    if (saved !== null) {
      const patched = {
        ...saved,
        [roleName]: { model: next.id, effort: null, ...(role.fastMode === true ? { fastMode: true } : {}) }
      }
      setOrchestration(id, patched)
    }
    void info(`[orchestration] ${roleName} model ${role.model} unavailable, using ${next.id}`)
    toast.info(i18n.t("chat.orchestrationModelReplaced", { role: label, to: next.label }), { duration: 8000 })
    return { model: next.id, effort: null, ...(role.fastMode === true ? { fastMode: true } : {}) }
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
    if (session === undefined) throw new Error("当前会话不存在")
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
      throw new Error(`角色配置回读不一致：${label}加速模式未${desired ? "开启" : "关闭"}`)
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

  /**
   * Switches one role's model and confirms the agent actually applied it.
   *
   * Shared by both special chat modes: 分工 swaps planner/worker per turn, 拉会 swaps a speaker
   * per role — and both let a role sit on another vendor than the conversation's own model. The
   * write therefore must not take the user's path through `setConfig`: there a busy rejection
   * means "the reader is taking the model away from a live answer", so it ends the turn or parks
   * the pick. For a role both are wrong — cancelling cuts the previous speaker's answer, parking
   * applies a speaker's model later behind everyone's back.
   */
  private async switchSelectionModel(id: string, model: string, label: string): Promise<Session> {
    const before = this.holds(id) ? this.session(id) : undefined
    if (before === undefined) throw new Error("当前会话不存在")
    if (selectedModel(before.configOptions) !== model) await this.writeRoleModel(id, model)

    const after = this.holds(id) ? this.session(id) : undefined
    if (after === undefined) throw new Error("当前会话不存在")
    if (selectedModel(after.configOptions) !== model)
      throw new Error(`角色配置回读不一致：${label}模型未切换到“${model}”`)
    return after
  }

  /**
   * Writes a role's model straight to the engine.
   *
   * Waits (bounded) for the previous turn's terminal update, because a write into that gap is
   * refused by the agent, and a refusal here is not something the reader asked for: it only means
   * this one role cannot take the floor, which the caller reports as an absent member instead of
   * ending the discussion. Never `cancel` — that belongs to the reader's own pick.
   */
  private async writeRoleModel(id: string, model: string): Promise<void> {
    await this.waitForIdle(id, ROLE_SWITCH_IDLE_MS)
    await super.setConfig(id, "model", model)
  }

  /** Writes one selection's effort under the config id the adapter exposes, then reads it back. */
  private async writeSelectionEffort(id: string, label: string, model: string, effort: string): Promise<void> {
    let session = this.holds(id) ? this.session(id) : undefined
    if (session === undefined) throw new Error("当前会话不存在")
    const configId = this.effortConfigId(session.configOptions)
    if (configId === null) throw new Error(`${label}“${model}”未暴露 Effort 配置`)
    const supported = this.supportedEfforts(id)
    if (supported === null || !supported.includes(effort)) throw new Error(`${label}“${model}”不支持 Effort“${effort}”`)

    await this.setConfig(id, configId, effort)

    session = this.holds(id) ? this.session(id) : undefined
    if (session === undefined) throw new Error("当前会话不存在")
    const actualModel = selectedModel(session.configOptions)
    const actualEffort = this.selectedEffort(session.configOptions)
    if (actualModel !== model || actualEffort !== effort)
      throw new Error(
        `角色配置回读不一致：${label}期望 ${model} + ${effort}，实际 ${actualModel ?? "无"} + ${actualEffort ?? "无"}`
      )
  }

  /**
   * Restores the conversation to the reader's own selection after a role finishes.
   *
   * The pair captured at the start is only a fallback: a reader can change models mid-discussion,
   * and that change must not be undone by the hand-back. The restored pair is recorded as the
   * conversation's choice, so the next launch resumes on it rather than on the last speaker's.
   */
  private async restoreMainSelection(
    id: string,
    selection: { model: string; effort: string | null; fastMode: boolean }
  ): Promise<void> {
    const target = this.userWantedSelection(id, selection)
    // The saved pair is authoritative here; the model's own default must not slip in between.
    this.enterRoleScope(id)
    try {
      await this.switchSelectionModel(id, target.model, "主会话")
      const session = this.holds(id) ? this.session(id) : undefined
      if (session === undefined) throw new Error("当前会话不存在")
      if (target.effort !== null) {
        const configId = this.effortConfigId(session.configOptions)
        const supported = this.supportedEfforts(id)
        if (configId === null || supported === null || !supported.includes(target.effort))
          throw new Error(`主会话“${target.model}”不支持 Effort“${target.effort}”`)
        await this.writeSelectionEffort(id, "主会话", target.model, target.effort)
      }
      // A role may have turned acceleration on/off; hand the main conversation back with its own.
      const after = this.holds(id) ? this.session(id) : undefined
      const fast = after?.configOptions.find((entry) => entry.configId === "fast-mode")
      if (
        after !== undefined &&
        fast !== undefined &&
        isBooleanOption(fast) &&
        fast.currentValue !== target.fastMode
      )
        await this.setConfig(id, "fast-mode", target.fastMode)
    } finally {
      this.leaveRoleScope(id)
    }
    // Back outside the role's scope: this is the reader's selection again, so record it.
    this.saveSessionModel(id, { model: target.model, effort: target.effort, fastMode: target.fastMode })
  }

  /** Runs a role request and always returns the shared session to the user's main selection. */
  private async withMainSelection<T>(id: string, run: () => Promise<T>): Promise<T> {
    const selection = this.currentSelection(id)
    if (selection === null) throw new Error("当前会话没有选中的模型")

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
   * couple of those retry windows. The bridge uses the very same two clocks (20 minutes of silence,
   * 60 minutes total) and ends a silent stream with a structured error event; it must NOT use a
   * whole-request timeout, which used to cut off healthy long turns at ten minutes. The hard cap
   * exists so a turn that keeps emitting events forever cannot pin the shared agent for an afternoon.
   *
   * The ACP v2 prompt response is only an acceptance (see AGENTS.md: "Prompt responses are
   * acceptance, not completion"). The real terminal state is a `state_update` with `state:"idle"`,
   * the same one `waitForTurn` waits on. The `promptInFlight` heartbeat and both watchdogs
   * therefore stay registered past the receipt until that idle arrives; ending them at the receipt
   * left a long tool call with only the change-detector clocks, so `sessionBusy`/`stalledTurn`
   * misjudged a healthy silent turn as stale and cancelled it to switch models. The idle/hard
   * watchdogs remain as the fallback that guarantees the heartbeat can never stay unsettled.
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
    this.beginPrompt(id)
    return new Promise<string>((resolve, reject) => {
      let settled = false
      let cleared = false
      let receiptId: string | null = null
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let hardTimer: ReturnType<typeof setTimeout> | null = null
      let unsubscribe: (() => void) | null = null
      let last = signature(this.state.sessions[id])
      // A steered prompt has no `turnEndedAt` entry of its own; the turn's idle still ends it.
      const startingState = this.state.sessions[id]?.state
      let sawActive = startingState !== undefined && startingState !== "idle"
      const clear = (): void => {
        if (cleared) return
        cleared = true
        this.endPrompt(id)
        if (idleTimer !== null) clearTimeout(idleTimer)
        if (hardTimer !== null) clearTimeout(hardTimer)
        if (unsubscribe !== null) unsubscribe()
      }
      const fail = (message: string): void => {
        if (cleared) return
        clear()
        // Free the shared agent so the rest of the app recovers.
        void this.cancelTurn(id).catch(() => {})
        if (!settled) {
          settled = true
          reject(new Error(message))
        }
      }
      const armIdle = (): void => {
        if (cleared) return
        if (idleTimer !== null) clearTimeout(idleTimer)
        idleTimer = setTimeout(
          () => fail("已 20 分钟没有任何输出，按超时停止本次请求。多为上游过载持续重试，可换模型或稍后重试。"),
          IDLE_MS
        )
      }
      unsubscribe = this.store.subscribe(() => {
        const session = this.state.sessions[id]
        if (session !== undefined && session.state !== "idle") sawActive = true
        // The precise protocol signal, keyed by the accepted message id (what `waitForTurn` uses).
        if (receiptId !== null && session?.turnEndedAt[receiptId] !== undefined) {
          clear()
          return
        }
        // A steered prompt's own id is never ended; the turn reaching idle still settles it.
        // Only after the receipt: an idle seen during the pre-dispatch tool refresh is not this
        // turn ending, and clearing there would drop the heartbeat before the turn even starts.
        if (receiptId !== null && sawActive && session?.state === "idle") {
          clear()
          return
        }
        const next = signature(session)
        if (next !== last) {
          last = next
          armIdle()
        }
      })
      armIdle()
      hardTimer = setTimeout(() => fail("请求超时，已自动取消。"), HARD_MS)
      super.prompt(id, prompt, options).then(
        (receipt) => {
          if (cleared) return
          receiptId = receipt
          settled = true
          // Release the caller on acceptance, but keep monitoring until the real terminal state.
          resolve(receipt)
          if (this.state.sessions[id]?.turnEndedAt[receipt] !== undefined) clear()
        },
        (error) => {
          if (cleared) return
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

  /** A replay refused because the account model was revoked becomes a recovery card, not a crash. */
  protected override async recoverReplay(
    id: string,
    cwd: string,
    error: unknown,
    scope: ReplayScope
  ): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !message.includes("The ALwith account changed") &&
      !message.includes("The selected ALwith account model is unavailable")
    )
      return super.recoverReplay(id, cwd, error, scope)
    void info(`[account-model] recovery start id=${id}`)
    // This method must not make any engine call. It used to try an automatic switch, and that
    // switch awaited a replay on a session the engine was already refusing: the log showed
    // `recovery start` and never a second line, while the reader watched 「正在恢复聊天」 spin for
    // ever (2026-11-17). Ending the replay is the whole job here — the composer already offers the
    // model picker that fixes it, and `resumeAccountModel` replays properly when one is chosen.
    this.accountRevocations.set(id, (this.accountRevocations.get(id) ?? 0) + 1)
    this.setApp((state) => ({ accountModelRecovery: { ...state.accountModelRecovery, [id]: true } }))
    // `attached` is left alone: the composer's "can type" test is
    // `attached && !restoring && !readOnly`, so clearing it would take the input box away while
    // the notice tells the reader to pick a model — the dead end in the 拉会 screenshot.
    this.publishSession({
      ...this.session(id),
      cwd,
      restoring: false,
      error: { stopReason: ACCOUNT_MODEL_REQUIRED, error: null, meta: null }
    })
    void info(`[account-model] recovery settled id=${id} restoring=false`)
    return true
  }


  /** Flag sessions whose account-owned model is no longer served so their surface offers a new pick. */
  markAccountModelsUnavailable(ids: readonly string[]): void {
    this.setApp((state) => ({
      accountModelRecovery: { ...state.accountModelRecovery, ...Object.fromEntries(ids.map((id) => [id, true])) }
    }))
    for (const id of ids) {
      this.accountRevocations.set(id, (this.accountRevocations.get(id) ?? 0) + 1)
      if (!this.holds(id)) continue
      // Same rule as `recoverReplay`: the flag and the stop reason record the state, `readOnly`
      // would take the input box away from the reader.
      // `attached` is deliberately left alone. Writing `false` here is what killed the input box:
      // the composer's "can type" test is `session.attached && !restoring && !readOnly`, so a
      // revoked model turned the whole composer read-only while the notice told the reader to pick
      // a model in a picker that had also been removed (2026-11-17, 拉会). Losing an account model
      // does not detach the engine — the same session still answers once another model is chosen.
      this.publishSession({
        ...this.session(id),
        error: { stopReason: ACCOUNT_MODEL_REQUIRED, error: null, meta: null }
      })
    }
  }

  /**
   * Explicit recovery is separate from the automatic model hints used by normal history replay.
   *
   * Nothing in the UI calls this any more: the account-recovery card was removed in 0.4.4 and the
   * composer's normal model selector is the only way back. The method stays because the chat window
   * IPC surface (`chat-window-client`) still exposes it for a future automatic hand-off — drop it
   * together with that whitelist entry, not on its own.
   */
  async resumeAccountModel(id: string, model: string | null): Promise<void> {
    const session = this.session(id)
    if (!this.state.accountModelRecovery[id]) throw new Error("Account model recovery is not required")
    const revision = this.accountRevocations.get(id) ?? 0
    let selected = model === null ? null : await this.resolveModel(model)
    if (selected === null) {
      // Ask the engine for its current native default; never hard-code a model or inherit a gateway.
      const draft = await super.newSession(session.cwd, { draft: true })
      try {
        selected = selectedModel(this.session(draft).configOptions)
        if (!selected || selected.startsWith("gateway:")) throw new Error("Native model is unavailable")
      } finally {
        await super.discardDraft(draft)
      }
    }
    if ((this.accountRevocations.get(id) ?? 0) !== revision)
      throw new Error("ALwith account changed during model selection")
    this.accountRecoveries.set(id, revision)
    try {
      await this.replay(id, session.cwd, { meta: { alwith: { model: selected, accountModelSelection: true } } })
    } finally {
      this.accountRecoveries.delete(id)
    }
    if ((this.accountRevocations.get(id) ?? 0) !== revision)
      throw new Error("ALwith account changed during model selection")
    const resumed = this.session(id)
    if (!resumed.attached || resumed.readOnly)
      throw new Error(resumed.error?.error?.message ?? "Cannot resume this conversation")
    this.accountRevocations.delete(id)
    this.setApp((state) => {
      const { [id]: _revoked, ...accountModelRecovery } = state.accountModelRecovery
      return { accountModelRecovery }
    })
    this.confirmModel(this.state.sessionWindows[id] ?? "main", resumed)
  }

  prepareDraft(
    owner: DraftOwner,
    cwd: string,
    model: string | null = null,
    nativeDefault = false
  ): Promise<string> {
    const version = ++this.slotVersions[owner]
    return this.changeDraft([owner], async () => {
      const existing = Object.keys(this.state.draftSessions).find((id) => this.state.draftSessions[id] === owner)
      if (existing) await this.lifecycle.admission.pending(existing)
      // The caller's explicit pick wins; a brand-new draft prefers the configured default model
      // over the previous conversation's model, then the slot's saved selection. Without the
      // default here the inherited model silently overrode it and new chats opened on whatever
      // came before.
      const inherited =
        model ??
        (existing
          ? selectedModel(this.session(existing).configOptions)
          : (this.defaultModelOption?.() ?? this.savedModels[owner] ?? this.slotModels[owner]))
      // Only an inherited, unsent selection may move to the currently available default.
      const resolved = nativeDefault ? null : await this.resolveModel(inherited, model === null ? "draft" : "session")
      if (
        existing &&
        this.session(existing).cwd === cwd &&
        (!this.draftDirectoryIntents.has(existing) || this.draftDirectoryIntents.get(existing) === cwd) &&
        !nativeDefault &&
        !this.state.accountModelRecovery[existing] &&
        (resolved === null
          ? !selectedModel(this.session(existing).configOptions)?.startsWith("gateway:")
          : selectedModel(this.session(existing).configOptions) === resolved)
      ) {
        this.activateSlot(owner, existing, version)
        if (!this.session(existing).attached) {
          try {
            await this.replayForOwner(existing, cwd, owner)
          } catch (error) {
            // A draft whose rollout the engine no longer has (`Session not found`) can never
            // replay: it was never sent, so nothing is lost by starting over. Drop it and fall
            // through to the fresh-draft path below instead of stranding the slot on a dead
            // conversation whose 「重试」 re-asks the same missing rollout forever (2026-11-17).
            if (!/session not found/i.test(error instanceof Error ? error.message : String(error))) throw error
            await this.deleteEmptyDraft(existing).catch(() => {})
            this.replayFailures.delete(`${owner}:${existing}`)
            const fresh = await this.createNativeSession(cwd, resolved, owner)
            this.activateSlot(owner, fresh, version)
            if (model !== null || nativeDefault || (inherited !== null && inherited !== resolved))
              this.confirmModel(owner, this.session(fresh))
            return fresh
          }
        }
        if (model !== null) this.confirmModel(owner, this.session(existing))
        return existing
      }
      // Inherit the confirmed model, including a change already requested by this surface. A
      // failed change must not silently create a draft on the old model. Prepare the replacement
      // before retiring the previous draft: failures preserve the user's input.
      const id = await this.createNativeSession(cwd, resolved, owner)
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
      if (model !== null || nativeDefault || (inherited !== null && inherited !== resolved))
        this.confirmModel(owner, this.session(id))
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
    this.draftDirectoryIntents.delete(id)
    this.setApp((state) => {
      const { [id]: _draft, ...draftSessions } = state.draftSessions
      return { draftSessions }
    })
    this.noteModel(this.session(id))
  }

  protected override onSessionDropped(id: string): void {
    super.onSessionDropped(id)
    this.draftDirectoryIntents.delete(id)
    this.gatewayModels.delete(id)
    this.accountRevocations.delete(id)
    this.accountRecoveries.delete(id)
    this.setApp((state) => {
      const { [id]: _draft, ...draftSessions } = state.draftSessions
      const { [id]: _window, ...sessionWindows } = state.sessionWindows
      const { [id]: _revoked, ...accountModelRecovery } = state.accountModelRecovery
      return { draftSessions, sessionWindows, accountModelRecovery }
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
    const revoked = this.accountRevocations.get(id)
    if (revoked !== undefined && this.accountRecoveries.get(id) !== revoked) this.markAccountModelsUnavailable([id])
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
    // A pending revocation no longer re-parks the session read-only. Doing that here is what made
    // the single flag in `recoverReplay` sticky: every later session update re-applied the lock, so
    // the composer could never recover even after the engine was healthy again. `accountModelRecovery`
    // is the only surface state left, and it renders one line.
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
    // Moving a slot to a different conversation is the reader reopening a chat, which is the one
    // action that can make a refused replay succeed. Forget what that slot was told before, so the
    // new attempt is real instead of an echo of the last one.
    if (this.slotTargets[owner] !== id) {
      for (const key of this.replayFailures.keys()) {
        if (key.startsWith(`${owner}:`)) this.replayFailures.delete(key)
      }
    }
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
    if (!this.inRoleScope(session.id))
      this.saveSessionModel(session.id, {
        model,
        effort,
        effortExplicit: effort !== null && effort !== tableEffort,
        fastMode,
        fastExplicit: fastOption !== undefined && isBooleanOption(fastOption) && fastMode !== tableFast
      })
    for (const listener of this.confirmedModelListeners) listener(owner, model)
  }

  private resolveModel(model: string | null, purpose: "session" | "draft" = "session"): Promise<string | null> {
    return this.resolveModelOption ? this.resolveModelOption(model, purpose) : Promise.resolve(model)
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
    if (!this.inRoleScope(session.id)) this.saveSessionModel(session.id, { model: modelId })
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
