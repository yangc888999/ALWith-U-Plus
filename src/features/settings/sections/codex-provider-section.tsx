import type { RateLimitWindow } from "@nyssance/codex-acp-v2/client"
// Account: who is signed in and how much of the plan's rate limits is used, ALwith
// Desktop's usage section reduced to what Codex reports (`account/read`,
// `account/rateLimits/read`). The settings window gets the data from the main window's
// agent connection through the settings bridge.
import { format } from "date-fns"
import type { TFunction } from "i18next"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { ActionCard } from "@/features/chat/action-card"
import { LoginCard } from "@/features/connection/login-card"
import { openExternal } from "@/lib/open"
import {
  requestAccountRefresh,
  requestActionResponse,
  requestSignIn,
  requestSignOut,
  type SettingsAccount,
  useSettingsAccount,
  useSettingsAgent
} from "@/lib/settings-bridge"

import { SettingGroup, SettingLabel } from "./shared"
import { UsageResetBlock } from "./usage-reset-card"

/** Desktop's `UsageLimitRow`: label, a long bar, "n% remaining", then the reset time under it. */
function UsageLimitRow({ label, window }: { label?: string; window?: RateLimitWindow }) {
  const { t } = useTranslation()
  const percent = window ? 100 - Math.round(Math.min(100, Math.max(0, window.usedPercent))) : 0
  const resets =
    window && window.resetsAt !== null
      ? t("usage.resetsAt", { time: format(new Date(window.resetsAt * 1000), "yyyy/MM/dd HH:mm") })
      : null
  return (
    <div className="space-y-1.5" aria-busy={!window}>
      <div className="grid min-h-5 grid-cols-[3.5rem_minmax(0,1fr)_5rem] items-center gap-3">
        {window ? (
          <span className="text-sm">{label}</span>
        ) : (
          <Skeleton className="h-4 w-10 motion-reduce:animate-none" />
        )}
        {window ? (
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={label}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full rounded-full bg-[var(--settings-accent)]" style={{ width: `${percent}%` }} />
          </div>
        ) : (
          <Skeleton className="h-2 rounded-full motion-reduce:animate-none" />
        )}
        {window ? (
          <span className="text-end text-xs text-muted-foreground tabular-nums">
            {t("usage.remaining", { percent })}
          </span>
        ) : (
          <Skeleton className="h-4 w-14 justify-self-end motion-reduce:animate-none" />
        )}
      </div>
      <div className="flex min-h-4 items-center justify-end text-xs text-muted-foreground">
        {window ? resets : <Skeleton className="h-3 w-32 motion-reduce:animate-none" />}
      </div>
    </div>
  )
}

/** The window label: "5 hours" / "Weekly" from the window length Codex reports. */
function limitWindowLabel(window: RateLimitWindow, t: TFunction): string {
  const minutes = window.windowDurationMins
  if (minutes === null) return t("usage.usage")
  if (minutes % (24 * 60) === 0) return t("usage.windowDays", { count: minutes / (24 * 60) })
  return t("usage.windowHours", { count: Math.round(minutes / 60) })
}

