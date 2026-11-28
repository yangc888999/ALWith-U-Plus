import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useComputerStatus } from "@/features/computer/computer-control"
import { enableComputer, reconnectComputer, stopComputer } from "@/features/computer/operations"
import { isMac } from "@/lib/platform"

import { OperationPermissionCenter } from "./operation-permission-center"
import { SettingRow, SettingsCard, SettingsDetails, SettingsNote } from "./shared"

export function ComputerSection() {
  const { t } = useTranslation()
  const { status, error: statusError } = useComputerStatus()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = pending || status?.phase === "verifying" || status?.phase === "stopping"
  const permitted = status?.permissions.accessibility && status.permissions.screenCapture
  const perform = async (operation: () => Promise<unknown>) => {
    setError(null)
    try {
      await operation()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }
  const toggle = async (enabled: boolean) => {
    setPending(true)
    try {
      await perform(enabled ? enableComputer : stopComputer)
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <SettingsCard title={t("computer.title")} desc={t("computer.description")}>
        <SettingRow title={t("computer.enable")}>
          <Switch
            aria-label={t("computer.enable")}
            checked={status?.enabled === true}
            disabled={
              busy || (!status?.enabled && (!status?.available || !status.permissions.supported || !permitted))
            }
            onCheckedChange={(value) => void toggle(value)}
          />
        </SettingRow>
        <SettingsNote>{t("computer.scope")}</SettingsNote>
        {status && !status.permissions.supported && <SettingsNote>{t("computer.unsupported")}</SettingsNote>}
        {status && !status.available && <SettingsNote>{t("computer.missing")}</SettingsNote>}
      </SettingsCard>

      {isMac() && <OperationPermissionCenter />}

      {status?.available && status.permissions.supported && (
        <SettingsCard title={t("computer.connection")} desc={t(`computer.phases.${status.phase ?? "disabled"}`)}>
          <SettingRow title={t("computer.reconnect")} desc={t("computer.reconnectHint")}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !permitted}
              onClick={() => {
                setPending(true)
                void perform(reconnectComputer).finally(() => setPending(false))
              }}
            >
              {busy ? t("computer.verifying") : t("computer.reconnect")}
            </Button>
          </SettingRow>
          {status.diagnostics?.trim() && (
            <SettingsDetails summary={t("computer.diagnostics")}>
              <pre className="max-h-48 overflow-auto break-all whitespace-pre-wrap">{status.diagnostics}</pre>
            </SettingsDetails>
          )}
        </SettingsCard>
      )}

      {(error || statusError || status?.lastError) && (
        <p role="alert" className="px-1 text-sm text-destructive">
          {error ?? status?.lastError ?? statusError}
        </p>
      )}
    </>
  )
}

