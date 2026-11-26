import type { ExtensionManifest } from "@alwith/module-extension"
import { type HostSnapshot, resolveActionTarget } from "@alwith/module-extension/host"
import type { ReactElement } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { extensionApps } from "./extension-apps"
import { EXTENSION_ICONS } from "./extension-icons"

export function ExtensionNavigation({
  host,
  manifests,
  activeView,
  onOpenSurface,
  onError
}: {
  host: HostSnapshot
  manifests: ExtensionManifest[]
  activeView?: string | null
  onOpenSurface: (id: string) => void
  onError: (error: unknown) => void
}): ReactElement | null {
  const { t, i18n } = useTranslation()
  const apps = extensionApps(host, manifests, i18n.language)
  if (!apps.length) return null
  return (
    <>
      <div className="workbench-nav-separator">
        <Separator className="h-px bg-[var(--chrome-hover-background)]" />
      </div>
      <section
        aria-label={t("extensions.outlets.navigation")}
        className="workbench-nav-group workbench-nav-extension-list"
      >
        <div className="workbench-nav-group-label">{t("workbench.groups.extensions")}</div>
        {apps.map(({ action, name }) => {
          const target = resolveActionTarget(host, action)
          const active = host.views.some((view) => view.id === activeView && view.extensionId === action.extensionId)
          const Icon = EXTENSION_ICONS[action.icon ?? "blocks"]
          return (
            <Tooltip key={action.extensionId}>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={name}
                    aria-current={active ? "page" : undefined}
                    disabled={!target}
                    data-active={active ? "" : undefined}
                    className="workbench-nav-item leading-navigation-item disabled:opacity-40"
                    onClick={() => {
                      void Promise.resolve()
                        .then(() => {
                          if (target?.type === "command") return target.command.run()
                          if (target?.type === "surface") return onOpenSurface(target.view.id)
                          throw new Error(`Extension action target unavailable: ${action.target.id}`)
                        })
                        .catch(onError)
                    }}
                  >
                    <span className="workbench-nav-icon">
                      <Icon aria-hidden="true" className="size-[18px]" />
                    </span>
                    <span className="workbench-nav-label">{name}</span>
                  </Button>
                }
              />
              <TooltipContent side="inline-end">
                {target ? name : t("extensions.targetUnavailable", { name })}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </section>
    </>
  )
}
