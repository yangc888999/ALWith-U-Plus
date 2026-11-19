import { getVersion } from "@tauri-apps/api/app"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { ChevronsRightIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useUpdaterStore } from "@/features/updater/store"
import { openExternal } from "@/lib/open"

// Release history comes from the file the release process already maintains; the locale files only
// ever carried the newest version, which is why older entries were missing from the dialog.
import changelog from "../../../../CHANGELOG.md?raw"
// The bundled app icon itself — the same artwork Finder and the Dock show. Drawing our own mark
// here drifted from it (flat gradient, blocky L), so the About page now renders the real asset.
import appIcon from "../../../../src-tauri/icons/128x128@2x.png"
import { AutoUpdateRow } from "./auto-update-row"
import { parseChangeLog } from "./changelog"
import { SettingRow, SettingsCard } from "./shared"

const UPSTREAM_PROJECT_URL = "https://github.com/ALwith-ai/alwith-u"
// Where a failed check sends people: the releases page of *this* build's repository, not the
// upstream project. It is also the fallback when the in-app feed is unreachable.
const RELEASE_URL = "https://github.com/yangc888999/ALWith-U-Plus/releases/latest"

/** One sentence per failure reason; the updater's own message never reaches the screen. */
const CHECK_FAILURE_KEYS = {
  network: "updater.checkFailedNetwork",
  unavailable: "updater.checkFailedUnavailable",
  invalidRelease: "updater.checkFailedInvalidRelease",
  unknown: "updater.checkFailedUnknown"
} as const

