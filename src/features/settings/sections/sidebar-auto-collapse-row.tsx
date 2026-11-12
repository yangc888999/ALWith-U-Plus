import { useTranslation } from "react-i18next"

import { Switch } from "@/components/ui/switch"
import { useSidebarAutoCollapsePreference } from "@/features/workspace/sidebar-auto-collapse-preference"

import { SettingRow } from "./shared"

/**
 * Whether the sidebar collapses to a rail and expands on hover.
 *
 * A layout-choice switch kept with the column shares: it only takes effect once four columns is off,
 * so while four columns is on the switch is disabled and the sidebar stays open.
 */
export function SidebarAutoCollapseRow({ compact = false, disabled = false }: { compact?: boolean; disabled?: boolean }) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useSidebarAutoCollapsePreference()
  return (
    <SettingRow
      compact={compact}
      title={t("settings.sidebarAutoCollapse")}
      desc={t("settings.sidebarAutoCollapseDesc")}
    >
      <Switch
        aria-label={t("settings.sidebarAutoCollapse")}
        checked={enabled}
        disabled={disabled}
        onCheckedChange={setEnabled}
      />
    </SettingRow>
  )
}
