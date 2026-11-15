// 「额度」块: what a provider says it has left, inside its card on 设置 → 大模型.
//
// The block exists because the alternative — sending a turn and reading the vendor's 402 — is a
// worse way to learn that a balance ran out. It draws only what the provider published:
//
//   * figures when the vendor publishes them (`$12.40 / $60.00`, `剩余 812 requests`);
//   * a sentence, never a number, when the vendor only shows its plan in a console or publishes
//     nothing at all;
//   * the cached figures with a 缓存 badge when the last read failed.
//
// OpenRouter additionally gets a `:free` line built from two *independent* counters — the vendor's
// remaining allowance and this machine's own call tally — which are never divided by each other.
//
// The cache-then-refresh order matters for perceived speed: `provider_quota_cached` answers from
// memory, so a card opens with last-known numbers and the live read replaces them a moment later.
// A failed live read is not an error state for the reader — the numbers they had are still true as
// of `fetchedAt`, and the badge says so.

import { openUrl } from "@tauri-apps/plugin-opener"
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { formatRemaining } from "@/lib/format-countdown"
import {
  cachedProviderQuotas,
  formatQuotaClock,
  formatQuotaStamp,
  formatQuotaWindow,
  freeAllowance,
  freeResetHint,
  openrouterFreeUsage,
  queryProviderQuota,
  quotaCountdownSeconds,
  type FreeUsage,
  type ProviderQuota
} from "@/lib/provider-quota"
import { cn } from "@/lib/utils"

/** Vendors whose plan page we can name. A provider with `status: "console"` and no entry here still
 *  gets the sentence — it just has no button, because guessing a URL is how a link 404s. */
const CONSOLE_URLS: Record<string, string> = {
  qwen: "https://bailian.console.aliyun.com/"
}

/** Opens the vendor console. Silent on failure: the URL is a convenience, not the task at hand. */
function openConsole(url: string): void {
  try {
    void openUrl(url).catch(() => {})
  } catch {
    // Outside a Tauri webview `openUrl` throws synchronously; nothing is broken by that.
  }
}

/**
 * Why a provider has no quota figure, in the reader's terms.
 *
 * Three states share the `unsupported` verdict and they are not interchangeable: a vendor with no
 * quota endpoint is nothing to fix, while a switched-off credential and a missing base URL are both
 * one action away from working. Saying 「该供应商没有公开的额度接口」 about a provider the user
 * themselves turned off is a claim about the vendor that we have no basis for.
 *
 * Matched by exact equality against the machine token — `detail` is prose and is never parsed.
 * An unrecognised or absent token falls back to the generic sentence rather than guessing.
 */
function unsupportedKey(reason: string | null): string {
  switch (reason) {
    case "disabled":
      return "providerUsage.unsupportedDisabled"
    case "noBaseUrl":
      return "providerUsage.unsupportedNoBaseUrl"
    case "noApi":
    default:
      return "providerUsage.unsupported"
  }
}

/**
 * The quota block for one provider card.
 *
 * `active` is the card's own visibility: every provider card is mounted so switching tabs is
 * instant, but reading a quota costs a network round trip, so the read only happens for the card
 * the reader is actually looking at.
 */
