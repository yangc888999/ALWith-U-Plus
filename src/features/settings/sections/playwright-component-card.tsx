// 「工作台 → 扩展 → 组件 → Playwright 浏览器」。
//
// The browser is optional and much larger than the app update itself, so the card owns its own
// install/update lifecycle. The managed directory is injected into agent processes by Rust as
// PLAYWRIGHT_BROWSERS_PATH; a project that pins Playwright can reuse the same headless shell.

import { isTauri } from "@tauri-apps/api/core"
import { CheckCircle2Icon, DownloadIcon, ExternalLinkIcon, RefreshCwIcon, XCircleIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import type { PlaywrightComponentStatus, PlaywrightUpdateCheck } from "@/bindings"
import { commands } from "@/bindings"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { openExternal } from "@/lib/open"

import { SettingRow, SettingsCard } from "./shared"

const PLAYWRIGHT_RELEASES = "https://github.com/microsoft/playwright/releases"

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        ok ? "border-emerald-500/30 text-emerald-600" : "border-amber-500/30 text-amber-600"
      }`}
    >
      {ok ? <CheckCircle2Icon className="size-3.5" /> : <XCircleIcon className="size-3.5" />}
      {label}
    </span>
  )
}

export function PlaywrightComponentCard() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<PlaywrightComponentStatus | null>(null)
  const [update, setUpdate] = useState<PlaywrightUpdateCheck | null>(null)
  const [busy, setBusy] = useState<"install" | "check" | "update" | null>(null)

  const load = useCallback((): void => {
    if (!isTauri()) return
    void commands
      .playwrightComponentStatus()
      .then(setStatus)
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const install = (): void => {
    if (!isTauri()) return
    setBusy("install")
    void commands
      .playwrightComponentInstall()
      .then((result) => {
        if (result.ok) {
          toast.success(t("support.playwrightInstallSuccess"))
          setUpdate(null)
          load()
        } else {
          toast.error(result.message)
        }
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(null))
  }

  const checkUpdate = (): void => {
    if (!isTauri() || !status?.installed) return
    setBusy("check")
    void commands
      .playwrightComponentCheckUpdate()
      .then(setUpdate)
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(null))
  }

  const updateNow = (): void => {
    if (!isTauri() || !status?.installed) return
    setBusy("update")
    void commands
      .playwrightComponentUpdate()
      .then((result) => {
        if (result.ok) {
          toast.success(t("support.playwrightUpdateSuccess"))
          setUpdate(null)
          load()
        } else {
          toast.error(result.message)
        }
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(null))
  }

  const installed = status?.installed ?? false
  const version = status?.version ?? "—"
  const revision = status?.browserRevision ?? "—"
  return (
    <SettingsCard
      title={t("support.playwrightTitle")}
      desc={t("support.playwrightDesc")}
      action={
        <StatusPill
          ok={installed}
          label={installed ? t("support.playwrightInstalled") : t("support.playwrightNotInstalled")}
        />
      }
    >
      <SettingRow compact title={t("support.playwrightVersion")}>
        <div className="flex min-w-0 flex-col items-start gap-1.5 md:items-end">
          <div className="flex flex-wrap items-center justify-start gap-2 md:justify-end">
            <span className="text-sm text-muted-foreground">
              {t("support.playwrightCoreVersion", { version })}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {t("support.playwrightHeadlessVersion", { revision })}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              disabled={!installed || busy !== null}
              onClick={checkUpdate}
            >
              {busy === "check" ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon className="size-3.5" />}
              {t("support.playwrightCheckUpdate")}
            </Button>
            {update?.hasUpdate === true && (
              <Button size="sm" className="h-7 px-2 text-xs" disabled={busy !== null} onClick={updateNow}>
                {busy === "update" && <Spinner data-icon="inline-start" />}
                {t("support.playwrightUpdateNow")}
              </Button>
            )}
            {!installed && (
              <Button size="sm" className="h-7 gap-1.5 px-2.5 text-xs" disabled={busy !== null} onClick={install}>
                {busy === "install" ? <Spinner data-icon="inline-start" /> : <DownloadIcon className="size-3.5" />}
                {t("support.playwrightInstall")}
              </Button>
            )}
          </div>
          {update !== null && (
            <div className="flex flex-wrap items-center justify-start gap-2 text-[11px] text-muted-foreground md:justify-end">
              <span>{update.message}</span>
              {update.url !== null && update.url !== "" && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                  onClick={() => void openExternal(update.url ?? "")}
                >
                  <ExternalLinkIcon className="size-3" />
                  {t("support.playwrightReleases")}
                </button>
              )}
            </div>
          )}
          {status?.browserPath && (
            <span
              className="block max-w-full truncate text-left font-mono text-[10px] leading-4 text-muted-foreground/70 md:text-right"
              title={status.browserPath}
            >
              {status.browserPath}
            </span>
          )}
          {status !== null && !status.browserPath && (
            <span
              className="block max-w-full truncate text-left font-mono text-[10px] leading-4 text-muted-foreground/70 md:text-right"
              title={status.installDir}
            >
              {status.installDir}
            </span>
          )}
          {status?.hint && <span className="text-[11px] leading-4 text-muted-foreground">{status.hint}</span>}
        </div>
      </SettingRow>
      <SettingRow compact title={t("support.playwrightUsage")} desc={t("support.playwrightUsageHint")}>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
          onClick={() => void openExternal(PLAYWRIGHT_RELEASES)}
        >
          <ExternalLinkIcon className="size-3" />
          {t("support.playwrightReleases")}
        </button>
      </SettingRow>
    </SettingsCard>
  )
}
