// Settings → 操作电脑 → 授权中心.
//
// macOS exposes real status for six TCC permissions through macos-privacy. The other panes have
// no supported query API; they are still listed here with a direct System Settings link, labelled
// as "needs confirmation" instead of pretending to know whether access was granted.

import { isTauri } from "@tauri-apps/api/core"
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import type { OperationPermissionStatus } from "@/bindings"
import { commands } from "@/bindings"
import { Button } from "@/components/ui/button"
import { isMac } from "@/lib/platform"

import { SettingsCard, SettingsNote } from "./shared"

type PermissionRow = {
  id: string
  group: "core" | "files" | "media" | "devices" | "automation"
  labelKey: string
  descKey: string
  /** Only the six macos-privacy permissions have a native status/request path. */
  supported?: boolean
  /** Optional permissions are still listed, but not required for computer control. */
  optional?: boolean
  /** System Settings deep link for panes macOS does not expose through a query API. */
  settingsUrl?: string
}

const ROWS: PermissionRow[] = [
  {
    id: "accessibility",
    group: "core",
    labelKey: "computer.permissionCenterAccessibility",
    descKey: "computer.permissionCenterAccessibilityDesc",
    supported: true
  },
  {
    id: "screenRecording",
    group: "core",
    labelKey: "computer.permissionCenterScreenRecording",
    descKey: "computer.permissionCenterScreenRecordingDesc",
    supported: true
  },
  {
    id: "inputMonitoring",
    group: "core",
    labelKey: "computer.permissionCenterInputMonitoring",
    descKey: "computer.permissionCenterInputMonitoringDesc",
    supported: true,
    optional: true
  },
  {
    id: "filesAndFolders",
    group: "files",
    labelKey: "computer.permissionCenterFiles",
    descKey: "computer.permissionCenterFilesDesc",
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
  },
  {
    id: "fullDiskAccess",
    group: "files",
    labelKey: "computer.permissionCenterFullDisk",
    descKey: "computer.permissionCenterFullDiskDesc",
    supported: true,
    optional: true
  },
  {
    id: "appManagement",
    group: "files",
    labelKey: "computer.permissionCenterAppManagement",
    descKey: "computer.permissionCenterAppManagementDesc",
    optional: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles"
  },
  {
    id: "mediaLibrary",
    group: "media",
    labelKey: "computer.permissionCenterMediaLibrary",
    descKey: "computer.permissionCenterMediaLibraryDesc",
    optional: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Media"
  },
  {
    id: "photos",
    group: "media",
    labelKey: "computer.permissionCenterPhotos",
    descKey: "computer.permissionCenterPhotosDesc",
    optional: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos"
  },
  {
    id: "contacts",
    group: "media",
    labelKey: "computer.permissionCenterContacts",
    descKey: "computer.permissionCenterContactsDesc",
    optional: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts"
  },
  {
    id: "calendars",
    group: "media",
    labelKey: "computer.permissionCenterCalendars",
    descKey: "computer.permissionCenterCalendarsDesc",
    optional: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"
  },
  {
    id: "reminders",
    group: "media",
    labelKey: "computer.permissionCenterReminders",
    descKey: "computer.permissionCenterRemindersDesc",
    optional: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders"
  },
  {
    id: "camera",
    group: "devices",
    labelKey: "computer.permissionCenterCamera",
    descKey: "computer.permissionCenterCameraDesc",
    supported: true,
    optional: true
  },
  {
    id: "microphone",
    group: "devices",
    labelKey: "computer.permissionCenterMicrophone",
    descKey: "computer.permissionCenterMicrophoneDesc",
    supported: true,
    optional: true
  },
  {
    id: "location",
    group: "devices",
    labelKey: "computer.permissionCenterLocation",
    descKey: "computer.permissionCenterLocationDesc",
    optional: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices"
  },
  {
    id: "bluetooth",
    group: "devices",
    labelKey: "computer.permissionCenterBluetooth",
    descKey: "computer.permissionCenterBluetoothDesc",
    optional: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth"
  },
  {
    id: "localNetwork",
    group: "devices",
    labelKey: "computer.permissionCenterLocalNetwork",
    descKey: "computer.permissionCenterLocalNetworkDesc",
    optional: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork"
  },
  {
    id: "automation",
    group: "automation",
    labelKey: "computer.permissionCenterAutomation",
    descKey: "computer.permissionCenterAutomationDesc",
    optional: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
  },
  {
    id: "notifications",
    group: "automation",
    labelKey: "computer.permissionCenterNotifications",
    descKey: "computer.permissionCenterNotificationsDesc",
    optional: true,
    settingsUrl: "x-apple.systempreferences:com.apple.preference.notifications"
  }
]

