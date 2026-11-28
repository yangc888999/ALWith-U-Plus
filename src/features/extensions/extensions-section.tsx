import { ask } from "@tauri-apps/plugin-dialog"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { commands } from "@/bindings"
import { LarkCliCard } from "@/features/settings/sections/lark-cli-card"
import { PlaywrightComponentCard } from "@/features/settings/sections/playwright-component-card"

import type { CompanyApp } from "./company-apps"
import { ExtensionMount } from "./extension-view"
import { type ExtensionInstallPhase, ExtensionsManager } from "./extensions-manager"
import { executePreparedInstall } from "./install-service"
import { showExtensionLimitations } from "./legacy/limitations"
import { LEGACY_SOURCE } from "./legacy/profiles"
import { waitForLegacyUninstall } from "./legacy/uninstall"
import { reportExtensionError } from "./runtime"
import { refreshExtensions, updateAndReloadExtension } from "./startup-import-control"
import { useExtensions } from "./use-extensions"

export function ExtensionsSection({ onOpenSurface }: { onOpenSurface?: (id: string) => void }) {
  const { t } = useTranslation()
  const { runtime, state, host } = useExtensions()
  const [operation, setOperation] = useState(false)
  const [installPhase, setInstallPhase] = useState<ExtensionInstallPhase | null>(null)
  const [installingApp, setInstallingApp] = useState<string | null>(null)
  const run = (action: () => Promise<void>): void => {
    setOperation(true)
    void action()
      .catch(reportExtensionError)
      .finally(() => setOperation(false))
  }
  const busy = operation || state.busy
  const install = async (id?: string): Promise<void> => {
    setInstallPhase("preparing")
    try {
      const selected = await commands.extensionPrepareInstall({ expectedId: id ?? null })
      if (!selected) return
      setInstallPhase("installing")
      const result = await executePreparedInstall(
        runtime,
        selected,
        { update: id !== undefined || selected.format === "legacy" },
        {
          stageLegacy: (ticket, converted) => commands.legacyStageImport({ ticket, ...converted })
        }
      )
      if (result.error) throw new Error(result.error.message)
      toast.success(t("extensions.installSuccess", { name: result.id }))
    } finally {
      setInstallPhase(null)
    }
  }
  // A published app is one address: the native side reads its manifest and downloads the code
  // that belongs to it, then the ordinary install path commits the package.
  const installApp = async (app: CompanyApp): Promise<void> => {
    setInstallingApp(app.id)
    setInstallPhase("preparing")
    try {
      const selected = await commands.extensionInstallFromUrl({ manifestUrl: app.manifestUrl })
      if (!selected) return
      setInstallPhase("installing")
      const result = await executePreparedInstall(
        runtime,
        selected,
        { update: selected.format === "legacy" },
        { stageLegacy: (ticket, converted) => commands.legacyStageImport({ ticket, ...converted }) }
      )
      if (result.error) throw new Error(result.error.message)
      toast.success(t("extensions.installSuccess", { name: app.name }))
    } finally {
      setInstallPhase(null)
      setInstallingApp(null)
    }
  }
  return (
    <div className="extensions-section flex w-full flex-col gap-5">
      <ExtensionsManager
        state={state}
        host={host}
        busy={busy}
        installPhase={installPhase}
        installingApp={installingApp}
        onOpenSurface={onOpenSurface}
        onInstall={(id) => run(() => install(id))}
        onInstallApp={(app) => run(() => installApp(app))}
        onRetry={() => run(refreshExtensions)}
        onRequest={(request) =>
          run(async () => {
            await runtime.request(request)
            if (request.type === "enable") {
              await runtime.settled()
              const current = runtime.snapshot()
              if (!current.errors[request.id])
                showExtensionLimitations(current.native?.installations.find((item) => item.id === request.id))
            }
          })
        }
        onReload={(id) =>
          run(async () => {
            const outcome = await updateAndReloadExtension(runtime, id)
            toast.success(
              t(outcome === "updated" ? "extensions.updateReloadSuccess" : "extensions.reloadSuccess", { name: id })
            )
          })
        }
        onUninstall={(id, name) =>
          run(async () => {
            if (
              await ask(t("extensions.uninstallConfirm", { name }), {
                title: t("settings.extensions"),
                kind: "warning"
              })
            ) {
              const legacy =
                runtime.snapshot().native?.installations.find((item) => item.id === id)?.source === LEGACY_SOURCE
              await runtime.request({ type: "beginTransition", id, action: "uninstall" })
              await waitForLegacyUninstall({
                state: () => {
                  const native = runtime.snapshot().native
                  if (!native) throw new Error("扩展安装状态不可用")
                  return {
                    installed: native.installations.some((item) => item.id === id),
                    pending: native.pending.some((item) => item.id === id)
                  }
                },
                subscribe: runtime.subscribe,
                cleanup: async () => {
                  await (legacy
                    ? commands.legacyCleanupImport({ extensionId: id })
                    : commands.extensionCleanupGrants({ extensionId: id }))
                }
              })
            }
          })
        }
        renderSettings={(view) => <ExtensionMount id={view.id} />}
      />

      {/* 「组件」是应用运行依赖的外部 CLI，不是扩展包：单独成区，避免混在扩展列表里。 */}
      <section
        aria-label={t("extensions.components.title")}
        className="flex flex-col gap-3 border-t border-border/60 pt-5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true" className="inline-block h-3.5 w-1 shrink-0 rounded-full bg-[var(--settings-accent)]" />
          <h2 className="text-sm font-medium text-[var(--settings-accent-ink)]">{t("extensions.components.title")}</h2>
          <span className="text-xs text-muted-foreground">{t("extensions.components.description")}</span>
        </div>
        <div className="flex flex-col gap-3">
          <LarkCliCard />
          <PlaywrightComponentCard />
        </div>
      </section>
    </div>
  )
}
