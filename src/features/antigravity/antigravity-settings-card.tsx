import { listen } from "@tauri-apps/api/event"
import { isTauri } from "@tauri-apps/api/core"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { commands } from "@/bindings"
import { GoogleMark } from "@/components/icons/google-mark"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { describeError } from "@/lib/error-text"

import { SettingRow, SettingsCard, SettingsNote } from "../settings/sections/shared"
import {
  ANTIGRAVITY_DEFAULT_MODEL_KEY,
  ANTIGRAVITY_DEFAULT_THINKING_KEY,
  ANTIGRAVITY_ENABLED_KEY,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_TIER_KEY,
  antigravityDefaultModel,
  antigravityDefaultThinking
} from "./models"

const EVENT = "antigravity:event"

type Tier = { name?: string; id?: string } | null

async function send(message: unknown): Promise<void> {
  await commands.antigravitySend({ message: JSON.stringify(message) })
}

function savedTier(): Tier {
  try {
    const raw = localStorage.getItem(ANTIGRAVITY_TIER_KEY)
    if (raw === null) return null
    const value = JSON.parse(raw) as Tier
    return typeof value?.name === "string" ? value : null
  } catch {
    return null
  }
}

/**
 * The Gemini / Antigravity block inside 设置 → 大模型.
 *
 * Login is owned by the official ACP binary: it opens Google's OAuth page and stores the refresh
 * token in the macOS login keychain. U⁺ only asks whether that item exists, and never reads it.
 * That is what keeps the account signed in across app launches, like the ChatGPT card.
 */
export function AntigravitySettingsCard(): ReactNode {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(() => localStorage.getItem(ANTIGRAVITY_ENABLED_KEY) !== "false")
  const [model, setModel] = useState(antigravityDefaultModel)
  const [thinking, setThinking] = useState(antigravityDefaultThinking)
  const [tier, setTier] = useState<Tier>(savedTier)
  const [signedIn, setSignedIn] = useState(false)
  const [checking, setChecking] = useState(true)
  const [waiting, setWaiting] = useState(false)
  const listener = useRef<Promise<() => void> | null>(null)

  useEffect(() => {
    if (!isTauri()) {
      setChecking(false)
      return
    }
    let disposed = false
    listener.current = listen<string>(EVENT, (event) => {
      if (disposed) return
      let message: { type?: string; tier?: Tier; message?: string }
      try {
        message = JSON.parse(event.payload) as typeof message
      } catch {
        return
      }
      if (message.type === "logged_in") {
        const nextTier = message.tier ?? null
        setTier(nextTier)
        setSignedIn(true)
        setWaiting(false)
        try {
          localStorage.setItem(ANTIGRAVITY_TIER_KEY, JSON.stringify(nextTier))
        } catch {
          // The UI state is enough when storage is unavailable.
        }
      } else if (message.type === "logged_out") {
        setTier(null)
        setSignedIn(false)
        setWaiting(false)
      } else if (message.type === "error" && message.message !== undefined) {
        setWaiting(false)
        toast.error(message.message)
      } else if (message.type === "exit") {
        setWaiting(false)
      }
    }).catch(() => () => {})
    void commands
      .antigravityStatus()
      .then((status) => {
        if (disposed) return
        setSignedIn(status.signedIn)
        setChecking(false)
      })
      .catch(() => {
        if (!disposed) setChecking(false)
      })
    return () => {
      disposed = true
      void listener.current?.then((stop) => stop())
      listener.current = null
    }
  }, [])

  const login = useCallback(async () => {
    setWaiting(true)
    try {
      await listener.current
      await commands.antigravityStart()
      await send({ type: "initialize" })
      await send({ type: "login", methodId: "oauth-personal" })
    } catch (error) {
      setWaiting(false)
      toast.error(describeError(error))
    }
  }, [])

  const logout = useCallback(async () => {
    setWaiting(true)
    try {
      await send({ type: "logout" })
    } catch (error) {
      toast.error(describeError(error))
    } finally {
      setWaiting(false)
      setSignedIn(false)
      setTier(null)
      try {
        localStorage.removeItem(ANTIGRAVITY_TIER_KEY)
      } catch {
        // Nothing else to clear.
      }
    }
  }, [])

  const accountName = tier?.name ?? (signedIn ? t("antigravity.settingsSignedIn") : t("antigravity.settingsSignedOut"))
  const accountDesc = checking
    ? t("antigravity.settingsChecking")
    : signedIn
      ? accountName
      : t("antigravity.settingsAccountHint")

  return (
    <SettingsCard
      title={t("antigravity.settingsTitle")}
      desc={t("antigravity.settingsDesc")}
      action={
        <span className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-[11px]">
          {t("antigravity.experimental")}
        </span>
      }
    >
      <SettingRow compact title={t("antigravity.settingsEnable")} desc={t("antigravity.settingsEnableDesc")}>
        <Button
          type="button"
          variant={enabled ? "default" : "outline"}
          size="sm"
          onClick={() => {
            const next = !enabled
            setEnabled(next)
            localStorage.setItem(ANTIGRAVITY_ENABLED_KEY, String(next))
          }}
        >
          {enabled ? t("antigravity.settingsOn") : t("antigravity.settingsOff")}
        </Button>
      </SettingRow>
      <SettingRow
        compact
        title={t("antigravity.settingsAccount")}
        desc={
          <span className="flex items-center gap-2">
            <GoogleMark className="size-4 text-[9px]" />
            <span className={signedIn ? "text-emerald-600 dark:text-emerald-400" : undefined}>{accountDesc}</span>
          </span>
        }
      >
        {checking ? (
          <Spinner />
        ) : signedIn ? (
          <Button type="button" variant="outline" size="sm" disabled={waiting} onClick={() => void logout()}>
            {waiting && <Spinner data-icon="inline-start" />}
            {t("antigravity.logout")}
          </Button>
        ) : (
          <Button type="button" size="sm" disabled={waiting} onClick={() => void login()}>
            {waiting && <Spinner data-icon="inline-start" />}
            {waiting ? t("antigravity.waitingLogin") : t("antigravity.connect")}
          </Button>
        )}
      </SettingRow>
      <SettingRow compact title={t("antigravity.settingsModel")} desc={t("antigravity.settingsModelDesc")}>
        <select
          value={model}
          onChange={(event) => {
            setModel(event.target.value)
            localStorage.setItem(ANTIGRAVITY_DEFAULT_MODEL_KEY, event.target.value)
          }}
          className="border-border bg-muted/40 text-foreground rounded-md border px-2 py-1 text-xs outline-none"
        >
          {ANTIGRAVITY_MODELS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow compact title={t("antigravity.settingsThinking")} desc={t("antigravity.settingsThinkingDesc")}>
        <select
          value={thinking}
          onChange={(event) => {
            setThinking(event.target.value)
            localStorage.setItem(ANTIGRAVITY_DEFAULT_THINKING_KEY, event.target.value)
          }}
          className="border-border bg-muted/40 text-foreground rounded-md border px-2 py-1 text-xs outline-none"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </SettingRow>
      <SettingsNote>{t("antigravity.settingsNote")}</SettingsNote>
    </SettingsCard>
  )
}
