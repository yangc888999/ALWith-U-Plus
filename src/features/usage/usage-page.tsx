import { ChartColumnIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { UsageSection } from "@/features/settings/sections/usage-section"
import "@/features/settings/settings.css"

/** The usage ledger lives beside the other tool pages, not inside Settings. */
export function UsagePage() {
  const { t } = useTranslation()
  return (
    <div data-usage-page="" className="h-full min-h-0 overflow-y-auto">
      <div className="w-full min-w-0 px-8 pt-8 pb-14">
        <header className="mb-6 flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--settings-accent-soft)] text-[var(--settings-accent-ink)] ring-1 ring-[color-mix(in_oklab,var(--settings-accent)_22%,transparent)]">
            <ChartColumnIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{t("settings.usage")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("settings.usageDesc")}</p>
          </div>
        </header>
        <UsageSection />
      </div>
    </div>
  )
}
