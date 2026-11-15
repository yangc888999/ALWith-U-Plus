// 额度重置机会：ChatGPT 账户名下的「使用限额重置」卡，一张一行。
//
// 数据来自 `chatgpt_reset_credits`（GET /backend-api/wham/rate-limit-reset-credits），
// 兑换走 `chatgpt_reset_credit`（POST .../consume）。三条铁律：
//
//   1. 张数以接口的 `availableCount` 为准，不用 `credits.length` —— 后端会截断列表。
//   2. 兑换不可逆，所以按钮要点两次：第一次变成「确认重置」，第二次才真的发请求。一次点击
//      只发一次请求，绝不自动重试（重试会花掉第二张卡）。
//   3. 这里不再画 rate-limit 窗口的「什么时候重置」——那件事由上面的限额条自己说，
//      同一屏里说两遍只会让读者以为它们不是一回事。

import { invoke } from "@tauri-apps/api/core"
import { RefreshCwIcon } from "lucide-react"
import type { TFunction } from "i18next"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { openExternal } from "@/lib/open"

/** One banked ChatGPT rate-limit reset, as the account service reports it. */
type ResetCredit = {
  id: string
  title: string | null
  description: string | null
  grantedAt: string | null
  expiresAt: string | null
  expiresAtUnix: number | null
  status: string
}

type ResetCredits = {
  status: "ok" | "unauthorized" | "unreachable" | "error" | "stale" | "signedOut"
  availableCount: number
  credits: ResetCredit[]
  fetchedAt: number
  detail: string | null
}

type RedeemResult = { code: string; windowsReset: number | null; creditId: string | null }

const CREDITS_URL = "https://chatgpt.com/settings/usage?tab=overview"

/** How many rows are drawn before the list folds. */
const VISIBLE_ROWS = 3

/** A credit that expires within this window gets a one-time reminder. */
const SOON_SECONDS = 24 * 60 * 60

const TOASTED_KEY = "alwith:reset-credit-toasts"

/** Vendor titles arrive in English; the one shape the product ships is worth translating. */
function creditTitle(credit: ResetCredit, t: TFunction): string {
  const title = credit.title?.trim() ?? ""
  if (title === "" || /full reset/i.test(title)) return t("usageReport.resetCreditFull")
  return title
}

/**
 * One second-resolution clock, running only while at least one deadline is still ahead. Stopping
 * at zero is the honest way to say "this one is gone", and it costs nothing afterwards.
 */
function useLiveNow(deadlines: number[]): number {
  const [now, setNow] = useState(() => Date.now())
  const running = deadlines.some((deadline) => deadline * 1000 > now)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [running])
  return now
}

/** `3天4时5分6秒`, dropping the leading units that are still zero. */
function formatExpiry(seconds: number, t: TFunction): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const rest = total % 60
  if (days > 0) return t("usageReport.expiryDays", { days, hours, minutes, seconds: rest })
  if (hours > 0) return t("usageReport.expiryHours", { hours, minutes, seconds: rest })
  return t("usageReport.expiryMinutes", { minutes, seconds: rest })
}

