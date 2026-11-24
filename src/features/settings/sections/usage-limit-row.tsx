import { format } from "date-fns"
import { useTranslation } from "react-i18next"

import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export function UsageLimitRow({
  label,
  limit,
  showUsed = false
}: {
  label?: string
  limit?: { remainingPercent: number; resetsAt: number | null }
  showUsed?: boolean
}) {
  const { t } = useTranslation()
  const percent = limit?.remainingPercent ?? 0
  const resets =
    limit && limit.resetsAt !== null
      ? t("usage.resetsAt", { time: format(new Date(limit.resetsAt), "yyyy/MM/dd HH:mm") })
      : null
  return (
    <div className="space-y-1.5" aria-busy={!limit}>
      <div
        className={cn(
          "grid min-h-5 items-center gap-3",
          showUsed ? "grid-cols-[minmax(5rem,1fr)_minmax(3rem,2fr)_auto]" : "grid-cols-[3.5rem_minmax(0,1fr)_5rem]"
        )}
      >
        {limit ? (
          <span className="min-w-0 text-sm wrap-break-word">{label}</span>
        ) : (
          <Skeleton className="h-4 w-10 motion-reduce:animate-none" />
        )}
        {limit ? (
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
        {limit ? (
          <span className="text-end text-xs text-muted-foreground tabular-nums">
            {t("usage.remaining", { percent })}
          </span>
        ) : (
          <Skeleton className="h-4 w-14 justify-self-end motion-reduce:animate-none" />
        )}
      </div>
      <div className="flex min-h-4 items-center justify-end gap-3 text-xs text-muted-foreground">
        {showUsed && limit && (
          <span className="me-auto tabular-nums">{t("usage.used", { percent: 100 - percent })}</span>
        )}
        {limit ? resets : <Skeleton className="h-3 w-32 motion-reduce:animate-none" />}
      </div>
    </div>
  )
}
