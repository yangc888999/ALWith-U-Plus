// 主窗口内的「定时任务」页。
//
// 以前侧边栏这一行是 `openSettingsWindow("automation")`：点一下就被扔进设置窗口，聊天现场
// 直接丢掉。现在它和 WorkBuddy 一样留在主窗口里——侧边栏不动，右侧内容区换成任务列表
// （2026-11-08）。
import { useTranslation } from "react-i18next"

import { ScheduledTasksGlyph } from "@/features/layout/components/feature-glyphs"

import { AutomationSection } from "./automation-section"

export function AutomationPage({ onOpenExtensions }: { onOpenExtensions: () => void }) {
  const { t } = useTranslation()
  return (
    <div data-automation-page="" className="@container h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-8 sm:px-6 lg:px-8">
        <header className="mb-5 flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <ScheduledTasksGlyph className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl leading-7 font-semibold">{t("settings.automation")}</h1>
            <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">{t("automation.pageDesc")}</p>
          </div>
        </header>
        <AutomationSection onOpenExtensions={onOpenExtensions} />
      </div>
    </div>
  )
}
