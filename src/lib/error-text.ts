// User-facing error text: the ACP transport prefix goes away and the engine's English failures
// are said in the user's language.
//
// Everything here arrives as text from three layers (Rust runtime, the ACP adapter, Codex
// itself), so the only reliable contract is the sentence shape. Each pattern keeps the values it
// needs — a provider name, an exit code — and the wording lives in the locale files, which is why
// switching language also switches these messages.
import i18n from "@/lib/i18n"

type Rule = {
  /** Matched against the message with transport prefixes removed. */
  match: RegExp
  key: string
  /** Values handed to the translation, in order of the capture groups. */
  values?: (match: RegExpExecArray) => Record<string, string>
}

const RULES: Rule[] = [
  // Sentences the Codex binary, the ACP adapter and ChatGPT's 401 body hand back verbatim.
  // They are translated by shape here, never rewritten at the source: the English originals stay
  // in the logs and diagnostics, and stay available to every other locale. Keep these ahead of
  // the broader auth/network rules — "Authentication required" and a failed token refresh are
  // sign-in problems with a specific remedy, not generic "not signed in" hints.
  {
    match: /Selected model is at capacity|Flex capacity unavailable|server_is_overloaded|\bat capacity\b/i,
    key: "error.modelAtCapacity"
  },
  {
    // A reasoning level the vendor does not accept. Both shapes carry the offending value, and
    // both come from a level the model's catalogue never published — usually a hand-edited
    // `model_reasoning_effort` in config.toml, which is replayed on every turn until it is fixed.
    //
    //   Qwen:     Invalid 'reasoning.effort': meduim. Supported values are: (…)
    //   DeepSeek: reasoning.effort: unknown variant `meduim`, expected one of …
    match: /Invalid '(?:reasoning\.)?effort':\s*(\w+)/i,
    key: "error.invalidEffort",
    values: (match) => ({ value: match[1] })
  },
  {
    match: /(?:reasoning\.)?effort:\s*unknown variant `([^`]+)`/i,
    key: "error.invalidEffort",
    values: (match) => ({ value: match[1] })
  },
  {
    match: /\bAuthentication required\b/i,
    key: "error.authenticationRequired"
  },
  {
    match: /Your access token could not be refreshed|log out and sign in again/i,
    key: "error.tokenRefreshFailed"
  },
  {
    match: /Could not find the appropriate key in your authentication token|invalid_jwt/i,
    key: "error.signInTokenRejected"
  },
  {
    // Rust's settings store refuses keys it does not know. This is a bug report, not a sign-in
    // problem, so it needs its own wording.
    match: /Unknown or private settings key/i,
    key: "error.unknownSettingKey"
  },
  {
    match: /Invalid setting: (\S+)/i,
    key: "error.invalidSetting",
    values: (match) => ({ key: match[1] })
  },
  {
    match: /Quota exceeded|Check your plan and billing details/i,
    key: "error.quotaExceeded"
  },
  {
    // runtime.rs formats a rejected JSON-RPC call as "Runtime request failed (code): …".
    match: /Runtime request failed/i,
    key: "error.runtimeRequestFailed"
  },
  {
    // "The provider returned HTTP 401: Incorrect API key provided: sk-…" — the model-list fetch
    // echoes the vendor's own sentence, which is long, English and (for a mistyped key) garbage.
    // The reader only needs to know the key was rejected.
    match: /The provider returned HTTP 401\b/,
    key: "error.providerKeyRejected"
  },
  {
    match: /The provider returned HTTP 403\b/,
    key: "error.providerKeyForbidden"
  },
  {
    match: /The provider returned HTTP 429\b/,
    key: "error.providerRateLimited"
  },
  {
    match: /The provider returned HTTP (5\d\d)\b/,
    key: "error.providerServerError",
    values: (match) => ({ status: match[1] })
  },
  {
    match: /The provider returned HTTP (\d{3})\b/,
    key: "error.providerHttpError",
    values: (match) => ({ status: match[1] })
  },
  {
    // module-drive throws this English sentence before a Drive service is attached; it used to
    // reach the toast verbatim even though the rest of the app is localized.
    match: /Attach to a compatible Drive service before sending requests/i,
    key: "error.driveNotAttached"
  },
  {
    match: /Attached Drive service has no snapshot|Incompatible Drive contract|Drive profile changed/i,
    key: "error.driveUnavailable"
  },
  {
    // Drive resolves shortcuts locally, and each failure mode is its own English sentence. Fold
    // the four "the shortcut itself is broken" ones together: the remedy is the same.
    match: /Drive shortcut (?:chain exceeds the limit|exceeds the size limit|loop detected|is damaged)/i,
    key: "error.driveShortcutBroken"
  },
  {
    match: /Drive shortcut (?:has no safe web destination|target is unavailable locally and has no web destination)/i,
    key: "error.driveShortcutNoDestination"
  },
  {
    match: /Drive link is unavailable locally and has no web destination/i,
    key: "error.driveLinkUnavailable"
  },
  {
    match: /Drive archive preference is still loading/i,
    key: "error.driveStillLoading"
  },
  {
    match: /Drive configuration changed while preparing this session/i,
    key: "error.driveConfigChanged"
  },
  {
    match: /Drive credentials are unavailable/i,
    key: "error.driveCredentialsUnavailable"
  },
  {
    match: /Drive project is unavailable|This path does not belong to an indexed Drive project/i,
    key: "error.driveProjectUnavailable"
  },
  {
    match: /Drive web address is unavailable/i,
    key: "error.driveWebUnavailable"
  },
  {
    match: /The selected Drive entry no longer exists/i,
    key: "error.driveEntryGone"
  },
  {
    // Internal protocol assertions. The reader cannot act on "Invalid Drive snapshot", and there
    // are a dozen such sentences; one honest line beats twelve English names. Placed after the
    // specific Drive rules above so those still win.
    match: /Invalid (?:ALWith L )?Drive|Invalid plugin|Invalid private session list|Knowledge plugin configuration must be an object|Plugin sync state must be an object|Session archival is managed by Drive|is unavailable in this permissions dialog|Pinned documents belong to the|Project browsing belongs to the|Project navigation belongs to the|Projects cannot be opened from sync status|Drive requires a workspace host/i,
    key: "error.driveInvalidResponse"
  },
  {
    // AbortController cancellation is routine (closing a panel, replacing a request). Showing the
    // DOMException's English sentence makes it look like a failure.
    match: /The operation was aborted|AbortError|signal is aborted/i,
    key: "error.aborted"
  },
  {
    match: /Chat window did not respond/i,
    key: "error.chatWindowNoResponse"
  },
  {
    match: /Chat window failed to initialize/i,
    key: "error.chatWindowInitFailed"
  },
  {
    match: /Chat window host has not initialized/i,
    key: "error.chatWindowNotReady"
  },
  {
    match: /Invalid chat (window|surface)/i,
    key: "error.chatWindowInvalid"
  },
  {
    // "router: model gpt-6-luna names no gateway" — a model name the router cannot place.
    match: /model (\S+) names no gateway/,
    key: "error.modelNoGateway",
    values: (match) => ({ model: match[1] })
  },
  {
    // "router: gateway hakimi is not configured" — the vendor went missing from the catalog.
    match: /gateway (\S+) is not configured/,
    key: "error.gatewayMissing",
    values: (match) => ({ gateway: match[1] })
  },
  {
    // The thread is pinned to an id the engine no longer accepts. The client already hops to a
    // sibling and says so; reaching the reader means no sibling was left, so name the model
    // instead of printing the engine's English sentence.
    match: /Unsupported model:\s*['"`]?([^'"`\s]+)/,
    key: "error.modelUnsupported",
    values: (match) => ({ model: match[1] })
  },
  {
    // "This chat uses hakimi, but your current provider is openai. Switch to hakimi to continue."
    match: /This chat uses (.+?), but your current provider is (.+?)\./,
    key: "error.providerMismatch",
    values: (match) => ({ from: match[1], to: match[2] })
  },
  {
    // "This chat is pinned to the "hakimi" provider; start a new chat to switch vendors"
    match: /This chat is pinned to the [“"]([^”"]+)[”"] provider/,
    key: "error.providerPinned",
    values: (match) => ({ provider: match[1] })
  },
  {
    // `alwith` is this app's own router, not a vendor listed in 设置. The generic message sends the
    // reader looking for a provider they never added and cannot restore — the real fix is that the
    // router block goes missing from ~/.codex/config.toml (a half-finished write, or another Codex
    // client rewriting the shared file). Placed before the generic rules on purpose.
    //
    // Quote characters differ per codex build: 0.167.0 says `Model provider 'alwith' not found`
    // (single quotes) while older ones used backticks, so matching only one shape let the raw
    // English line reach the window on 2026-11-08. Accept every quoting style.
    match: /Model provider [`'"‘’“”]alwith[`'"‘’“”] not found|model provider [`'"‘’“”]alwith[`'"‘’“”], which is (?:no longer configured|not found)/i,
    key: "error.routerProviderMissing"
  },
  {
    // Codex refuses to load a config.toml it cannot parse. Two shapes are measured:
    //   adapter:  `failed to load workspace requirements: invalid configuration at <path>:60:1`
    //   exec:     `Error loading config.toml:` then `<path>:2:1: duplicate key`
    // On the other Mac (2026-11-07) an older build appended 37+ duplicate `model_provider` keys
    // after a `[projects.*]` table, which produced both. The native host repairs that file on
    // launch; name the real remedy instead of leaking the English line into the chat.
    match: /Error loading config\.toml|failed to load workspace requirements: invalid configuration at .*config\.toml/i,
    key: "error.configTomlInvalid"
  },
  {
    // "This chat uses model provider “x”, which is no longer configured."
    match: /This chat uses model provider [“"]([^”"]+)[”"], which is (?:no longer configured|not found)/,
    key: "error.providerMissing",
    values: (match) => ({ provider: match[1] })
  },
  {
    // "failed to load configuration: Model provider `x` not found"
    match: /Model provider `([^`]+)` not found/,
    key: "error.providerMissing",
    values: (match) => ({ provider: match[1] })
  },
  {
    match: /Provider selection and rollback failed; session closed/,
    key: "error.providerSwitchFailed"
  },
  {
    match: /Could not change the session provider: (.+)/,
    key: "error.providerSwitchFailedDetail",
    values: (match) => ({ detail: match[1] })
  },
  {
    // A fresh install without an account: the platform client and the browser's fetch layer answer
    // in English, which was the only English sentence a first launch ever showed.
    match: /Failed to fetch|Load failed|NetworkError when attempting to fetch resource|Network request failed/i,
    key: "error.networkUnreachable"
  },
  {
    match: /Not authenticated|Unauthorized|Please sign in|Requires authentication|\b401\b/i,
    key: "error.notSignedIn"
  },
  {
    // The engine answers a file read on a missing resource with this bare sentence.
    match: /FILE_NOT_FOUND/,
    key: "error.fileNotFound"
  },
  {
    // A fresh install has no Codex session yet; the engine says so in English until it is shown.
    match: /not signed in to (?:codex|chatgpt|openai)|run [`'" ]*codex login/i,
    key: "error.codexNotSignedIn"
  },
  {
    // "Session 01a1… not found"
    match: /Session (\S+) not found/,
    key: "error.sessionGone",
    values: (match) => ({ id: match[1] })
  },
  {
    // "The Codex app-server crashed 5 times in the last 5 min (last: it exited with code 1), so
    //  the agent stopped restarting it. Restart the agent, or try again in 116 s."
    match: /The Codex app-server crashed (\d+) times in the last (\d+) min \(last: it exited with code (-?\d+)\).*?try again in (\d+) s/,
    key: "error.engineCrashLoop",
    values: (match) => ({ count: match[1], minutes: match[2], code: match[3], seconds: match[4] })
  },
  {
    // The crash loop without the retry hint (different Codex builds word it shorter).
    match: /The Codex app-server crashed (\d+) times in the last (\d+) min/,
    key: "error.engineCrashLoopShort",
    values: (match) => ({ count: match[1], minutes: match[2] })
  },
  {
    match: /The Codex app-server was restarted for a provider change while this request ran/,
    key: "error.engineRestarted"
  },
  {
    match: /Codex process has exited with code (-?\d+)/,
    key: "error.engineExited",
    values: (match) => ({ code: match[1] })
  },
  {
    match: /The Codex app-server did not answer initialize within (\S+?)\./,
    key: "error.engineInitTimeout",
    values: (match) => ({ seconds: match[1] })
  },
  {
    match: /thread \S+ already has an active writer/,
    key: "error.activeWriter"
  },
  {
    // The engine re-reads a file between preparing a patch and writing it. Inside a cloud-synced
    // folder (YUP Drive, iCloud, OneDrive) the sync daemon rewrites the file in that window, so the
    // engine refuses the edit instead of clobbering a concurrent change. Nothing is broken — the
    // reader only has to reopen the file, which is not obvious from the English line.
    match: /File changed while opening;? reopen it/i,
    key: "error.fileChangedWhileOpening"
  },
  {
    // Two causes share this sentence: a real read-only bit, or another writer holding the file
    // (collaborative editors and cloud clients both take one). Both are actionable, so name both.
    match: /This file is read-only or being collaboratively edited/i,
    key: "error.fileReadOnlyOrLocked"
  },
  {
    match: /Wait for (?:affected sessions|the current turn)/,
    key: "error.sessionBusy"
  },
  {
    match: /alwith-runtime is not running/,
    key: "error.runtimeDown"
  },
  {
    match: /Window connection replaced/,
    key: "error.connectionReplaced"
  },
  {
    match: /Application is closing/,
    key: "error.appClosing"
  },
  {
    // "This Codex session is in use by another Codex client (the Codex app, the CLI or an IDE
    //  extension). Close the session there or quit that client, then try again."
    match: /This Codex session is in use by another Codex client/,
    key: "error.sessionInUse"
  },
  {
    match: /Sign-in did not complete/,
    key: "error.signInIncomplete"
  },
  {
    // "The Codex app-server is not available: the agent is shutting down."
    match: /The Codex app-server is not available/,
    key: "error.engineUnavailable"
  },
  {
    // A defect inside the engine or the adapter arrives as a JavaScript TypeError; showing that
    // verbatim tells the user nothing they can act on.
    match: /is not a function|undefined is not an object|Cannot read propert|is not iterable/,
    key: "error.engineInternal"
  },
  {
    match: /You(?:'|’)ve hit your usage limit|usage_limit_reached/i,
    key: "error.usageLimit"
  },
  {
    match: /context window|maximum context length|too many tokens|input is too long/i,
    key: "error.contextLimit"
  },
  {
    match: /stream disconnected|unexpected end of stream|connection reset by peer|error decoding response body/i,
    key: "error.streamInterrupted"
  },
  {
    // Drive and the model catalog refresh run in the background. Their 45s deadlines are not
    // model failures, but the generic `timed out` fallback below used to turn every sync hiccup
    // into "请求超时，请重试。" while the reader was chatting — which reads as "the model timed
    // out". Name the source instead, so a Drive stall never looks like a broken provider.
    match: /Drive request timed out|drive-transport|failed to refresh available models|featured plugin request/i,
    key: "error.backgroundTimeout"
  },
  {
    match: /operation timed out|request timed out|timed out waiting|\btimed out\b/i,
    key: "error.timeout"
  },
  {
    match: /error sending request|failed to fetch|ECONNREFUSED|ENOTFOUND|dns error|network is unreachable/i,
    key: "error.network"
  },
  {
    match: /requires ChatGPT authentication|not signed in|Please log in|401 Unauthorized/i,
    key: "error.authRequired"
  },
  {
    // "The 'gpt-5.1' model is not supported when using Codex with a ChatGPT account."
    match: /[`'"]([^`'"]+)[`'"] model is not supported/i,
    key: "error.modelUnavailable",
    values: (match) => ({ model: match[1] })
  },
  {
    // The Runtime rejects a pick with every id it does serve:
    // `model offers gpt-6.1-sol, …, gateway:kimi:kimi-k3.1-pro; "gpt-6.1-terra" is not one of them`.
    // The list is long and English; the reader only needs the id and what to do about it.
    match: /["“]([^"”]+)["”]\s*is not one of them/,
    key: "error.modelUnavailable",
    values: (match) => ({ model: match[1] })
  },
  {
    match: /model_not_found/i,
    key: "error.modelUnavailableGeneric"
  },
  {
    // A vendor answering with the model ids it actually serves:
    // `The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed
    // gpt-6.1-terra.` Saying the history cannot be replayed here was a wrong diagnosis: nothing is
    // wrong with the chat, this endpoint simply does not have that model.
    match: /supported API model names are (.+?), but you passed (\S+?)[.\s]*$/i,
    key: "error.gatewayModel",
    values: (match) => ({ model: match[2], served: match[1] })
  },
  {
    // Only the two shapes the Responses API actually uses when it refuses a replayed history.
    // A bare `invalid_request` used to land here as well, which blamed the transcript for every
    // gateway-side 400 and told the reader to start a new chat.
    match: /array too long|Invalid 'input\[\d+\]\.content'|input\[\d+\]\.content/i,
    key: "error.historyUnreplayable"
  },

  // --- Connected plugins & extensions: English errors thrown by the plugin/extension managers. ---
  // These reach the user through the patched `toast.error` (which routes every string through
  // `describeError`), so a rule here localizes them wherever they surface, without touching each
  // throw site. More specific phrases come first so they win over shorter, overlapping ones.
  {
    match: /Plugin operation already in progress/,
    key: "plugins.error.operationInProgress"
  },
  {
    match: /Remote plugin ID is missing/,
    key: "plugins.error.remotePluginIdMissing"
  },
  {
    match: /Business sharing is closed/,
    key: "extensions.error.businessSharingClosed"
  },
  {
    match: /Current document sharing is unavailable/,
    key: "extensions.error.docSharingUnavailable"
  },
  {
    match: /Multiple pending packages for this extension/,
    key: "extensions.error.multiplePendingPackages"
  },
  {
    match: /Prepared package does not match the extension/,
    key: "extensions.error.packageMismatch"
  },
  {
    match: /Extension reload returned no result/,
    key: "extensions.error.reloadNoResult"
  },
  {
    match: /Codex returned no skill catalog for the requested project/,
    key: "extensions.error.skillCatalogEmpty"
  },
  {
    match: /Extension service is not ready/,
    key: "extensions.error.serviceNotReady"
  },
  {
    match: /Only main can serve extension reloads/,
    key: "extensions.error.onlyMainReload"
  },
  {
    match: /Extension is transitioning/,
    key: "extensions.error.transitioning"
  },
  {
    match: /Extension is already installed; choose update/,
    key: "extensions.error.alreadyInstalledUpdate"
  },
  {
    match: /Extension is already installed/,
    key: "extensions.error.alreadyInstalled"
  },
  {
    match: /Extension belongs to a different installation source/,
    key: "extensions.error.differentSource"
  },
  {
    match: /Legacy installation port is required/,
    key: "extensions.error.legacyPortRequired"
  },
  {
    match: /Disabled extensions cannot be reloaded/,
    key: "extensions.error.disabledCannotReload"
  },
  {
    match: /Installed extension disappeared/,
    key: "extensions.error.installedDisappeared"
  },
  {
    match: /Selected extension package changed while activation settled/,
    key: "extensions.error.packageChanged"
  },
  {
    match: /Extension is not installed and enabled/,
    key: "extensions.error.notInstalledEnabled"
  },
  {
    match: /Extension runtime is not initialized/,
    key: "extensions.error.runtimeNotInitialized"
  },
  {
    match: /Invalid skill resolution/,
    key: "extensions.error.invalidSkillResolution"
  },
  {
    match: /Prepared import has no package/,
    key: "extensions.error.importNoPackage"
  },
  {
    match: /Extension inbox operation has not started/,
    key: "extensions.error.inboxNotStarted"
  },
  {
    match: /Extension inbox scan returned no operation identity/,
    key: "extensions.error.inboxScanNoId"
  },
  {
    match: /Unknown import phase/,
    key: "extensions.error.unknownImportPhase"
  }
]

/** Strips the transport wrappers the runtime and adapter add on the way out. */
function unwrap(message: string): string {
  return message.replace(/^(?:acpRequest: )?(?:Internal error: )?/, "").trim()
}

/** Reads the sentence out of one JSON error body: `{error:{message}}`, `{message}`, `{detail}`. */
function envelopeMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.message === "string") return record.message
  if (typeof record.detail === "string") return record.detail
  const error = record.error
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null) {
    const nested = (error as Record<string, unknown>).message
    if (typeof nested === "string") return nested
  }
  return null
}

/**
 * The engine reports a failed turn by handing the whole HTTP body back as the message, so what
 * reaches the screen is `{"error":{"message":"…"}}` instead of the sentence inside it.
 */
function unwrapBody(message: string): string {
  const trimmed = message.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return message
  try {
    return envelopeMessage(JSON.parse(trimmed)) ?? message
  } catch {
    return message
  }
}

export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = unwrapBody(unwrap(raw))
  for (const rule of RULES) {
    const match = rule.match.exec(message)
    if (match !== null) {
      const translated = i18n.t(rule.key, rule.values?.(match))
      // i18n may not be initialised in unit tests or very early startup; never replace a real
      // message with `undefined` just because the table matched.
      return typeof translated === "string" && translated !== "" ? translated : message
    }
  }
  // Unknown failure: keep the engine's text, but never show the transport prefix or the JSON.
  return message
}

/** The chat package renders engine text itself and cannot translate it; it asks the app. */
export function installErrorTextFormatter(): void {
  ;(globalThis as { __alwithFormatError?: (message: string) => string }).__alwithFormatError = describeError
}