export function ProviderUsageBlock({
  providerId,
  active,
  className
}: {
  providerId: string
  /** The card's tab is visible. Inactive cards render nothing and read nothing. */
  active: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const [quota, setQuota] = useState<ProviderQuota | null>(null)
  /** The figures on screen came from the cache, not from the last live read. */
  const [fromCache, setFromCache] = useState(false)
  /** The last live read failed. Kept apart from `fromCache`: a cached row may never have been
   *  refreshed at all (the card only just opened), and that is not the same statement. */
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [free, setFree] = useState<FreeUsage | null>(null)
  const [, setTicking] = useState(0)

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    if (!active) return
    let alive = true
    setLoading(true)
    void (async () => {
      // 1. Whatever the last read left behind, so the row is never blank while the network works.
      try {
        const cached = await cachedProviderQuotas()
        const hit = cached.find((entry) => entry.providerId === providerId)
        if (alive && hit !== undefined) {
          setQuota(hit)
          setFromCache(true)
        }
      } catch {
        // No cache (first launch, or a bridge that dropped it): the live read below is the answer.
      }
      // 2. The live read replaces it. A failure keeps the cached figures on screen, still marked.
      try {
        const live = await queryProviderQuota(providerId)
        if (alive) {
          setQuota(live)
          setFromCache(false)
          setFailed(false)
        }
      } catch {
        // Unreachable/unauthorized: the cached figures (if any) stay, and their badge says why.
        if (alive) setFailed(true)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [active, providerId, attempt])

  useEffect(() => {
    if (!active || providerId !== "openrouter") return
    let alive = true
    void openrouterFreeUsage()
      .then((value) => {
        if (alive) setFree(value)
      })
      .catch(() => {
        // The local counter is a nicety; a bridge without it simply draws no line.
      })
    return () => {
      alive = false
    }
  }, [active, providerId, attempt])

  // A countdown that does not tick is a lie on a row that says "in 3 minutes". One interval for the
  // whole block, re-created only when it starts or stops being needed.
  const counts = quota?.resetAt != null || quota?.expiresAt != null || free?.resetAt != null
  useEffect(() => {
    if (!active || !counts) return
    const timer = window.setInterval(() => setTicking((value) => value + 1), 1_000)
    return () => window.clearInterval(timer)
  }, [active, counts])

  if (!active) return null

  const windowData = formatQuotaWindow(quota, { fromCache })
  const now = Date.now()
  const consoleUrl = CONSOLE_URLS[providerId]
  const failing =
    failed || (windowData !== null && (windowData.status === "unreachable" || windowData.status === "error"))
  const resetSeconds = quota === null ? null : quotaCountdownSeconds(quota.resetAt, now)

  return (
    <div
      className={cn("flex flex-col gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5", className)}
      data-provider-usage={providerId}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t("providerUsage.title")}</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-2 text-xs"
          disabled={loading}
          onClick={refresh}
          data-quota-refresh=""
        >
          {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon className="size-3" aria-hidden="true" />}
          {t("providerUsage.refresh")}
        </Button>
      </div>

      {/* Figures first: a number is what the reader came for. */}
      {windowData?.figure != null && (
        <p className="flex flex-wrap items-baseline gap-1.5 text-sm font-medium tabular-nums" data-quota-figure="">
          {windowData.figure.kind === "usd" ? (
            <span>
              {`$${windowData.figure.remaining.toFixed(2)} / `}
              {windowData.figure.limit === null
                ? t("providerUsage.unlimited")
                : `$${windowData.figure.limit.toFixed(2)}`}
            </span>
          ) : (
            <span>
              {t("providerUsage.remaining")} {windowData.figure.remaining} {windowData.figure.unit}
            </span>
          )}
          {windowData.stale && (
            <span className="rounded bg-muted px-1 py-px text-[10px] font-normal text-muted-foreground">
              {t("providerUsage.stale")}
            </span>
          )}
        </p>
      )}

      {/* The vendor states there is no ceiling: a fact, and the only honest thing to draw when it
          publishes no numbers at all. */}
      {windowData?.unlimited === true && (
        <p className="text-sm font-medium text-foreground/80" data-quota-unlimited="">
          {t("providerUsage.unlimited")}
        </p>
      )}

      {/* A published limit with no published remaining is still a fact worth one line — and it is
          the only honest thing to say about a window whose balance the vendor does not disclose. */}
      {windowData?.figure == null && windowData?.unlimited !== true && quota !== null && quota.limit !== null && (
        <p className="text-sm tabular-nums text-muted-foreground" data-quota-limit="">
          {t("providerUsage.limit", {
            value:
              quota.unit === "usd"
                ? `$${quota.limit.toFixed(2)}`
                : `${quota.limit}${quota.unit === null ? "" : ` ${quota.unit}`}`
          })}
        </p>
      )}

      {windowData === null ? (
        // Nothing has ever been read for this provider. Say that instead of drawing an empty row.
        loading ? null : <p className="text-xs text-muted-foreground">{t("providerUsage.unreachable")}</p>
      ) : (
        <>
          {windowData.status === "console" && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-muted-foreground">{t("providerUsage.consoleOnly")}</p>
              {consoleUrl !== undefined && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={() => openConsole(consoleUrl)}
                >
                  {t("providerUsage.openConsole")}
                  <ExternalLinkIcon className="size-3" aria-hidden="true" />
                </Button>
              )}
            </div>
          )}
          {windowData.status === "unsupported" && (
            <p className="text-xs text-muted-foreground">{t(unsupportedKey(windowData.unsupportedReason))}</p>
          )}
          {windowData.status === "unauthorized" && (
            <p className="text-xs text-destructive" role="status">
              {t("providerUsage.unauthorized")}
            </p>
          )}
          {failing && <p className="text-xs text-muted-foreground">{t("providerUsage.unreachable")}</p>}
          {/* The plan name the vendor printed, verbatim.
              It is a machine string whose schema we do not know (`套餐-Claude 半年卡|hybrid|10800|200`),
              so it is never split on `|` or reformatted — trimming the unknown parts off would be
              inventing a meaning for them. `truncate` + `title` keeps a long one from widening the
              card while still letting it be read in full on hover. */}
          {windowData.plan !== null && windowData.plan.trim() !== "" && (
            <p
              className="truncate text-xs text-muted-foreground"
              title={windowData.plan}
              data-quota-plan=""
            >
              {t("providerUsage.plan", { name: windowData.plan })}
            </p>
          )}
          {/* Window metadata: only what the provider actually stated. `expiresAt` is the plan ending
              (有效期至) and `resetAt` is a quota refilling (重置于) — two different facts, so neither
              ever borrows the other's wording. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {windowData.resetAt !== null && (
              <span data-quota-reset="">
                {resetSeconds === null || resetSeconds <= 0
                  ? t("providerUsage.resetNow")
                  : t("providerUsage.resetAt", {
                      time: `${formatQuotaStamp(windowData.resetAt)} · ${formatRemaining(resetSeconds)}`
                    })}
              </span>
            )}
            {windowData.expiresAt !== null && (
              <span data-quota-expires="">
                {t("providerUsage.expiresAt", { time: formatQuotaStamp(windowData.expiresAt) })}
              </span>
            )}
            {windowData.fetchedAt !== null && (
              <span data-quota-fetched="">{t("providerUsage.updatedAt", { time: formatQuotaClock(windowData.fetchedAt) })}</span>
            )}
          </div>
        </>
      )}

      {/* OpenRouter's `:free` picture. It carries two counters from two different sources, so it
          is drawn as two lines: the vendor's allowance (`remaining / limit`) and this machine's own
          tally (`calls`). `calls / limit` would divide one source by the other and read as if the
          local tally were the vendor's counter — see `FreeUsageRow`. */}
      {free !== null && <FreeUsageRow free={free} now={now} />}
    </div>
  )
}

/**
 * The free tier: what the vendor says is left, then how much this machine used.
 *
 * Both figures come straight from the backend; neither is derived from the other, and a missing
 * one is never filled with `0`. Only `free.blocked` — a real 429 from the vendor — may turn this
 * row red: a `remaining` of 0 is a stated balance, not an enforced block.
 */
function FreeUsageRow({ free, now }: { free: FreeUsage; now: number }) {
  const { t } = useTranslation()
  const allowance = freeAllowance(free)
  const reset = freeResetHint(free, now)
  // `"utcDay"` is a rule we compute (00:00 UTC), not an instant the vendor sent, so it is spelled
  // out as a rule; `"vendor"` may be stated plainly. An unknown source draws nothing at all.
  const resetLabel =
    reset === null
      ? null
      : reset.kind === "vendor"
        ? reset.seconds === null
          ? null
          : t("providerUsage.freeResetVendor", { time: formatRemaining(reset.seconds) })
        : reset.seconds === null
          ? t("providerUsage.freeResetUtcDayRule")
          : t("providerUsage.freeResetUtcDay", { time: formatRemaining(reset.seconds) })
  const allowanceText = ((): string => {
    if (allowance === null) return "—"
    if (allowance.kind === "pair") return `${allowance.remaining} / ${allowance.limit}`
    if (allowance.kind === "remainingOnly") return `${t("providerUsage.remaining")} ${allowance.remaining}`
    return t("providerUsage.freeRemainingUnknown", { limit: allowance.limit })
  })()

  return (
    <div className="flex flex-col gap-0.5 text-xs" data-free-usage="">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-muted-foreground">{t("providerUsage.freeAllowance")}</span>
        <span
          className={cn("tabular-nums", free.blocked ? "font-medium text-destructive" : "text-foreground/80")}
          data-free-allowance=""
        >
          {allowanceText}
        </span>
        {free.blocked && (
          <span className="text-destructive" role="status" data-free-blocked="">
            {t("providerUsage.freeBlocked")}
          </span>
        )}
        {resetLabel !== null && (
          <span className="text-muted-foreground" data-free-reset="">
            {resetLabel}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-muted-foreground">{t("providerUsage.freeLocalCalls")}</span>
        <span className="tabular-nums text-foreground/80" data-free-calls="">
          {free.calls}
        </span>
      </div>
    </div>
  )
}