export function CodexAccountSummary({
  account,
  disabled,
  onSignOut,
  onRefresh,
  refreshing = false
}: {
  account: SettingsAccount | undefined
  disabled: boolean
  onSignOut: () => void
  /** Re-reads `account/rateLimits` and the banked-reset list. Optional so a caller that only wants
   *  the identity + limit bars (the provider-section tests) still renders. */
  onRefresh?: () => void
  refreshing?: boolean
}) {
  const { t } = useTranslation()
  const loading = account === undefined
  const signedIn = account?.account.account ?? null
  // Bumped on every refresh so the reset-credit list (which fetches on its own) rereads too: one
  // button must refresh everything the card shows, not half of it.
  const [resetToken, setResetToken] = useState(0)
  const refreshAll = (): void => {
    setResetToken((token) => token + 1)
    onRefresh?.()
  }
  const identity =
    account === null
      ? t("usage.accountUnavailable")
      : signedIn === null
        ? t("usage.notSignedIn")
        : signedIn.type === "chatgpt"
          ? [signedIn.email, signedIn.planType !== "unknown" ? t(`usage.plan.${signedIn.planType}`) : null]
              .filter(Boolean)
              .join(" · ")
          : signedIn.type === "apiKey"
            ? t("usage.apiKey")
            : t("usage.bedrock")
  const limits = account?.rateLimits ?? null
  return (
    <section aria-busy={loading} aria-label="ChatGPT" className="space-y-4">
      <div className="flex min-h-8 items-center justify-between gap-4">
        {loading ? (
          <Skeleton className="h-4 w-40 max-w-[65%] motion-reduce:animate-none" />
        ) : (
          <span className="min-w-0 text-sm break-words">{identity}</span>
        )}
        {loading ? (
          <Skeleton className="h-8 w-16 shrink-0 motion-reduce:animate-none" />
        ) : (
          signedIn !== null && (
            <Button variant="outline" size="sm" className="shrink-0" disabled={disabled} onClick={onSignOut}>
              {t("connection.signOut")}
            </Button>
          )
        )}
      </div>
      {(loading || signedIn !== null) && (
        <div className="flex flex-col gap-4">
          {loading ? (
            <UsageLimitRow />
          ) : limits === null ? (
            // "No usage data" and "the read failed" are different facts: the first is a plan
            // without windows, the second is chatgpt.com not answering. Saying the wrong one made
            // a network blip look like an empty plan.
            <span className="text-sm text-muted-foreground">
              {t(account?.rateLimitsError === true ? "usage.limitsError" : "usage.unavailable")}
            </span>
          ) : (
            <>
              {limits.primary !== null && (
                <UsageLimitRow label={limitWindowLabel(limits.primary, t)} window={limits.primary} />
              )}
              {limits.secondary !== null && (
                <UsageLimitRow label={limitWindowLabel(limits.secondary, t)} window={limits.secondary} />
              )}
              {limits.primary === null && limits.secondary === null && (
                <span className="text-sm text-muted-foreground">{t("usage.unavailable")}</span>
              )}
            </>
          )}
          {/* The timestamp and the refresh button are one row: the button refreshes exactly the
              numbers above it, so it sits beside their date instead of inside the reset block.
              Always drawn — a failed read still needs a way to try again. */}
          {!loading && (
            <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
              {account?.rateLimitsCapturedAt != null ? (
                <p className="text-[11px] text-muted-foreground" role="status">
                  {t(account.rateLimitsStale === true ? "usage.staleLimits" : "usage.lastUpdated", {
                    time: format(new Date(account.rateLimitsCapturedAt), "yyyy/MM/dd HH:mm")
                  })}
                </p>
              ) : (
                <span />
              )}
              {onRefresh !== undefined && (
                <Button variant="outline" size="sm" className="shrink-0" disabled={refreshing} onClick={refreshAll}>
                  <RefreshCwIcon className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
                  {t("usageReport.resetCardRefresh")}
                </Button>
              )}
            </div>
          )}
          {/* 额度重置机会 replaces the standalone card that used to sit at the top of 用量: it
              describes this account's own credits, so it belongs under the same bars. Only drawn
              while signed in — a reset credit is a property of a ChatGPT account. */}
          {signedIn !== null && <UsageResetBlock refreshToken={resetToken} />}
        </div>
      )}
    </section>
  )
}

export function CodexProviderSection() {
  const { t } = useTranslation()
  const agent = useSettingsAgent()
  const account = useSettingsAccount()
  const [signingOut, setSigningOut] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // A refresh is a request/answer pair across two windows, so the spinner cannot end when the
  // emit resolves. It ends when a new snapshot lands, and a timer ends it anyway if the main
  // window never answers — a spinner that never stops is worse than a short lie.
  useEffect(() => {
    if (!refreshing) return
    const timer = window.setTimeout(() => setRefreshing(false), 4_000)
    return () => window.clearTimeout(timer)
  }, [refreshing])
  useEffect(() => {
    setRefreshing(false)
  }, [account])
  return (
    <SettingGroup>
      <SettingLabel>ChatGPT</SettingLabel>
      <div className="rounded-xl border p-4">
        <CodexAccountSummary
          account={account}
          disabled={agent == null || signingOut}
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            void requestAccountRefresh().catch(() => undefined)
          }}
          onSignOut={() => {
            setSigningOut(true)
            void requestSignOut()
              .catch((error: unknown) => {
                toast.error(error instanceof Error ? error.message : String(error))
              })
              .finally(() => setSigningOut(false))
          }}
        />
{account != null && !account.account.account && agent && (
        <LoginCard methods={agent.authMethods} signIn={requestSignIn} />
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs text-muted-foreground"
          onClick={() =>
            void openExternal("https://chatgpt.com/settings/usage?tab=overview").catch((error: unknown) =>
              toast.error(error instanceof Error ? error.message : String(error))
            )
          }
        >
          {t("usage.viewOnline")}
          <ExternalLinkIcon className="size-3" aria-hidden="true" />
        </Button>
      </div>
      {agent?.actions.map((action) => (
          <ActionCard
            key={action.id}
            action={action}
            onRespond={(id, answer) => {
              void requestActionResponse(id, answer).catch((error: unknown) =>
                toast.error(error instanceof Error ? error.message : String(error))
              )
            }}
          />
        ))}
      </div>
    </SettingGroup>
  )
}
