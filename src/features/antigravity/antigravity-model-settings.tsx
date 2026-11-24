import { StarIcon } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/alwith-ui/select"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { describeError } from "@/lib/error-text"
import { cn } from "@/lib/utils"

import { SettingRow, SettingsNote } from "../settings/sections/shared"
import {
  ANTIGRAVITY_EFFORTS,
  ANTIGRAVITY_ENABLED_KEY,
  antigravityDefaultModel,
  antigravityEnabled,
  antigravityModelRows,
  setAntigravityDefaultModel,
  setAntigravityModelPreference
} from "./models"

export function AntigravityModelSettings() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(antigravityEnabled)
  const [preferred, setPreferred] = useState(antigravityDefaultModel)
  const [models, setModels] = useState(antigravityModelRows)
  const grid = "grid grid-cols-[minmax(0,1fr)_2.75rem_5.5rem_2rem] items-center gap-2 px-3"

  const save = (change: () => void): void => {
    try {
      change()
      setEnabled(antigravityEnabled())
      setPreferred(antigravityDefaultModel())
      setModels(antigravityModelRows())
    } catch (error) {
      toast.error(describeError(error))
    }
  }

  return (
    <section aria-label={t("antigravity.settingsTitle")} className="space-y-3 rounded-xl border p-3 sm:p-4">
      <SettingRow compact title={t("antigravity.settingsEnable")} desc={t("antigravity.settingsEnableDesc")}>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => save(() => localStorage.setItem(ANTIGRAVITY_ENABLED_KEY, String(next)))}
          aria-label={t("antigravity.settingsEnable")}
        />
      </SettingRow>
      <div className={cn(grid, "text-xs font-medium text-muted-foreground")}>
        <span>{t("provider.columnName")}</span>
        <span className="text-center">{t("provider.columnEnabled")}</span>
        <span>{t("provider.columnEffort")}</span>
        <span className="sr-only">{t("antigravity.preferredModel")}</span>
      </div>
      <ul className="space-y-2">
        {models.map((model) => {
          const pinned = preferred === model.id
          return (
            <li
              key={model.id}
              className={cn(grid, "rounded-lg border py-2", (!enabled || !model.enabled) && "opacity-60")}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium" title={model.label}>
                  {model.label}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground" title={model.id}>
                  {model.id}
                </div>
              </div>
              <Switch
                className="justify-self-center"
                checked={model.enabled}
                disabled={!enabled}
                aria-label={`${t("provider.columnEnabled")} · ${model.label}`}
                onCheckedChange={(next) => save(() => setAntigravityModelPreference(model.id, { enabled: next }))}
              />
              <Select
                value={model.effort ?? "auto"}
                onValueChange={(next) =>
                  save(() => setAntigravityModelPreference(model.id, { effort: next === "auto" ? null : next }))
                }
                disabled={!enabled || !model.enabled}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={`${t("provider.modelDefaultEffort")} · ${model.label}`}
                  title={t("provider.modelDefaultEffortHint")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("provider.modelEffortAuto")}</SelectItem>
                  {ANTIGRAVITY_EFFORTS.map((effort) => (
                    <SelectItem
                      key={effort}
                      value={effort}
                      title={t(`defaultModel.effortLevels.${effort}`, { defaultValue: "" })}
                    >
                      {effort}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                title={t("antigravity.preferredModel")}
                aria-label={`${t("antigravity.preferredModel")} · ${model.label}`}
                aria-pressed={pinned}
                disabled={!enabled || !model.enabled}
                onClick={() => save(() => setAntigravityDefaultModel(model.id))}
              >
                <StarIcon
                  aria-hidden="true"
                  className={pinned ? "fill-current text-primary" : "text-muted-foreground"}
                />
              </Button>
            </li>
          )
        })}
      </ul>
      <SettingsNote>{t("antigravity.modelsHint")}</SettingsNote>
      <SettingsNote>{t("antigravity.settingsNote")}</SettingsNote>
    </section>
  )
}
