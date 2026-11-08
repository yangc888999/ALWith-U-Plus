import { ChevronDown } from "lucide-react"
import { type ReactNode, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import { Switch } from "@/components/ui/switch"
import {
  sandboxSnapshot,
  setSandboxSettings,
  subscribeSandbox,
  type SandboxSettings
} from "@/lib/sandbox-preference"

import { SettingRow } from "./shared"

/** One capability in the sandbox's report: its own switch, or a fixed/derived line when the
 * sandbox preset cannot separate it from another switch. */
type CapabilityRow = {
  key: string
  label: string
  hint: string
  setting?: keyof SandboxSettings
  fixed?: "always" | "follow"
}

/**
 * Sandbox master switch, with the per-capability list underneath.
 *
 * The list is the sandbox report the user works from: every line says what the conversation may do
 * while the sandbox is on, and the switches that the Codex presets can express are editable. Lines
 * the preset cannot split (deleting follows the file-write permission, reading is always allowed)
 * say so instead of pretending to be a separate switch.
 */
export function SandboxRow(): ReactNode {
  const { t } = useTranslation()
  const settings = useSyncExternalStore(subscribeSandbox, sandboxSnapshot, sandboxSnapshot)
  const [open, setOpen] = useState(false)
  const rows: CapabilityRow[] = [
    { key: "read", label: t("settings.sandboxRead"), hint: t("settings.sandboxReadHint"), fixed: "always" },
    { key: "write", label: t("settings.sandboxWrite"), hint: t("settings.sandboxWriteHint"), setting: "projectWrite" },
    {
      key: "outside",
      label: t("settings.sandboxOutside"),
      hint: t("settings.sandboxOutsideHint"),
      setting: "outsideWrite"
    },
    { key: "move", label: t("settings.sandboxMove"), hint: t("settings.sandboxMoveHint"), fixed: "follow" },
    { key: "command", label: t("settings.sandboxCommand"), hint: t("settings.sandboxCommandHint"), setting: "commands" },
    { key: "network", label: t("settings.sandboxNetwork"), hint: t("settings.sandboxNetworkHint"), setting: "network" },
    { key: "install", label: t("settings.sandboxInstall"), hint: t("settings.sandboxInstallHint"), setting: "install" },
    { key: "apps", label: t("settings.sandboxApps"), hint: t("settings.sandboxAppsHint"), setting: "apps" },
    { key: "web", label: t("settings.sandboxWeb"), hint: t("settings.sandboxWebHint"), setting: "web" }
  ]
  return (
    <>
      <SettingRow title={t("settings.sandbox")} desc={t("settings.sandboxDesc")}>
        <div className="flex items-center justify-end gap-2">
          {settings.enabled && (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? t("settings.sandboxCapabilitiesHide") : t("settings.sandboxCapabilities")}
              <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
          )}
          <Switch
            aria-label={t("settings.sandbox")}
            checked={settings.enabled}
            onCheckedChange={(enabled) => {
              setSandboxSettings({ enabled })
              if (enabled) setOpen(true)
            }}
          />
        </div>
      </SettingRow>
      {settings.enabled && open && (
        <div className="ms-4 border-s border-border/60 ps-3">
          {rows.map((row) => {
            const value = row.setting === undefined ? false : settings[row.setting]
            const editable = row.setting !== undefined
            return (
              <div key={row.key} className="flex items-start justify-between gap-3 border-b border-border/40 py-2 last:border-0">
                <div className="min-w-0">
                  <p className="text-sm">{row.label}</p>
                  <p className="text-xs text-muted-foreground">{row.hint}</p>
                </div>
                {editable ? (
                  <Switch
                    aria-label={row.label}
                    checked={value}
                    onCheckedChange={(checked) => setSandboxSettings({ [row.setting as keyof SandboxSettings]: checked })}
                  />
                ) : (
                  <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
                    {row.fixed === "always" ? t("settings.sandboxAlways") : t("settings.sandboxFollow")}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
