import { useTranslation } from "react-i18next"

import { Switch } from "@/components/ui/switch"
import { usePreviewVisiblePreference } from "@/features/workspace/preview-visible-preference"

import { SettingRow } from "./shared"

/**
 * Whether the preview column opens with a project conversation.
 *
 * Sits with the column shares because it decides the same thing one level earlier: the shares say how
 * wide each column is, this says whether the preview is there when the chat opens. Only writable when
 * four columns is off — with four columns on the preview is forced on and this switch is disabled.
 */
export function PreviewVisibleRow({ compact = false, disabled = false }: { compact?: boolean; disabled?: boolean }) {
  const { t } = useTranslation()
  const [visible, setVisible] = usePreviewVisiblePreference()
  return (
    <SettingRow compact={compact} title={t("settings.previewVisible")} desc={t("settings.previewVisibleDesc")}>
      <Switch
        aria-label={t("settings.previewVisible")}
        checked={visible}
        disabled={disabled}
        onCheckedChange={setVisible}
      />
    </SettingRow>
  )
}
