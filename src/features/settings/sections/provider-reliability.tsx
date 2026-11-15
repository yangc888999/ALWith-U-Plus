// The two reliability switches that belong to the provider page as a whole.
//
// Both are on by default, and both exist because the alternative is worse than a retry: a dropped
// connection used to cost the whole turn, and a model that went quiet for two minutes used to sit
// there until the reader gave up. Neither switch changes what the model is asked — one re-sends the
// same request, the other types 「继续」 into the turn that is already running.
//
// They are one compact block at the top of 设置 → 大模型 rather than two rows buried in a provider
// card: they apply to every provider, and a switch that only shows up under OpenRouter reads as an
// OpenRouter setting.

import { useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import { Switch } from "@/components/ui/switch"
import { autoNudgeEnabled, setAutoNudgeEnabled, subscribeAutoNudge } from "@/lib/auto-nudge"
import {
  gatewayRetryEnabled,
  setGatewayRetryEnabled,
  subscribeGatewayRetryEnabled
} from "@/lib/gateway-retry-settings"

/** One switch plus the sentence that explains it. Shared by both rows so they stay identical. */
function ReliabilityRow({
  title,
  desc,
  checked,
  onChange
}: {
  title: string
  desc: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
    </div>
  )
}

export function ProviderReliabilitySettings() {
  const { t } = useTranslation()
  // Both values live in module stores, so a change made in the chat window reaches this switch
  // without a reload — and vice versa.
  const retry = useSyncExternalStore(subscribeGatewayRetryEnabled, gatewayRetryEnabled, gatewayRetryEnabled)
  const nudge = useSyncExternalStore(subscribeAutoNudge, autoNudgeEnabled, autoNudgeEnabled)

  return (
    <div
      className="mb-3 flex flex-col gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5"
      data-provider-reliability=""
    >
      <p className="text-xs font-medium text-muted-foreground">{t("settings.providerReliability")}</p>
      <ReliabilityRow
        title={t("settings.autoRetry")}
        desc={t("settings.autoRetryDesc")}
        checked={retry}
        onChange={setGatewayRetryEnabled}
      />
      <ReliabilityRow
        title={t("settings.autoNudge")}
        desc={t("settings.autoNudgeDesc")}
        checked={nudge}
        onChange={setAutoNudgeEnabled}
      />
    </div>
  )
}
