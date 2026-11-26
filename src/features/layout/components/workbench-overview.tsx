import { ChevronRightIcon, LayoutGridIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"

import { WORKBENCH_GROUPS, type WorkbenchFeatureId, type WorkbenchFeatureGroup } from "./workbench-features"

/** The workbench landing page: a grouped list of destinations, deliberately not a card grid. */
export function WorkbenchOverview({ onOpen }: { onOpen: (page: WorkbenchFeatureId) => void }) {
  const { t } = useTranslation()
  const groups = new Map(WORKBENCH_GROUPS.map((group) => [group.id, group]))
  const capabilities = groups.get("capabilities")
  const workflow = groups.get("workflow")
  const records = groups.get("records")
  return (
    <div data-workbench-overview="" className="@container h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-4 pt-8 pb-10 sm:px-6 lg:px-8">
        <header className="mb-6 flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <LayoutGridIcon className="size-[18px]" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl leading-7 font-semibold">{t("workbench.title")}</h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">{t("workbench.overviewDesc")}</p>
          </div>
        </header>

        <div className="grid min-w-0 grid-cols-1 gap-7 @3xl:grid-cols-2 @3xl:gap-10">
          {capabilities !== undefined && <OverviewGroup group={capabilities} onOpen={onOpen} />}
          <div className="flex min-w-0 flex-col gap-7">
            {workflow !== undefined && <OverviewGroup group={workflow} onOpen={onOpen} />}
            {records !== undefined && <OverviewGroup group={records} onOpen={onOpen} />}
          </div>
        </div>
      </div>
    </div>
  )
}

function OverviewGroup({
  group,
  onOpen
}: {
  group: WorkbenchFeatureGroup
  onOpen: (page: WorkbenchFeatureId) => void
}) {
  const { t } = useTranslation()
  return (
    <section aria-labelledby={`workbench-group-${group.id}`} className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-3 px-1">
        <h2 id={`workbench-group-${group.id}`} className="text-[11px] font-medium tracking-wide text-muted-foreground">
          {t(group.labelKey)}
        </h2>
        <span className="text-[11px] text-muted-foreground">{t(`workbench.groupDescriptions.${group.id}`)}</span>
      </div>
      <div className="border-y border-border/55">
        {group.items.map(({ id, labelKey, descriptionKey, icon: Icon }, index) => (
          <button
            key={id}
            type="button"
            onClick={() => onOpen(id)}
            className={cn(
              "group flex w-full items-start gap-3 px-1 py-2.5 text-start transition-colors hover:bg-foreground/[0.035] focus-visible:bg-foreground/[0.045] focus-visible:outline-none",
              index > 0 && "border-t border-border/45"
            )}
          >
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted/70 text-muted-foreground group-hover:text-foreground">
              <Icon className="size-[18px]" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] leading-5 font-medium">{t(labelKey)}</span>
              <span className="mt-0.5 block text-xs leading-5 text-foreground/65">{t(descriptionKey)}</span>
            </span>
            <ChevronRightIcon
              className="mt-1.5 size-3.5 shrink-0 text-muted-foreground/35 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground"
              aria-hidden="true"
            />
          </button>
        ))}
      </div>
    </section>
  )
}
