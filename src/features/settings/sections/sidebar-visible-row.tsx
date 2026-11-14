import { useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import { settingsStore, updateSettings } from "@/lib/settings-store"
import { Switch } from "@/components/ui/switch"

import { SettingRow } from "./shared"

/**
 * Whether the project conversation opens with the sidebar docked and expanded.
 *
 * The stored key is `appearance.sidebarPinned` — the same value the layout persists when the
 * user toggles the panel from the title bar, so Settings and the layout stay one preference.
 * Off keeps the panel collapsed to the icon rail; clicking a rail entry still expands it.
 */
const KEY = "appearance.sidebarPinned"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)
const read = () => settingsStore.get<boolean>(KEY) ?? true

function useSidebarVisiblePreference(): [boolean, (visible: boolean) => void] {
  const visible = useSyncExternalStore(subscribe, read)
  const setVisible = (next: boolean): void => {
    void updateSettings({ [KEY]: next }).catch(() => undefined)
  }
  return [visible, setVisible]
}

export function SidebarVisibleRow({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const [visible, setVisible] = useSidebarVisiblePreference()
  return (
    <SettingRow compact={compact} title={t("settings.sidebarVisible")} desc={t("settings.sidebarVisibleDesc")}>
      <Switch aria-label={t("settings.sidebarVisible")} checked={visible} onCheckedChange={setVisible} />
    </SettingRow>
  )
}
