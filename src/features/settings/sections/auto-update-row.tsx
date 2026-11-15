import { useState, useSyncExternalStore } from "react"
import { openExternal } from "@/lib/open"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Switch } from "@/components/ui/switch"
import { settingsStore, updateSettings } from "@/lib/settings-store"

import { SettingRow } from "./shared"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)
const read = () => settingsStore.get<boolean>("updater.autoUpdate") === true
const PROJECT_URL = "https://github.com/yangc888999/ALWith-U-Plus"

export function AutoUpdateRow({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const enabled = useSyncExternalStore(subscribe, read)
  const [pending, setPending] = useState(false)
  return (
    <SettingRow
      compact={compact}
      title={t("settings.autoUpdate")}
      desc={
        <span className="inline-flex flex-wrap items-center gap-1">
          <span>{t("settings.autoUpdateDesc")}</span>
          <button
            type="button"
            className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
            onClick={() => void openExternal(PROJECT_URL).catch(() => undefined)}
          >
            GitHub 项目地址
          </button>
        </span>
      }
    >
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
