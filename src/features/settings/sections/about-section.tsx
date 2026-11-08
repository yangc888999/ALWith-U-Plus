import { getVersion } from "@tauri-apps/api/app"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { ChevronsRightIcon, RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useUpdaterStore } from "@/features/updater/store"
import { openExternal } from "@/lib/open"
// The bundled app icon itself — the same artwork Finder and the Dock show. Drawing our own mark
// here drifted from it (flat gradient, blocky L), so the About page now renders the real asset.
import appIcon from "../../../../src-tauri/icons/128x128@2x.png"

import { AutoUpdateRow } from "./auto-update-row"
import { Spinner } from "@/components/ui/spinner"

import { SettingRow, SettingsCard } from "./shared"

const UPSTREAM_PROJECT_URL = "https://github.com/ALwith-ai/alwith-u"

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
  // The engine row rewrites the CLI binary; re-reading it here keeps 关于 honest after install.
  const refreshCliVersion = (): void => {
    if (!isTauri()) return
    void invoke<string>("codex_version")
      .then(setCliVersion)
      .catch(() => undefined)
  }
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
        return t("updater.readyDesc", { version: state.update.version })
      case "restarting":
        return t("updater.installing")
      case "downloading": {
        const total = state.totalBytes ?? 0
        const percent = total > 0 ? Math.min(Math.round(((state.downloadedBytes ?? 0) / total) * 100), 100) : 0
        return t("updater.downloading", { percent })
      }
      case "checkingForUpdates":
        return t("updater.checking")
      case "disabled":
        return t("updater.disabled")
      default:
        return t("updater.upToDate")
    }
  })()

  const statusDot =
    state.type === "ready" || state.type === "restarting"
      ? "bg-amber-500"
      : state.type === "checkingForUpdates" || state.type === "downloading"
        ? "bg-sky-500"
        : "bg-emerald-500"

  return (
    <>
      <div className="about-section flex w-full flex-col gap-4">
        {/* Identity first: an About page should answer "what app / which build" before controls. */}
        <section className="flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-7 text-center">
          <div className="grid size-14 place-items-center overflow-hidden rounded-2xl shadow-sm">
            <img src={appIcon} alt="ALWith L" className="size-14" draggable={false} />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-semibold">ALWith L</h2>
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
              {t("settings.customizedFromSuffix")}
              {" "}
              {/* A credit, not a field: kept out of the locale files so a translator cannot drop it. */}
              <span className="font-medium text-foreground/80">@Leo</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
              <span className={`size-1.5 rounded-full ${statusDot}`} />
              {updaterText}
            </span>
            {(state.type === "ready" || state.type === "restarting") && (
              <Button
                variant="outline"
                size="sm"
                disabled={state.type === "restarting"}
                onClick={() => {
                  confirmInstallAndRelaunch().catch((error: unknown) =>
                    toast.error(error instanceof Error ? error.message : String(error))
                  )
                }}
              >
                {state.type === "restarting"
                  ? t("updater.installing")
                  : t("updater.ready", { version: state.update.version })}
              </Button>
            )}
          </div>
        </section>

        <SettingsCard title={t("settings.updates")}>
          <AutoUpdateRow compact />
          <button
            type="button"
            onClick={() => setChangeLogOpen(true)}
            className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/40"
          >
            <span className="text-sm leading-5 font-medium">{t("settings.changeLog")}</span>
            <ChevronsRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </SettingsCard>

        <SettingsCard title={t("settings.buildInfo")}>
          <EngineUpdateRow cliVersion={cliVersion} onInstalled={refreshCliVersion} />
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

/** The About page's "更新日志": a flat change list grouped by version markers (lines like "v0.2.28"). */
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
  const raw = t("settings.customizationItems", { returnObjects: true })
  const list = Array.isArray(raw) ? (raw as string[]) : []
  const groups: Array<{ version: string; items: string[] }> = []
  let current: { version: string; items: string[] } | null = null
  for (const line of list) {
    const match = /^v\s*([\d.]+)\s*$/.exec(line.trim())
    if (match) {
      current = { version: match[1], items: [] }
      groups.push(current)
    } else if (current) {
      current.items.push(line)
    }
  }
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
 * 引擎行：版本号 + 检查更新按钮。
 *
 * 检查走 npm registry 镜像（GitHub release 资产在这台机器上不可达）；有新版本时给出安装
 * 按钮——下载平台二进制包、装入 `codex-override`，重启应用后生效（引擎表优先用它）。
 */
function EngineUpdateRow({ cliVersion, onInstalled }: { cliVersion: string | null; onInstalled: () => void }) {
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [status, setStatus] = useState<{ current: string; latest: string | null; hasUpdate: boolean } | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const check = (): void => {
    setChecking(true)
    setNote(null)
    invoke<{ current: string; latest: string | null; hasUpdate: boolean }>("codex_check_engine_update")
      .then((result) => {
        setStatus(result)
        if (!result.latest) setNote(t("settings.engineCheckFailed"))
      })
      .catch((error: unknown) => {
        setNote(t("settings.engineCheckFailed"))
        toast.error(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setChecking(false))
  }

  const install = (): void => {
    if (status?.latest === null || status?.latest === undefined) return
    setInstalling(true)
    invoke<string>("codex_install_engine_update", { version: status.latest })
      .then(() => {
        setNote(t("settings.engineInstalled", { version: status.latest }))
        setStatus({ ...status, hasUpdate: false })
        toast.success(t("settings.engineInstalled", { version: status.latest }))
        // Re-read the CLI on disk: the row used to keep showing the version the app launched with
        // until the settings window was reopened.
        onInstalled()
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setInstalling(false))
  }

  const upToDate = status !== null && !status.hasUpdate && status.latest !== null
  return (
    <>
      <SettingRow compact title={t("settings.engine")}>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {t("settings.codexVersion", { version: cliVersion ?? "—" })}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            disabled={checking || installing}
            onClick={check}
          >
            {checking ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden="true" />
            )}
            {t("settings.engineCheckUpdate")}
          </Button>
          {status?.hasUpdate === true && status.latest !== null && (
            <Button size="sm" className="h-7 px-2 text-xs" disabled={installing} onClick={install}>
              {installing && <Spinner data-icon="inline-start" />}
              {t("settings.engineInstall", { version: status.latest })}
            </Button>
          )}
        </div>
      </SettingRow>
      {(upToDate || note !== null) && (
        <p className="px-4 text-xs text-muted-foreground">
          {upToDate ? t("settings.engineUpToDate") : note}
        </p>
      )}
    </>
  )
}