const STATE_CLASS: Record<string, string> = {
  authorized: "border-emerald-500/30 text-emerald-600",
  notDetermined: "border-amber-500/30 text-amber-600",
  denied: "border-rose-500/30 text-rose-600",
  restricted: "border-rose-500/30 text-rose-600",
  notAuthorized: "border-rose-500/30 text-rose-600",
  settingsOnly: "border-sky-500/30 text-sky-600",
  unavailable: "border-border text-muted-foreground"
}

export function OperationPermissionCenter() {
  const { t } = useTranslation()
  const [statuses, setStatuses] = useState<OperationPermissionStatus[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback((): void => {
    if (!isTauri() || !isMac()) return
    void commands
      .permissionsCenterStatus()
      .then(setStatuses)
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
  }, [])

  useEffect(() => {
    load()
    const onFocus = (): void => load()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [load])

  const statusMap = useMemo(() => new Map(statuses.map((status) => [status.id, status])), [statuses])
  const detected = statuses.length
  const granted = statuses.filter((status) => status.granted).length
  const settingsOnly = ROWS.filter((row) => row.supported !== true).length

  const stateOf = (row: PermissionRow): string => {
    if (row.supported !== true) return "settingsOnly"
    return statusMap.get(row.id)?.state ?? "unavailable"
  }
  const stateLabel = (state: string): string => t(`computer.permissionCenterState.${state}`)

  const request = (row: PermissionRow): void => {
    if (!isTauri() || !isMac()) return
    if (row.supported !== true) {
      if (row.settingsUrl !== undefined) {
        void commands
          .permissionsCenterOpenUrl({ url: row.settingsUrl })
          .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      }
      return
    }
    const state = stateOf(row)
    setBusy(row.id)
    const action =
      state === "authorized" || state === "denied" || state === "restricted" || state === "notAuthorized"
        ? commands.permissionsCenterOpenSettings({ permission: row.id })
        : commands.permissionsCenterRequest({ permission: row.id })
    void action
      .then(() => window.setTimeout(load, 900))
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(null))
  }

  return (
    <SettingsCard
      title={t("computer.permissionCenterTitle")}
      desc={t("computer.permissionCenterDesc")}
      action={
        <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" onClick={load}>
          <RefreshCwIcon className="size-3.5" />
          {t("computer.permissionCenterRecheck")}
        </Button>
      }
    >
      <div className="px-4 pt-3 pb-2">
        <SettingsNote>{t("computer.permissionCenterNotice")}</SettingsNote>
        <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <span className="rounded-full border border-emerald-500/25 bg-emerald-500/8 px-2 py-1 text-emerald-600">
            {t("computer.permissionCenterSummary", { granted, detected })}
          </span>
          <span className="rounded-full border border-sky-500/25 bg-sky-500/8 px-2 py-1 text-sky-600">
            {t("computer.permissionCenterSettingsOnly", { count: settingsOnly })}
          </span>
        </div>
      </div>
      {(["core", "files", "media", "devices", "automation"] as const).map((group) => (
        <div key={group} className="border-t border-border/60 px-4 py-3">
          <h3 className="mb-2 text-xs font-medium text-foreground/80">
            {t(`computer.permissionCenterGroup.${group}`)}
          </h3>
          <div className="divide-y divide-border/50 rounded-lg border border-border/60">
            {ROWS.filter((row) => row.group === group).map((row) => {
              const state = stateOf(row)
              return (
                <div key={row.id} data-permission={row.id} className="flex flex-wrap items-start gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-foreground">{t(row.labelKey)}</span>
                      {row.optional === true && (
                        <span className="rounded-full bg-foreground/6 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                          {t("computer.permissionCenterOptional")}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[10.5px] leading-4 text-muted-foreground">{t(row.descKey)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] ${STATE_CLASS[state] ?? STATE_CLASS.unavailable}`}
                    >
                      {stateLabel(state)}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      disabled={busy === row.id}
                      onClick={() => request(row)}
                    >
                      {row.supported === true && state === "authorized"
                        ? t("computer.permissionCenterRecheck")
                        : t("computer.permissionCenterOpen")}
                    </Button>
                    {row.settingsUrl !== undefined && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[10px] text-muted-foreground"
                        onClick={() =>
                          void commands
                            .permissionsCenterOpenUrl({ url: row.settingsUrl ?? "" })
                            .catch((error: unknown) =>
                              toast.error(error instanceof Error ? error.message : String(error))
                            )
                        }
                        aria-label={t("computer.openSettings")}
                      >
                        <ExternalLinkIcon className="size-3" />
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      {!isMac() && <SettingsNote>{t("computer.permissionCenterMacOnly")}</SettingsNote>}
    </SettingsCard>
  )
}
