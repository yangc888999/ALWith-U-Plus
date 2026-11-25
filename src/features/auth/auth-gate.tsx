import { isValidPassword } from "@alwith/module-auth"
import { isTauri } from "@tauri-apps/api/core"
import { emit, listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { type ReactNode, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { authClient, loginPlatform, usePlatformAuth } from "./store"

type Mode = "code" | "password" | "register" | "passphrase"

/** "Use it without an account" is remembered across launches: the reader who picked it should not
 *  be asked again on every start, and the account service is unreachable outside the company
 *  network — which is exactly when they need the local features to keep working. */
const SKIP_KEY = "alwith:platform-login-skipped"

/** The local passphrase fallback. Deliberately a single fixed word: it is an escape hatch for the
 *  days the account service cannot be reached, not a second credential system. */
export const LOCAL_PASSPHRASE = "YUP"
const PASSPHRASE_KEY = "alwith:platform-passphrase-unlocked"
const PASSPHRASE_EVENT = "alwith:platform-passphrase-unlocked"

/** Exported for the test that pins the escape hatch; not part of the public surface. */
export function readSkipped(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === "1"
  } catch {
    return false
  }
}

/** Exported for the test that pins the escape hatch; not part of the public surface. */
export function rememberSkipped(): void {
  try {
    localStorage.setItem(SKIP_KEY, "1")
  } catch {
    // A locked-down webview may refuse storage. The session still works; it just asks again.
  }
}

/** Whether the local passphrase has been used on this machine. */
export function readPassphraseUnlocked(): boolean {
  try {
    return localStorage.getItem(PASSPHRASE_KEY) === "1"
  } catch {
    return false
  }
}

function rememberPassphraseUnlocked(): void {
  try {
    localStorage.setItem(PASSPHRASE_KEY, "1")
  } catch {
    // Same as above: the current session still works without persistence.
  }
  // Settings can be the only window with the passphrase form on screen. The main window keeps its
  // own `unlocked` state, so persist and announce in one place instead of leaving it gated.
  if (isTauri()) void emit(PASSPHRASE_EVENT).catch(() => undefined)
}

export function AuthGate({ children, auxiliary = false }: { children: ReactNode; auxiliary?: boolean }) {
  const authenticated = usePlatformAuth((s) => s.isAuthenticated)
  const loading = usePlatformAuth((s) => s.isLoading)
  const [unlocked, setUnlocked] = useState(readPassphraseUnlocked)
  // A saved account can take a network round trip to restore. The local door must not wait for
  // that service: after a short grace it is offered instead of an indefinite spinner.
  const [localEntryReady, setLocalEntryReady] = useState(false)
  useEffect(() => {
    if (!loading || localEntryReady) return
    const timer = window.setTimeout(() => setLocalEntryReady(true), 500)
    return () => window.clearTimeout(timer)
  }, [loading, localEntryReady])
  // A local unlock in the settings window has to reach the main window immediately. localStorage
  // covers the next launch; this subscription covers the window that is already open.
  useEffect(() => {
    if (unlocked) return
    const sync = (): void => {
      if (readPassphraseUnlocked()) setUnlocked(true)
    }
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === PASSPHRASE_KEY) sync()
    }
    window.addEventListener("storage", onStorage)
    const stop = isTauri()
      ? listen(PASSPHRASE_EVENT, sync).catch(() => () => {})
      : Promise.resolve(() => {})
    return () => {
      window.removeEventListener("storage", onStorage)
      void stop.then((off) => off()).catch(() => undefined)
    }
  }, [unlocked])
  // The passphrase is a local fallback, not a login: `isAuthenticated` stays false, so Drive and
  // the account-managed ALwith provider stay hidden exactly as they should, while the Codex engine
  // and every other vendor's models keep working.
  //
  // Both doorways are checked *before* the restore spinner. The account service only answers inside
  // the company network and its `init()` can sit in `isLoading` for a whole profile round trip, so a
  // reader who already walked through the local door must never be sent back to a spinner — the
  // escape hatch would be held hostage by exactly the service it exists to bypass (2026-11-16).
  if (authenticated || unlocked) return children
  if (loading && !localEntryReady)
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner />
      </div>
    )
  // Auxiliary windows render nothing until signed in — correct for the chat bubble, which has
  // nothing to say without an account. Settings is different: it is a page the reader asked for,
  // and 设置 → 账号 renders the sign-in form itself. Gating the window put the form in front of
  // every section, so the reader could not reach any of them (2026-11-08).
  if (getCurrentWindow().label === "settings") return children
  return auxiliary ? null : (
    <PlatformLogin initialMode={loading ? "passphrase" : "code"} onPassphrase={() => setUnlocked(true)} />
  )
}

