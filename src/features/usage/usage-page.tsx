import { useTranslation } from "react-i18next"

import { UsageSection } from "@/features/settings/sections/usage-section"
import "@/features/settings/settings.css"

/** The usage ledger lives beside the other tool pages, not inside Settings. */
export function UsagePage() {
  const { t } = useTranslation()
  return (
    <div data-usage-page="" className="@container h-full min-h-0 overflow-y-auto">
      <div className="w-full min-w-0 px-8 pt-8 pb-6">
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">{t("settings.usage")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("settings.usageDesc")}</p>
        </header>
        <div className="settings-page-body">
          <UsageSection />
        </div>
      </div>
    </div>
  )
}
