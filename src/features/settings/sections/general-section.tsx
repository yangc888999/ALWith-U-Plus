import { BrainIcon, LanguagesIcon, PlayCircleIcon, SparklesIcon, SquareArrowOutUpRightIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useStore } from "zustand"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/alwith-ui/select"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { predictionPreference, setPredictionsEnabled } from "@/features/chat/composer/prediction-preference"
import { ProjectAppIcon, useExternalApps } from "@/features/chat/open-in-editor"
import { requestChatSurface } from "@/lib/chat-window"
import i18n, { isLanguageCode, LANGUAGES } from "@/lib/i18n"
import { loadPreferences, savePreference } from "@/lib/preferences"

import { AutostartRow } from "./autostart-row"
import { useDriveVisible } from "@/features/drive/use-drive-visible"
import { setDriveEnabled, useDriveEnabled } from "@/lib/drive-visible-preference"
import { MemoryInjectionRow } from "./memory-injection-row"
import { PreventSleepRow } from "./prevent-sleep-row"
import { SandboxRow } from "./sandbox-row"
import { SettingRow, SettingsCard } from "./shared"

/** Master YUP Drive switch. Lives in the "记忆与云盘" card because turning the drive off also
 *  drops its sidebar and settings entry — the reader needs a permanent place to turn it back on.
 *  Closing asks for confirmation because it halts every sync and releases the drive client. */
