import { useTranslation } from "react-i18next"

import { Switch } from "@/components/ui/switch"
import { setFourColumnsDefault, useFourColumnsDefault } from "@/features/workspace/four-columns-preference"

import { SettingRow } from "./shared"

/**
 * Whether a project conversation starts with the preview column already open.
 *
 * It sits with the column shares because it decides the same thing one level earlier: the shares
 * say how wide each column is, this says whether the fourth one is there when the chat opens.
 */
export function FourColumnsRow({ compact = false, disabled = false }: { compact?: boolean; disabled?: boolean }) {
  const { t } = useTranslation()
  const enabled = useFourColumnsDefault()
  return (
    <SettingRow compact={compact} title={t("settings.fourColumnsDefault")} desc={t("settings.fourColumnsDefaultDesc")}>
      <Switch
        aria-label={t("settings.fourColumnsDefault")}
        checked={enabled}
        disabled={disabled}
        onCheckedChange={(next) => void setFourColumnsDefault(next)}
      />
    </SettingRow>
  )
}
