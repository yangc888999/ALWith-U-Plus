import { ArchiveIcon, BlocksIcon, GaugeIcon, PuzzleIcon, SparklesIcon } from "lucide-react"
import type { ReactElement, ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function LeadingNavigation({
  activePage,
  onOpenPlugins,
  onOpenExtensions,
  onOpenArchives,
  onOpenUsage,
  onOpenSkills,
  children
}: {
  activePage: "plugins" | "extensions" | "archives" | "usage" | "skills" | null
  children?: ReactNode
  onOpenPlugins: () => void
  onOpenExtensions: () => void
  onOpenArchives: () => void
  onOpenUsage: () => void
  onOpenSkills: () => void
}): ReactElement {
  const { t } = useTranslation()
  const items = [
    { id: "plugins", label: t("sidebar.plugins"), icon: PuzzleIcon, onClick: onOpenPlugins },
    { id: "extensions", label: t("sidebar.features"), icon: BlocksIcon, onClick: onOpenExtensions },
    { id: "skills", label: t("sidebar.skills"), icon: SparklesIcon, onClick: onOpenSkills },
    { id: "archives", label: t("archives.title"), icon: ArchiveIcon, onClick: onOpenArchives },
    { id: "usage", label: t("settings.usage"), icon: GaugeIcon, onClick: onOpenUsage }
  ] as const

  return (
    <nav aria-label={t("sidebar.leadingNavigation")} className="leading-navigation">
      {items.map(({ id, label, icon: Icon, onClick }) => {
        const button = (
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            aria-current={activePage === id ? "page" : undefined}
            onClick={onClick}
            data-active={activePage === id ? "" : undefined}
            className="leading-navigation-item relative size-9 rounded-[10px] text-muted-foreground hover:text-foreground aria-[current=page]:text-foreground motion-reduce:transition-none"
          >
            <Icon aria-hidden="true" className="size-[18px]" />
          </Button>
        )
        return (
          <Tooltip key={id}>
            <TooltipTrigger render={button} />
            <TooltipContent side="inline-end">{label}</TooltipContent>
          </Tooltip>
        )
      })}
      {children}
    </nav>
  )
}