function YupDriveRow() {
  const { t } = useTranslation()
  const enabled = useDriveEnabled()
  const [confirmClose, setConfirmClose] = useState(false)
  const [busy, setBusy] = useState(false)

  const onTurnOn = () => {
    setBusy(true)
    void setDriveEnabled(true)
      .catch((error: unknown) => toast.error(String(error)))
      .finally(() => setBusy(false))
  }

  const onConfirmClose = async () => {
    setBusy(true)
    try {
      await setDriveEnabled(false)
      setConfirmClose(false)
    } catch (error: unknown) {
      toast.error(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SettingRow title={t("settings.yupDrive")} desc={t("settings.yupDriveDesc")}>
        <div className="flex justify-end">
          <Switch
            aria-label={t("settings.yupDrive")}
            checked={enabled}
            disabled={busy}
            onCheckedChange={(checked) => {
              if (checked) onTurnOn()
              else setConfirmClose(true)
            }}
          />
        </div>
      </SettingRow>
      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.yupDriveCloseTitle")}</DialogTitle>
            <DialogDescription>{t("settings.yupDriveCloseDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmClose(false)}>
              {t("actions.cancel")}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={onConfirmClose}>
              {t("actions.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function GeneralSection() {
  const { t } = useTranslation()
  const driveVisible = useDriveVisible()
  const predictions = useStore(predictionPreference, (state) => state.enabled)
  const [savingPredictions, setSavingPredictions] = useState(false)
  const apps = useExternalApps()
  const [externalEditor, setExternalEditor] = useState<string | null>(null)
  const [shortcut, setShortcut] = useState("")
  const [savingShortcut, setSavingShortcut] = useState(false)
  const [startSurface, setStartSurface] = useState<"chat" | "work">("chat")
  useEffect(() => {
    void loadPreferences().then((preferences) => {
      setExternalEditor(preferences.externalEditor)
      setShortcut(preferences.chatWindowShortcut ?? "Alt+Space")
      setStartSurface(preferences.defaultStartSurface)
    })
  }, [])
  const activeEditor = apps.find((app) => app.bundle_id === externalEditor) ?? apps[0]
  return (
    <>
      <SettingsCard title={t("settings.cardLanguage")} icon={<LanguagesIcon className="size-3.5" />}>
        <SettingRow title={t("settings.language")} desc={t("settings.languageDesc")} aligned>
          <Select
            items={LANGUAGES.map((language) => ({ value: language.code, label: language.label }))}
            value={i18n.language}
            onValueChange={(value) => {
              if (!value || !isLanguageCode(value)) return
              void i18n.changeLanguage(value)
              void savePreference("language", value)
            }}
          >
            <SelectTrigger id="language" className="w-full" aria-label={t("settings.language")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LANGUAGES.map((language) => (
                  <SelectItem key={language.code} value={language.code}>
                    {language.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title={t("settings.composerPredictions")} desc={t("settings.composerPredictionsDesc")}>
          <div className="flex justify-end">
            <Switch
              aria-label={t("settings.composerPredictions")}
              checked={predictions}
              disabled={savingPredictions}
              onCheckedChange={(enabled) => {
                setSavingPredictions(true)
                void setPredictionsEnabled(enabled)
                  .catch((error: unknown) => toast.error(String(error)))
                  .finally(() => setSavingPredictions(false))
              }}
            />
          </div>
        </SettingRow>
        <SettingRow title={t("settings.defaultStartSurface")} desc={t("settings.defaultStartSurfaceDesc")}>
          <Select
            items={[
              { value: "chat", label: t("settings.startSurfaceChat") },
              { value: "work", label: t("settings.startSurfaceWork") }
            ]}
            value={startSurface}
            onValueChange={(value) => {
              if (value !== "chat" && value !== "work") return
              setStartSurface(value)
              void savePreference("defaultStartSurface", value)
            }}
          >
            <SelectTrigger className="w-[12rem]" aria-label={t("settings.defaultStartSurface")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="min-w-[12rem] p-1.5">
              <SelectGroup className="p-0">
                <SelectItem className="py-2.5 ps-3 pe-9" value="chat">
                  {t("settings.startSurfaceChat")}
                </SelectItem>
                <SelectItem className="py-2.5 ps-3 pe-9" value="work">
                  {t("settings.startSurfaceWork")}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        title={t("settings.cardShortcut")}
        desc={t("settings.cardShortcutDesc")}
        icon={<SquareArrowOutUpRightIcon className="size-3.5" />}
      >
        <SettingRow title={t("chatWindow.shortcut")} desc={t("settings.cardShortcutHint")} aligned>
          <div className="flex w-full items-center gap-2">
            <Input
              className="min-w-0 flex-1"
              aria-label={t("chatWindow.shortcut")}
              value={shortcut}
              placeholder={t("chatWindow.shortcutOff")}
              onChange={(event) => setShortcut(event.target.value)}
              disabled={savingShortcut}
            />
            <Button
              variant="outline"
              size="default"
              disabled={savingShortcut}
              onClick={() => {
                setSavingShortcut(true)
                void requestChatSurface("main", { type: "shortcut", shortcut: shortcut.trim() })
                  .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
                  .finally(() => setSavingShortcut(false))
              }}
            >
              {t("chatWindow.shortcutSave")}
            </Button>
          </div>
        </SettingRow>
      </SettingsCard>

      {apps.length > 0 && (
        <SettingsCard
          title={t("settings.cardOpenWith")}
          desc={t("settings.cardOpenWithDesc")}
          icon={<SparklesIcon className="size-3.5" />}
        >
          <SettingRow title={t("settings.externalEditor")} desc={t("settings.externalEditorDesc")} aligned>
            <Select
              value={activeEditor?.bundle_id ?? ""}
              onValueChange={(value) => {
                if (!value) return
                setExternalEditor(value)
                void savePreference("externalEditor", value)
              }}
            >
              <SelectTrigger id="external-editor" className="w-full" aria-label={t("settings.externalEditor")}>
                <SelectValue>
                  <ProjectAppIcon app={activeEditor} />
                  {activeEditor?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {apps.map((app) => (
                    <SelectItem key={app.bundle_id} value={app.bundle_id}>
                      <span className="flex items-center gap-2">
                        <ProjectAppIcon app={app} />
                        {app.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingRow>
        </SettingsCard>
      )}

      <SettingsCard
        title={t("settings.cardStartup")}
        desc={t("settings.cardStartupDesc")}
        icon={<PlayCircleIcon className="size-3.5" />}
      >
        <AutostartRow />
        <PreventSleepRow />
        <SandboxRow />
      </SettingsCard>

      <SettingsCard
        title={t("settings.cardMemory")}
        desc={t("settings.cardMemoryDesc")}
        icon={<BrainIcon className="size-3.5" />}
      >
        <MemoryInjectionRow />
        {driveVisible && <YupDriveRow />}
      </SettingsCard>
    </>
  )
}