export function PlatformLogin({
  onPassphrase,
  embedded = false,
  initialMode = "code"
}: {
  onPassphrase?: () => void
  embedded?: boolean
  /** Slow account restores open on the local door; a normal signed-out launch opens on code login. */
  initialMode?: Mode
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>(initialMode)
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [password, setPassword] = useState("")
  const [passphrase, setPassphrase] = useState(LOCAL_PASSPHRASE)
  const [pendingAction, setPendingAction] = useState<"sendCode" | "submit" | null>(null)
  const busy = pendingAction !== null
  const [error, setError] = useState("")
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({})
  const cooldownKey = `${mode}:${email.trim().toLowerCase()}`
  // Absolute deadline of the resend cooldown for the address currently typed in. 0 = no cooldown.
  const cooldownUntil = cooldowns[cooldownKey] ?? 0
  // Only a running cooldown needs a clock. The old form ticked a `Date.now()` interval for the whole
  // lifetime of the component, so every mode — including the passphrase door, which has no
  // countdown at all — re-rendered its tabs, every field and both buttons once a second while the
  // reader was typing. Nothing on this form can change between ticks when `seconds` is 0, so the
  // clock now exists only while something is counting down.
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const remaining = (): number => Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000))
    setSeconds(remaining())
    if (cooldownUntil <= Date.now()) return
    // Ticking faster than the displayed second keeps the boundary honest, while `setSeconds` with
    // an unchanged number is a no-op for React: four ticks per second cost one render.
    const timer = setInterval(() => {
      const next = remaining()
      setSeconds(next)
      if (next === 0) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [cooldownUntil])
  async function run(action: "sendCode" | "submit") {
    if (busy) return
    setPendingAction(action)
    setError("")
    try {
      await (action === "sendCode" ? sendCode() : submit())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(
        message === "WAITLISTED"
          ? t("platformAuth.waitlisted")
          : message === "DISABLED"
            ? t("platformAuth.disabled")
            : message || t("platformAuth.failed")
      )
    } finally {
      setPendingAction(null)
    }
  }
  async function sendCode() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error(t("platformAuth.invalidEmail"))
    if (mode === "register" && (await authClient.emailExists(email.trim())).registered)
      throw new Error(t("platformAuth.registered"))
    await authClient.sendVerificationCode(email.trim(), mode === "register" ? "REGISTER" : "LOGIN")
    // The deadline itself drives the countdown; the effect above restarts the clock from it.
    setCooldowns((current) => ({ ...current, [cooldownKey]: Date.now() + 60_000 }))
  }
  async function submit() {
    // The local passphrase never touches the network: it is the way in when the account service
    // cannot be reached at all.
    if (mode === "passphrase") {
      // Empty also means the documented default, so pressing Enter on a cleared field still enters.
      if ((passphrase.trim() || LOCAL_PASSPHRASE) !== LOCAL_PASSPHRASE)
        throw new Error(t("platformAuth.passphraseWrong"))
      rememberPassphraseUnlocked()
      onPassphrase?.()
      return
    }
    if (mode === "register" && !isValidPassword(password)) throw new Error(t("platformAuth.passwordRule"))
    const response =
      mode === "register"
        ? await authClient.register(email.trim(), code.trim(), password)
        : mode === "password"
          ? await authClient.loginWithPassword(email.trim(), password)
          : await authClient.loginWithCode(email.trim(), code.trim())
    await loginPlatform(response)
  }
  const passphraseHint = t("platformAuth.passphraseHint", { passphrase: LOCAL_PASSPHRASE })
  return (
    <div
      className={embedded ? "flex flex-col gap-4" : "flex h-dvh flex-col overflow-auto bg-background text-foreground"}
    >
      {embedded ? null : <div data-tauri-drag-region="deep" className="h-10 shrink-0" />}
      <div className={embedded ? "flex w-full flex-col gap-4" : "m-auto flex w-full max-w-md flex-col gap-6 px-6 py-8"}>
        <header className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold">{t("app.name")}</h1>
          <p className="text-sm text-muted-foreground">{t("platformAuth.intro")}</p>
        </header>
        <Tabs
          value={mode}
          onValueChange={(value) => {
            const mode: unknown = value
            if (mode !== "code" && mode !== "password" && mode !== "register" && mode !== "passphrase")
              throw new Error("Invalid login mode")
            setMode(mode)
            setCode("")
            setPassword("")
            setError("")
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="code" disabled={busy}>
              {t("platformAuth.codeLogin")}
            </TabsTrigger>
            <TabsTrigger value="password" disabled={busy}>
              {t("platformAuth.passwordLogin")}
            </TabsTrigger>
            <TabsTrigger value="register" disabled={busy}>
              {t("platformAuth.register")}
            </TabsTrigger>
            <TabsTrigger value="passphrase" disabled={busy}>
              {t("platformAuth.passphraseLogin")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run("submit")
          }}
        >
          <FieldGroup>
            {mode !== "passphrase" && (
              <Field data-disabled={busy}>
                <FieldLabel htmlFor="alwith-email">{t("platformAuth.email")}</FieldLabel>
                <Input
                  id="alwith-email"
                  type="email"
                  autoComplete="email"
                  required
                  disabled={busy}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
            )}
            {mode === "passphrase" && (
              <Field data-disabled={busy}>
                <FieldLabel htmlFor="alwith-passphrase">{t("platformAuth.passphrase")}</FieldLabel>
                <Input
                  id="alwith-passphrase"
                  type="password"
                  autoComplete="off"
                  required
                  disabled={busy}
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
                <FieldDescription>{passphraseHint}</FieldDescription>
              </Field>
            )}
            {mode !== "password" && mode !== "passphrase" && (
              <Field data-disabled={busy}>
                <FieldLabel htmlFor="alwith-code">{t("platformAuth.code")}</FieldLabel>
                <div className="flex items-center gap-2">
                  <Input
                    id="alwith-code"
                    className="min-w-0 flex-1"
                    autoComplete="one-time-code"
                    required
                    disabled={busy}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={busy || seconds > 0}
                    onClick={() => void run("sendCode")}
                  >
                    {pendingAction === "sendCode" && <Spinner data-icon="inline-start" />}
                    {seconds > 0 ? t("platformAuth.resend", { seconds }) : t("platformAuth.sendCode")}
                  </Button>
                </div>
              </Field>
            )}
            {mode !== "code" && mode !== "passphrase" && (
              <Field data-disabled={busy}>
                <FieldLabel htmlFor="alwith-password">{t("platformAuth.password")}</FieldLabel>
                <Input
                  id="alwith-password"
                  type="password"
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  required
                  disabled={busy}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {mode === "register" && <FieldDescription>{t("platformAuth.passwordRule")}</FieldDescription>}
              </Field>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={busy}>
              {pendingAction === "submit" && <Spinner data-icon="inline-start" />}
              {t(
                mode === "register"
                  ? "platformAuth.register"
                  : mode === "passphrase"
                    ? "platformAuth.passphraseUnlock"
                    : "platformAuth.signIn"
              )}
            </Button>
          </FieldGroup>
        </form>
        {/* The account service only answers inside the company network, so a reader away from it
            would otherwise face a wall they cannot pass. The passphrase is that door: local only,
            never sent anywhere, and it does not fake an account. */}
        {onPassphrase && mode !== "passphrase" && (
          <div className="flex flex-col items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setMode("passphrase")
                setError("")
              }}
            >
              {t("platformAuth.usePassphrase")}
            </Button>
            <p className="text-center text-xs text-muted-foreground">{passphraseHint}</p>
          </div>
        )}
      </div>
    </div>
  )
}