export function AboutSection() {
  const [clientVersion, setClientVersion] = useState<string | null>(null)
  const [cliVersion, setCliVersion] = useState<string | null>(null)
  // The customization list lives behind a link now: the About page itself stays a short list of
  // facts, and the eleven bullets open on demand.
  const [changeLogOpen, setChangeLogOpen] = useState(false)
  const buildTime =
    typeof __BUILD_TIME__ === "string" && __BUILD_TIME__ !== ""
      ? new Date(__BUILD_TIME__).toLocaleString(undefined, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        })
      : null
  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    void Promise.allSettled([getVersion(), invoke<string>("codex_version")]).then(([client, cli]) => {
      if (disposed) return
      if (client.status === "fulfilled") setClientVersion(client.value)
      if (cli.status === "fulfilled") setCliVersion(cli.value)
      for (const result of [client, cli]) {
        if (result.status === "rejected") {
          const error: unknown = result.reason
          toast.error(error instanceof Error ? error.message : String(error))
        }
      }
    })
    return () => {
      disposed = true
    }
  }, [])
  useEffect(() => {
    if (!isTauri()) return
    void useUpdaterStore
      .getState()
      .init(false)
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
  }, [])
  const { t } = useTranslation()
  const state = useUpdaterStore((store) => store.state)
  const confirmInstallAndRelaunch = useUpdaterStore((store) => store.confirmInstallAndRelaunch)

  // Checks and downloads are silent; the row only says where the updater stands.
  const updaterText = (() => {
    switch (state.type) {
      case "ready":
        return t("updater.readyDesc")
      case "restarting":
        return t("updater.installing")
      // `availableForDownload` is stored but never emitted (a hit downloads straight away), so it only
      // surfaces in a state snapshot. It is a download in progress, not "up to date".
      case "availableForDownload":
      case "downloading": {
        const downloaded = state.type === "downloading" ? (state.downloadedBytes ?? 0) : 0
        const total = state.type === "downloading" ? (state.totalBytes ?? 0) : 0
        const percent = total > 0 ? Math.min(Math.round((downloaded / total) * 100), 100) : 0
        return t("updater.downloading", { percent })
      }
      case "checkingForUpdates":
        return t("updater.checking")
      case "disabled":
        return t("updater.disabled")
      case "checkFailed":
        return t(CHECK_FAILURE_KEYS[state.reason])
      default:
        return t("updater.upToDate")
    }
  })()

  const statusDot =
    state.type === "ready" || state.type === "restarting"
      ? "bg-amber-500"
      : state.type === "checkingForUpdates" || state.type === "downloading" || state.type === "availableForDownload"
        ? "bg-sky-500"
        : state.type === "checkFailed"
          ? "bg-red-500"
          : "bg-emerald-500"

  return (
    <>
      <div className="about-section flex w-full flex-col gap-4">
        {/* Identity first: an About page should answer "what app / which build" before controls. */}
        <section className="flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-7 text-center">
          <div className="grid size-14 place-items-center overflow-hidden rounded-2xl shadow-sm">
            <img src={appIcon} alt={t("app.name")} className="size-14" draggable={false} />
          </div>
          <div className="space-y-1">
            <h2 className="flex items-center justify-center gap-1.5 text-base font-semibold">
              {t("app.wordmark")}
              <span className="rounded-full bg-red-500 px-1.5 py-[1px] text-[10px] leading-[1.2] font-semibold text-white">
                {t("app.plus")}
              </span>
            </h2>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("settings.version", { version: clientVersion === null ? "—" : `v${clientVersion}` })}
              {" · "}
              {t("settings.customizedFromPrefix")}{" "}
              {/* The upstream project is one click away: this line is where people look for it. */}
              <a
                href={UPSTREAM_PROJECT_URL}
                onClick={(event) => {
                  event.preventDefault()
                  void openExternal(UPSTREAM_PROJECT_URL)
                }}
                title={UPSTREAM_PROJECT_URL}
                className="font-medium text-foreground/80 underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
              >
                {t("settings.customizedFromProject")}
              </a>{" "}
              {t("settings.customizedFromSuffix")}{" "}
              {/* A credit, not a field: kept out of the locale files so a translator cannot drop it. */}
              <span className="font-medium text-foreground/80">@Leo</span>
            </p>
          </div>
          {/* Exactly one update slot. It used to be a status capsule *plus* an install button, so
              `restarting` printed the same "安装更新" sentence twice side by side; the sidebar card
              owns the proactive prompt, this row only carries one status/action. */}
          <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
            {state.type === "ready" ? (
              <Button
                variant="outline"
                size="sm"
                className="max-w-full rounded-full font-normal text-muted-foreground"
                title={updaterText}
                onClick={() => {
                  confirmInstallAndRelaunch().catch(() => toast.error(t("updater.installFailed")))
                }}
              >
                <span className={`size-1.5 shrink-0 rounded-full ${statusDot}`} aria-hidden="true" />
                <span className="truncate">{t("updater.ready")}</span>
              </Button>
            ) : (
              <span
                role="status"
                aria-live="polite"
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground"
              >
                <span className={`size-1.5 shrink-0 rounded-full ${statusDot}`} aria-hidden="true" />
                <span className="min-w-0">{updaterText}</span>
              </span>
            )}
            {/* A failed check is not a dead end: the browser can reach the release page even when
                the app's own request to GitHub is blocked or the feed has no metadata yet. */}
            {state.type === "checkFailed" && (
              <button
                type="button"
                onClick={() => void openExternal(RELEASE_URL).catch(() => undefined)}
                className="shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
              >
                {t("updater.manualDownload")}
              </button>
            )}
          </div>
        </section>

        <SettingsCard title={t("settings.updates")}>
          <AutoUpdateRow compact />
        </SettingsCard>

        <SettingsCard title={t("settings.buildInfo")}>
          <EngineUpdateRow cliVersion={cliVersion} />
        </SettingsCard>

        <SettingsCard title={t("settings.changeLog")}>
          <button
            type="button"
            onClick={() => setChangeLogOpen(true)}
            className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/40"
          >
            <span className="text-sm leading-5 font-medium">{t("settings.changeLog")}</span>
            <ChevronsRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
          {buildTime !== null && (
            <SettingRow compact title={t("settings.buildTime")}>
              <span className="text-sm text-muted-foreground">{buildTime}</span>
            </SettingRow>
          )}
        </SettingsCard>

        <p className="px-1 text-xs leading-5 text-muted-foreground">{t("settings.licenses")}</p>
      </div>
      <ChangeLogDialog open={changeLogOpen} onOpenChange={setChangeLogOpen} version={clientVersion} />
    </>
  )
}

/** The About page's "更新日志": the whole history, parsed from CHANGELOG.md. */
function ChangeLogDialog({
  open,
  onOpenChange,
  version
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  version: string | null
}) {
  const { t } = useTranslation()
  const groups = parseChangeLog(changelog)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings.changeLogTitle")}</DialogTitle>
          {version != null && <p className="text-xs text-muted-foreground">v{version}</p>}
        </DialogHeader>
        <div className="mt-1 flex max-h-[55vh] flex-col gap-4 overflow-y-auto pr-1">
          {groups.map((group) => (
            <div key={group.version}>
              <h4 className="text-sm font-semibold">v{group.version}</h4>
              <ul className="mt-1 flex list-disc flex-col gap-1.5 ps-5 text-sm leading-relaxed marker:text-muted-foreground/60">
                {group.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 引擎行：显示内置 Codex CLI 版本。Codex CLI 随 ALWith U⁺ 应用包更新，不提供独立更新入口。
 */
function EngineUpdateRow({ cliVersion }: { cliVersion: string | null }) {
  const { t } = useTranslation()
  return (
    <SettingRow compact title={t("settings.engine")}>
      <span className="text-sm text-muted-foreground">
        {t("settings.codexVersion", { version: cliVersion ?? "—" })}
      </span>
    </SettingRow>
  )
}
