import { CheckCircle2Icon, XCircleIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

export function ComponentStatusPill({
  ok,
  label,
  busy = false
}: {
  ok: boolean
  label: string
  busy?: boolean
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] whitespace-nowrap",
        busy
          ? "border-amber-500/30 text-amber-600"
          : ok
            ? "border-emerald-500/30 text-emerald-600"
            : "border-amber-500/30 text-amber-600"
      )}
    >
      {busy ? <Spinner className="size-3" /> : ok ? <CheckCircle2Icon className="size-3" /> : <XCircleIcon className="size-3" />}
      {label}
    </span>
  )
}

export function ComponentMetaGrid({ children }: { children: ReactNode }) {
  return <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
}

export function ComponentMeta({
  label,
  value,
  sub,
  action,
  ariaLabel
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  action?: ReactNode
  ariaLabel?: string
}) {
  return (
    <div
      role={ariaLabel === undefined ? undefined : "group"}
      aria-label={ariaLabel}
      className="min-w-0 rounded-lg border border-border/60 bg-muted/20 p-3"
    >
      <div className="text-[10px] font-medium tracking-[0.05em] text-muted-foreground uppercase">{label}</div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">{value}</div>
      {sub !== undefined && sub !== "" && (
        <div className="mt-1 truncate text-[10px] leading-4 text-muted-foreground" title={typeof sub === "string" ? sub : undefined}>
          {sub}
        </div>
      )}
      {action}
    </div>
  )
}

export function ComponentInstallPanel({
  icon,
  title,
  description,
  actionLabel,
  busyLabel,
  busy = false,
  onAction
}: {
  icon: ReactNode
  title: string
  description: string
  actionLabel: string
  busyLabel: string
  busy?: boolean
  onAction: () => void
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border/70 bg-muted/20 p-3">
      <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground">{title}</div>
        <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{description}</p>
        {busy && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
            <div className="h-full w-2/5 animate-pulse rounded-full bg-primary" />
          </div>
        )}
      </div>
      <Button
        size="sm"
        className="h-7 shrink-0 px-2.5 text-xs"
        disabled={busy}
        aria-busy={busy}
        onClick={onAction}
      >
        {busy && <Spinner data-icon="inline-start" />}
        {busy ? busyLabel : actionLabel}
      </Button>
    </div>
  )
}
