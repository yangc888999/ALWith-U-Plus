import { SlidersHorizontalIcon } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { UsageSection } from "@/features/settings/sections/usage-section"
import "@/features/settings/settings.css"

/** The usage ledger lives beside the other tool pages, not inside Settings. */
export function UsagePage() {
  const { t } = useTranslation()
  const [priceConfigOpen, setPriceConfigOpen] = useState(false)
  return (
    <div data-usage-page="" className="@container h-full min-h-0 overflow-y-auto">
      <div className="w-full min-w-0 px-8 pt-8 pb-6">
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">{t("settings.usage")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t("settings.usageDesc")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-haspopup="dialog"
            onClick={() => setPriceConfigOpen(true)}
          >
            <SlidersHorizontalIcon className="size-3.5" aria-hidden="true" />
            {t("usageReport.priceConfig")}
          </Button>
        </header>
        <div className="settings-page-body">
          <UsageSection priceConfigOpen={priceConfigOpen} onPriceConfigOpenChange={setPriceConfigOpen} />
        </div>
      </div>
    </div>
  )
}
