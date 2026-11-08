import { useTranslation } from "react-i18next"

import { Switch } from "@/components/ui/switch"
import { useTreeVisiblePreference } from "@/features/workspace/tree-visible-preference"

import { SettingRow } from "./shared"

/**
 * The file column is part of the workspace layout, so its switch sits with the column shares.
 * It writes the same preference as the folder button in the tree header, which is why closing it
 * there also turns this switch off.
 */
export function TreeVisibleRow({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const [visible, setVisible] = useTreeVisiblePreference()
  return (
    <SettingRow compact={compact} title={t("settings.treeVisible")} desc={t("settings.treeVisibleDesc")}>
      <Switch
        aria-label={t("settings.treeVisible")}
        checked={visible}
        onCheckedChange={setVisible}
      />
    </SettingRow>
  )
}
