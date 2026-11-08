import { useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Switch } from "@/components/ui/switch"
import { settingsStore, updateSettings } from "@/lib/settings-store"

import { SettingRow } from "./shared"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)
const read = () => settingsStore.get<boolean>("updater.autoUpdate") === true

export function AutoUpdateRow({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const enabled = useSyncExternalStore(subscribe, read)
  const [pending, setPending] = useState(false)
  return (
    <SettingRow compact={compact} title={t("settings.autoUpdate")} desc={t("settings.autoUpdateDesc")}>
      <Switch
        aria-label={t("settings.autoUpdate")}
        checked={enabled}
        disabled={pending}
        onCheckedChange={(value) => {
          setPending(true)
          void updateSettings({ "updater.autoUpdate": value })
            .catch((error: unknown) => toast.error(String(error)))
            .finally(() => setPending(false))
        }}
      />
    </SettingRow>
  )
}
