import type { ArchiveStatus, Preferences } from "@alwith/module-drive"
import { driveTranslator, useDrive } from "@alwith/module-drive/react"
import { emitTo } from "@tauri-apps/api/event"
import { confirm } from "@tauri-apps/plugin-dialog"
import { type ReactNode, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"

import { drive } from "./controller"

// Cheap structural comparison so the 5s refresh doesn't re-render when nothing changed.
function contentEqual<T>(previous: T | null, next: T): boolean {
  return previous !== null && JSON.stringify(previous) === JSON.stringify(next)
}

export function DriveIntegrations(): ReactNode {
  const { i18n } = useTranslation()
  const zh = i18n.language.startsWith("zh")
  const t = driveTranslator(zh ? "zh-CN" : "en", "settings")
  const { connected, snapshot } = useDrive(drive)
  const [preferences, setPreferences] = useState<Preferences | null>(null)
  const [archive, setArchive] = useState<ArchiveStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!connected || !snapshot?.configured) {
      setPreferences(null)
      setArchive(null)
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    setError(null)
    const load = async (): Promise<void> => {
      const [settings, status] = await Promise.all([
        drive.request({ type: "preferences" }),
        drive.request({ type: "archiveStatus" })
      ])
      if (settings.type !== "preferences" || status.type !== "archiveStatus")
        throw new Error("Invalid Drive integration settings")
      if (active) {
        setPreferences((current) => (contentEqual(current, settings.data) ? current : settings.data))
        setArchive((current) => (contentEqual(current, status.data) ? current : status.data))
      }
    }
    // One pair of requests in flight at a time. The old 5s interval fired whether the previous
    // pair had come back or not: while Drive is busy with a full sync each pair times out after
    // 45s, so requests piled up, kept the daemon saturated and left the UI stuck on "syncing".
    // Back off on consecutive failures and return to 5s as soon as Drive answers again.
    const schedule = (delay: number): void => {
      if (!active) return
      timer = setTimeout(() => {
        void load()
          .then(() => {
            failures = 0
          })
          .catch((cause: unknown) => {
            failures += 1
            if (active) setError(String(cause))
          })
          .finally(() => schedule(failures === 0 ? 5000 : Math.min(5000 * 2 ** failures, 60_000)))
      }, delay)
    }
    schedule(0)
    return () => {
      active = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [connected, snapshot?.configured, snapshot?.generation])
  const change = (key: keyof Preferences, value: boolean): void => {
    if (!preferences || busy) return
    setBusy(true)
    setError(null)
    void (async () => {
      if (
        key === "sessionArchive" &&
        value &&
        !(await confirm(
          zh
            ? "开启后，每五分钟将 Codex 会话中的用户消息和助手文字回复上传到配置的云盘服务器。思考和工具记录不上传；可在会话菜单中排除私密会话。确认开启？"
            : "Upload Codex prompts and assistant text replies to the configured Drive server every five minutes? Reasoning and tool records are excluded. Private conversations can be excluded in the chat menu.",
          { title: t("archive.title"), kind: "warning" }
        ))
      )
        return
      const response = await drive.request({ type: "setPreferences", ...preferences, [key]: value })
      if (response.type !== "preferences") throw new Error("Invalid Drive preferences")
      setPreferences(response.data)
      if (key === "sessionArchive" && value) await emitTo("main", "drive:archive-sync")
    })()
      .catch((cause: unknown) => setError(String(cause)))
      .finally(() => setBusy(false))
  }
  return (
    <section>
      <h3>{t("ai.title")}</h3>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="alwith-drive-setting">
        <div>
          <strong>{t("archive.title")}</strong>
          <p>
            {zh
              ? "经同意后每五分钟归档 Codex 的用户消息和助手文字回复。不保留本地会话副本；可在会话菜单中排除私密会话。"
              : "Opt in to archive Codex prompts and assistant text replies every five minutes. No second local history is stored. Exclude private conversations in the chat menu."}
          </p>
          {archive && (
            <p>
              {t("archive.synced", { count: archive.synced })} ·{" "}
              {t("archive.lastUpload", {
                time: archive.lastUploadAt
                  ? new Date(archive.lastUploadAt).toLocaleString(i18n.language)
                  : t("archive.never")
              })}
            </p>
          )}
          {archive?.lastError && <p role="alert">{archive.lastError}</p>}
        </div>
        <Switch
          aria-label={t("archive.title")}
          checked={preferences?.sessionArchive ?? false}
          disabled={!connected || busy || !preferences}
          onCheckedChange={(value) => change("sessionArchive", value)}
        />
      </div>
      {preferences?.sessionArchive && (
        <Button
          variant="outline"
          onClick={() => {
            void emitTo("main", "drive:archive-sync").catch((cause: unknown) => setError(String(cause)))
          }}
        >
          {t("archive.syncNow")}
        </Button>
      )}
      <div className="alwith-drive-setting">
        <div>
          <strong>{t("knowledge.title")}</strong>
          <p>{t("knowledge.desc")}</p>
        </div>
        <Switch
          aria-label={t("knowledge.title")}
          checked={preferences?.knowledgeInject ?? false}
          disabled={!connected || busy || !preferences}
          onCheckedChange={(value) => change("knowledgeInject", value)}
        />
      </div>
    </section>
  )
}
