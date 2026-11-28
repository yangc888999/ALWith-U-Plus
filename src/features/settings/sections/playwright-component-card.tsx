// 「工作台 → 扩展 → 组件 → Playwright 浏览器」。
//
// The browser is optional and much larger than the app update itself, so the card owns its own
// install/update lifecycle. The managed directory is injected into agent processes by Rust as
// PLAYWRIGHT_BROWSERS_PATH; a project that pins Playwright can reuse the same headless shell.

import { isTauri } from "@tauri-apps/api/core"
import { DownloadIcon, ExternalLinkIcon, Globe2Icon, RefreshCwIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import type { PlaywrightComponentStatus, PlaywrightUpdateCheck } from "@/bindings"
import { commands } from "@/bindings"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { openExternal } from "@/lib/open"

import { ComponentInstallPanel, ComponentMeta, ComponentMetaGrid, ComponentStatusPill } from "./component-card-parts"
import { SettingsCard, SettingsNote } from "./shared"

const PLAYWRIGHT_RELEASES = "https://github.com/microsoft/playwright/releases"

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
      icon={<Globe2Icon />}
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ComponentStatusPill
            ok={installed}
            busy={busy === "install"}
            label={
              status === null
                ? t("support.checking")
                : busy === "install"
                  ? t("support.installing")
                  : installed
                    ? t("support.playwrightInstalled")
                    : t("support.playwrightNotInstalled")
            }
          />
          {installed && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-[10px]"
              disabled={!installed || busy !== null}
              onClick={checkUpdate}
            >
              {busy === "check" ? <Spinner className="size-3" /> : <RefreshCwIcon className="size-3" />}
              {t("support.playwrightCheckUpdate")}
            </Button>
          )}
          {update?.hasUpdate === true && (
            <Button size="sm" className="h-7 px-2 text-[10px]" disabled={busy !== null} onClick={updateNow}>
              {busy === "update" && <Spinner className="size-3" />}
              {t("support.playwrightUpdateNow")}
            </Button>
          )}
        </div>
      }
    >
      {status === null ? (
        <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
          <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
          {t("support.checking")}
        </div>
      ) : !installed ? (
        <div>
          <ComponentInstallPanel
            icon={<DownloadIcon className="size-3.5" />}
            title={t("support.playwrightInstall")}
            description={t("support.playwrightDesc")}
            actionLabel={t("support.playwrightInstall")}
            busyLabel={t("support.installing")}
            busy={busy === "install"}
            onAction={install}
          />
          <span
            className="mt-2 block max-w-full truncate font-mono text-[10px] leading-4 text-muted-foreground/70"
            title={status.installDir}
          >
            {status.installDir}
          </span>
          {status.hint !== "" && <span className="mt-1 block text-[11px] text-muted-foreground">{status.hint}</span>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <ComponentMetaGrid>
            <ComponentMeta
              label={t("support.playwrightVersion")}
              value={t("support.playwrightCoreVersion", { version })}
              sub={status.browserVersion ?? undefined}
            />
            <ComponentMeta
              label="Headless Shell"
              value={t("support.playwrightHeadlessVersion", { revision })}
              sub="Chromium Headless Shell"
            />
            <ComponentMeta
              label={t("support.path")}
              value={
                <span className="truncate font-mono text-[10px] font-normal" title={status.browserPath ?? status.installDir}>
                  {status.browserPath ?? status.installDir}
                </span>
              }
            />
          </ComponentMetaGrid>
          {update !== null && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
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
          {status.hint !== "" && <span className="text-[11px] leading-4 text-muted-foreground">{status.hint}</span>}
          <SettingsNote>{t("support.playwrightUsageHint")}</SettingsNote>
          <div className="flex justify-end">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[10px] text-primary underline-offset-2 hover:underline"
              onClick={() => void openExternal(PLAYWRIGHT_RELEASES)}
            >
              <ExternalLinkIcon className="size-3" />
              {t("support.playwrightReleases")}
            </button>
          </div>
        </div>
      )}
    </SettingsCard>
  )
}
