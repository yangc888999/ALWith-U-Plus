import { useTranslation } from "react-i18next"

import { SkillsSection } from "@/features/settings/sections/skills-section"
import "@/features/settings/settings.css"

/** Local skill management, promoted out of Settings into the tool pages. */
export function SkillsPage() {
  const { t } = useTranslation()
  return (
    <div data-skills-page="" className="@container h-full min-h-0 overflow-y-auto">
      <div className="w-full min-w-0 px-8 pt-8 pb-6">
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">{t("settings.skills")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("settings.skillsDesc")}</p>
        </header>
        <div className="settings-page-body">
          <SkillsSection />
        </div>
      </div>
    </div>
  )
}
