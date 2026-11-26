import { LayoutGridIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react"
import { type ReactElement, type ReactNode, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { WORKBENCH_GROUPS, type WorkbenchFeatureId, type WorkbenchPage } from "./workbench-features"

const EXPANDED_KEY = "alwith.workbench.navigation.expanded"

function initialExpanded(): boolean {
  try {
    const saved = localStorage.getItem(EXPANDED_KEY)
    if (saved !== null) return saved === "true"
  } catch {
    // Storage can be unavailable in tests or a locked-down webview; use the viewport default.
  }
  return typeof window !== "undefined" && window.innerWidth >= 900
}

export function LeadingNavigation({
  activePage,
  onOpenOverview,
  onOpenPlugins,
  onOpenExtensions,
  onOpenArchives,
  onOpenAutomation,
  onOpenGroups,
  onOpenUsage,
  onOpenSkills,
  children
}: {
  activePage: WorkbenchPage | null
  children?: ReactNode
  onOpenOverview: () => void
  onOpenPlugins: () => void
  onOpenExtensions: () => void
  onOpenArchives: () => void
  onOpenAutomation: () => void
  onOpenGroups: () => void
  onOpenUsage: () => void
  onOpenSkills: () => void
}): ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(initialExpanded)
  const handlers: Record<WorkbenchFeatureId, () => void> = {
    plugins: onOpenPlugins,
    extensions: onOpenExtensions,
    skills: onOpenSkills,
    groups: onOpenGroups,
    automation: onOpenAutomation,
    archives: onOpenArchives,
    usage: onOpenUsage
  }

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, String(expanded))
    } catch {
      // Preference persistence is best-effort; navigation still works for this session.
    }
  }, [expanded])

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 899px)")
    if (media === undefined) return
    const collapse = (event: MediaQueryListEvent): void => {
      if (event.matches) setExpanded(false)
    }
    media.addEventListener("change", collapse)
    return () => media.removeEventListener("change", collapse)
  }, [])

  const navButton = (id: WorkbenchPage, label: string, icon: ReactNode, onClick: () => void): ReactElement => {
    const button = (
      <button
        key={id}
        type="button"
        aria-label={label}
        aria-current={activePage === id ? "page" : undefined}
        onClick={onClick}
        data-active={activePage === id ? "" : undefined}
        className="workbench-nav-item leading-navigation-item"
      >
        <span className="workbench-nav-icon">{icon}</span>
        <span className="workbench-nav-label">{label}</span>
      </button>
    )
    return expanded ? (
      button
    ) : (
      <Tooltip key={id}>
        <TooltipTrigger render={button} />
        <TooltipContent side="inline-end">{label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <nav
      aria-label={t("workbench.navigation")}
      className="leading-navigation"
      data-expanded={expanded ? "" : undefined}
    >
      <div className="workbench-nav-header">
        <span className="workbench-nav-title">{t("workbench.title")}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ms-auto shrink-0 text-muted-foreground"
          aria-label={t(expanded ? "workbench.collapse" : "workbench.expand")}
          title={t(expanded ? "workbench.collapse" : "workbench.expand")}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <PanelLeftCloseIcon className="size-4" aria-hidden="true" />
          ) : (
            <PanelLeftOpenIcon className="size-4" aria-hidden="true" />
          )}
        </Button>
      </div>

      <div className="workbench-nav-primary">
        {navButton("overview", t("workbench.overview"), <LayoutGridIcon className="size-[18px]" aria-hidden="true" />, onOpenOverview)}
        {WORKBENCH_GROUPS.map((group) => (
          <div key={group.id} className="workbench-nav-group">
            <div className="workbench-nav-group-label">{t(group.labelKey)}</div>
            {group.items.map(({ id, labelKey, icon: Icon }) =>
              navButton(id, t(labelKey), <Icon className="size-[18px]" aria-hidden="true" />, handlers[id])
            )}
          </div>
        ))}
      </div>
      {children}
    </nav>
  )
}
