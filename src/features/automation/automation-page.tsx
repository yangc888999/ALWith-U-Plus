// 主窗口内的「定时任务」页。
//
// 以前侧边栏这一行是 `openSettingsWindow("automation")`：点一下就被扔进设置窗口，聊天现场
// 直接丢掉。现在它和 WorkBuddy 一样留在主窗口里——侧边栏不动，右侧内容区换成任务列表
// （2026-11-08）。
import { CalendarClockIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { AutomationSection } from "./automation-section"

export function AutomationPage() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="mb-5 flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <CalendarClockIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-6">{t("settings.automation")}</h1>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t("automation.pageDesc")}</p>
        </div>
      </header>
      <AutomationSection />
    </div>
  )
}
