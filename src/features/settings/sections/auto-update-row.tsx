import { useState, useSyncExternalStore } from "react"
import { openExternal } from "@/lib/open"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { commands } from "@/bindings"
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
        // One sentence, not two rows: the source is part of "how this works", and stacking it on a
        // second line read as an unrelated item under the switch (2026-11-17).
        <span>
          {t("settings.autoUpdateDesc")}{" "}
          <button
            type="button"
            className="w-fit text-left text-muted-foreground underline decoration-current/30 underline-offset-2 transition-colors hover:text-foreground hover:decoration-current"
            onClick={() => void openExternal(PROJECT_URL).catch(() => undefined)}
          >
            {t("settings.autoUpdateFeed")}
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
          void (async () => {
            try {
              await updateSettings({ "updater.autoUpdate": value })
              // Turning it on checks right away instead of waiting for the hourly tick; a failed
              // check lands in the updater state, which the About page already explains.
              if (value) await commands.updaterCheckNow().catch(() => undefined)
            } catch (error) {
              toast.error(error instanceof Error ? error.message : String(error))
            } finally {
              setPending(false)
            }
          })()
        }}
      />
    </SettingRow>
  )
}
