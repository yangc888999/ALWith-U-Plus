import { ArrowRightIcon, LoaderCircleIcon, RocketIcon, XIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { useUpdaterStore } from "../store"

// Desktop's update card, placed in the footer flow so the screen switch stays accessible.
export function UpdateStatusButton() {
  const { t } = useTranslation()
  const state = useUpdaterStore((store) => store.state)
  const confirmInstallAndRelaunch = useUpdaterStore((store) => store.confirmInstallAndRelaunch)

  if (state.type === "downloading") {
    const total = state.totalBytes ?? 0
    const progress = total > 0 ? Math.min(((state.downloadedBytes ?? 0) / total) * 100, 100) : 0
    const label = t("updater.downloading", { percent: Math.round(progress) })
    return (
      <div className="flex h-12 w-full items-center gap-2 rounded-xl border bg-card p-2 shadow-lg" role="status">
        <svg
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          viewBox="0 0 24 24"
          className="size-8 shrink-0 -rotate-90"
        >
          <circle cx="12" cy="12" r="9" pathLength="100" fill="none" className="stroke-muted" strokeWidth="2" />
          <circle
            cx="12"
            cy="12"
            r="9"
            pathLength="100"
            fill="none"
            className="stroke-foreground"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="100"
            strokeDashoffset={100 - progress}
          />
        </svg>
        <span className="truncate text-sm font-medium text-foreground">{label}</span>
      </div>
    )
  }

  if (state.type === "restarting") {
    return (
      <div className="flex h-12 w-full items-center gap-2 rounded-xl border bg-card p-2 shadow-lg" role="status">
        <LoaderCircleIcon className="size-8 shrink-0 animate-spin" aria-hidden="true" />
        <span className="truncate text-sm font-medium text-foreground">{t("updater.installing")}</span>
      </div>
    )
  }

  if (state.type !== "ready") return null

  const install = () => {
    void confirmInstallAndRelaunch().catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error))
    )
  }
  return (
    <div className="relative w-full rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 shadow-sm">
      <button
        type="button"
        aria-label={t("updater.dismiss")}
        className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={(event) => {
          event.stopPropagation()
          useUpdaterStore.setState({ state: { type: "idle" } })
        }}
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </button>
      <button type="button" className="flex w-full items-start gap-2 pr-5 text-left" onClick={install}>
        <RocketIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-foreground">{t("updater.install")} v{state.update.version}</span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">{t("updater.updateHint")}</span>
        </span>
        <ArrowRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100" aria-hidden="true" />
      </button>
    </div>
  )
}