/** Which credits already produced their "expires soon" toast today. */
function readToasted(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(TOASTED_KEY)
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function writeToasted(value: Record<string, string>): void {
  try {
    window.localStorage.setItem(TOASTED_KEY, JSON.stringify(value))
  } catch {
    // A full or blocked localStorage only costs one duplicate reminder.
  }
}

/**
 * Reminds once per credit per day that a banked reset is about to expire. Driven by the data, not
 * by a timer: it fires when the list is actually read — the only moment the reminder can be acted
 * on. The day it fired is stored, so reopening the panel does not repeat it.
 */
function useExpiryReminder(credits: ResetCredit[]): void {
  const { t } = useTranslation()
  useEffect(() => {
    if (credits.length === 0) return
    const now = Date.now()
    const day = new Date(now).toISOString().slice(0, 10)
    const seen = readToasted()
    const fresh = credits.filter((credit) => {
      const at = credit.expiresAtUnix
      if (at === null) return false
      const seconds = at - Math.floor(now / 1_000)
      return seconds > 0 && seconds <= SOON_SECONDS && seen[credit.id] !== day
    })
    if (fresh.length === 0) return
    for (const credit of fresh) seen[credit.id] = day
    writeToasted(seen)
    toast.warning(
      fresh.length === 1
        ? t("usageReport.resetCreditSoonOne")
        : t("usageReport.resetCreditSoonOther", { count: fresh.length })
    )
  }, [credits, t])
}

export function UsageResetBlock({ refreshToken }: { refreshToken: number }) {
  const { t } = useTranslation()
  const [credits, setCredits] = useState<ResetCredits | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [redeeming, setRedeeming] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // Tests replace `@tauri-apps/api/core` with a minimal stub; reading a missing export throws,
    // so the availability check lives inside the try. Both outcomes mean "nothing to show".
    const load = async (): Promise<ResetCredits | null> => {
      try {
        return typeof invoke === "function" ? await invoke<ResetCredits>("chatgpt_reset_credits") : null
      } catch {
        return null
      }
    }
    void load().then((value) => {
      if (alive) setCredits(value)
    })
    return () => {
      alive = false
    }
  }, [refreshToken])

  const available = credits?.credits ?? []
  useExpiryReminder(available)

  const deadlines = available.map((credit) => credit.expiresAtUnix).filter((value): value is number => value !== null)
  const now = useLiveNow(deadlines)

  const redeem = async (credit: ResetCredit): Promise<void> => {
    setRedeeming(credit.id)
    try {
      const result = await invoke<RedeemResult>("chatgpt_reset_credit", { creditId: credit.id })
      toast.success(t(`usageReport.redeem_${result.code}` as "usageReport.redeem_reset"), {
        description:
          result.windowsReset === null
            ? undefined
            : result.windowsReset === 1
              ? t("usageReport.redeemWindowsOne")
              : t("usageReport.redeemWindowsOther", { count: result.windowsReset })
      })
      setConfirming(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRedeeming(null)
    }
  }

  if (credits === null) return null

  const count = credits.availableCount
  const rows = expanded ? available : available.slice(0, VISIBLE_ROWS)
  const hidden = available.length - rows.length

  return (
    <div className="space-y-2 border-t border-border/60 pt-4" data-testid="usage-reset-block">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("usageReport.resetCreditsTitleCount", { count })}</span>
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => void openExternal(CREDITS_URL).catch(() => {})}
        >
          {t("usageReport.resetCreditsManage")}
        </button>
      </div>

      {available.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("usageReport.resetCreditsEmpty")}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5" data-testid="usage-reset-credits">
            {rows.map((credit) => {
              const at = credit.expiresAtUnix
              const remaining = at === null ? null : Math.floor(at - now / 1_000)
              const busy = redeeming === credit.id
              const asking = confirming === credit.id
              return (
                <li
                  key={credit.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 px-2.5 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{creditTitle(credit, t)}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {remaining === null
                      ? t("usageReport.resetCreditsNoExpiry")
                      : remaining <= 0
                        ? t("usageReport.resetCreditExpired")
                        : t("usageReport.resetCreditExpiresIn", { time: formatExpiry(remaining, t) })}
                  </span>
                  {remaining !== null && remaining > 0 && (
                    <span className="flex shrink-0 items-center gap-1">
                      {asking && (
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
                          {t("usageReport.redeemCancel")}
                        </Button>
                      )}
                      <Button
                        variant={asking ? "destructive" : "outline"}
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          if (!asking) {
                            setConfirming(credit.id)
                            return
                          }
                          void redeem(credit)
                        }}
                      >
                        {busy && <RefreshCwIcon className="size-3.5 animate-spin" aria-hidden="true" />}
                        {asking ? t("usageReport.redeemConfirm") : t("usageReport.redeemNow")}
                      </Button>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => setExpanded(true)}
            >
              {t("usageReport.resetCreditsShowAll", { count: hidden })}
            </button>
          )}
          {expanded && available.length > VISIBLE_ROWS && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => setExpanded(false)}
            >
              {t("usageReport.resetCreditsCollapse")}
            </button>
          )}
        </>
      )}
    </div>
  )
}
