import { useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/alwith-ui/select"
import { commands } from "@/bindings"
import {
  companyModelReasoningSnapshot,
  setCompanyModelReasoning,
  subscribeCompanyModelReasoning,
  type CompanyReasoningLevel
} from "@/lib/company-model-config"

import { SettingsNote } from "./shared"

/**
 * The company model's default reasoning level, kept as one row inside 「供应商与可用模型」.
 *
 * It used to own a whole SettingsCard above the provider list. That put a single dropdown on the
 * same visual level as the model and provider cards, and separated a setting that only makes sense
 * next to the models it applies to. Self-contained so the provider section does not need to know
 * about the reasoning store; the backend mirrors the choice into the engine catalog.
 */
export function CompanyReasoningRow() {
  const { t } = useTranslation()
  const config = useSyncExternalStore(
    subscribeCompanyModelReasoning,
    companyModelReasoningSnapshot,
    companyModelReasoningSnapshot
  )
  const changeLevel = (level: CompanyReasoningLevel): void => {
    setCompanyModelReasoning(level)
    void commands
      .setCompanyModelReasoning({ level })
      .catch((failure: unknown) => console.error("[company-model] push failed", failure))
  }
  return (
    <div className="border-t border-border/60 pt-3">
      <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,16rem)_12rem]">
        <span className="text-sm">{t("companyModel.reasoningLabel")}</span>
        <Select
          value={config.reasoningLevel}
          items={[
            { label: t("companyModel.levels.low"), value: "low" },
            { label: t("companyModel.levels.high"), value: "high" },
            { label: t("companyModel.levels.max"), value: "max" }
          ]}
          onValueChange={(value) => changeLevel((value ?? "max") as CompanyReasoningLevel)}
        >
          <SelectTrigger className="w-full" aria-label={t("companyModel.reasoningLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">{t("companyModel.levels.low")}</SelectItem>
            <SelectItem value="high">{t("companyModel.levels.high")}</SelectItem>
            <SelectItem value="max">{t("companyModel.levels.max")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <SettingsNote>{t("companyModel.note")}</SettingsNote>
    </div>
  )
}
