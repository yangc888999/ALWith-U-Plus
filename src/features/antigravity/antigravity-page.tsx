import { listen } from "@tauri-apps/api/event"
import { type ChatModelOption, ModelSelect } from "@alwith/module-chat/model-select"
import { ArrowLeftIcon, ArrowUpIcon, Loader2Icon, LogInIcon, LogOutIcon, SparklesIcon, SquareIcon } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { commands } from "@/bindings"
import { GoogleMark } from "@/components/icons/google-mark"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { ANTIGRAVITY_MODELS, ANTIGRAVITY_TIER_KEY } from "./models"

type SelectOption = { value: string; name: string; description?: string | null }
type ConfigOption = {
  id: string
  name: string
  category: string
  currentValue: string
  options: SelectOption[]
}
type ChatMessage = {
  id: string
  role: "user" | "assistant" | "tool"
  text: string
  streaming?: boolean
  title?: string
  status?: string
}
type Tier = { name?: string; id?: string } | null

const EVENT = "antigravity:event"

async function send(message: unknown): Promise<void> {
  await commands.antigravitySend({ message: JSON.stringify(message) })
}

/**
 * Experimental main-window surface for the official Antigravity ACP binary.
 *
 * This is deliberately a separate surface from Codex: the bridge owns no Codex session and the
 * official binary owns all Google credentials. U⁺ only sends prompts and renders the ACP updates.
 */
export function AntigravityPage({
  cwd,
  initialModel,
  embedded = false,
  onClose,
  onSwitchToCodex
}: {
  cwd: string | null
  /** A model picked in the main composer's menu; applied once the ACP session exists. */
  initialModel?: string | null
  embedded?: boolean
  onClose?: () => void
  onSwitchToCodex?: () => void
}): ReactNode {
  const { t } = useTranslation()
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const initialModelRef = useRef(initialModel)
  initialModelRef.current = initialModel
  const [phase, setPhase] = useState<"starting" | "login" | "connecting" | "session" | "error">("starting")
  const [tier, setTier] = useState<Tier>(() => {
    try {
      const raw = localStorage.getItem(ANTIGRAVITY_TIER_KEY)
      const value = raw === null ? null : (JSON.parse(raw) as Tier)
      return typeof value?.name === "string" ? value : null
    } catch {
      return null
    }
  })
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [configOptions, setConfigOptions] = useState<ConfigOption[]>([])
  const [model, setModel] = useState("")
  const [thinking, setThinking] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState("")
  const [running, setRunning] = useState(false)
  // The official ACP owns the credential in the macOS keychain. The page only asks whether it
  // exists; when it does, startup goes straight to `session.new` instead of flashing a login card.
  const signedIn = useRef<Promise<boolean> | null>(null)
  if (signedIn.current === null) {
    signedIn.current = commands
      .antigravityStatus()
      .then((status) => status.signedIn)
      .catch(() => false)
  }

  const finishAssistant = useCallback(() => {
    setMessages((current) => {
      const last = current[current.length - 1]
      if (last?.role !== "assistant" || last.streaming !== true) return current
      return [...current.slice(0, -1), { ...last, streaming: false }]
    })
  }, [])

  const appendAssistant = useCallback((text: string) => {
    setMessages((current) => {
      const last = current[current.length - 1]
      if (last?.role === "assistant" && last.streaming === true) {
        return [...current.slice(0, -1), { ...last, text: last.text + text }]
      }
      return [...current, { id: crypto.randomUUID(), role: "assistant", text, streaming: true }]
    })
  }, [])

  const handleUpdate = useCallback(
    (update: any) => {
      if (update?.sessionUpdate === "agent_message_chunk") {
        const content = update.content
        if (content?.type === "text" && typeof content.text === "string") appendAssistant(content.text)
        return
      }
      if (update?.sessionUpdate === "tool_call") {
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "tool",
            text: "",
            title: update.title ?? update.name ?? "Tool",
            status: update.status ?? "pending"
          }
        ])
        return
      }
      if (update?.sessionUpdate === "tool_call_update") {
        setMessages((current) =>
          current.map((message) =>
            message.role === "tool" && message.title === (update.title ?? update.name ?? message.title)
              ? { ...message, status: update.status ?? message.status }
              : message
          )
        )
        return
      }
      if (update?.sessionUpdate === "state_update") {
        setRunning(update.state === "running" || update.state === "requires_action")
      }
    },
    [appendAssistant]
  )

  const handleEvent = useCallback(
    (event: any) => {
      switch (event?.type) {
        case "ready": {
          void signedIn.current?.then((authenticated) => {
            if (!authenticated) {
              setPhase("login")
              return
            }
            setPhase("connecting")
            void send({ type: "session.new", cwd: cwdRef.current ?? "" }).catch((failure: unknown) =>
              setError(failure instanceof Error ? failure.message : String(failure))
            )
          })
          return
        }
        case "logged_in": {
          signedIn.current = Promise.resolve(true)
          setTier(event.tier ?? null)
          try {
            localStorage.setItem("alwith:antigravity:tier", JSON.stringify(event.tier ?? null))
          } catch {
            // Local defaults are best effort.
          }
          setPhase("connecting")
          void send({ type: "session.new", cwd: cwdRef.current ?? "" }).catch((failure: unknown) =>
            setError(failure instanceof Error ? failure.message : String(failure))
          )
          return
        }
        case "logged_out": {
          signedIn.current = Promise.resolve(false)
          setTier(null)
          setSessionId(null)
          setMessages([])
          setRunning(false)
          setPhase("login")
          return
        }
        case "session": {
          setSessionId(event.sessionId)
          setConfigOptions(Array.isArray(event.configOptions) ? event.configOptions : [])
          const modelOption = (event.configOptions ?? []).find((entry: ConfigOption) => entry.category === "model")
          const thinkingOption = (event.configOptions ?? []).find(
            (entry: ConfigOption) => entry.category === "thought_level"
          )
          setModel(modelOption?.currentValue ?? "")
          setThinking(thinkingOption?.currentValue ?? "")
          const preferredModel = initialModelRef.current ?? localStorage.getItem("alwith:antigravity:default-model")
          const preferredThinking = localStorage.getItem("alwith:antigravity:default-thinking")
          if (
            preferredModel !== null &&
            modelOption?.options.some((entry: SelectOption) => entry.value === preferredModel) === true
          ) {
            setModel(preferredModel)
            void send({ type: "config", configId: "model", value: preferredModel }).catch(() => {})
          }
          if (
            preferredThinking !== null &&
            thinkingOption?.options.some((entry: SelectOption) => entry.value === preferredThinking) === true
          ) {
            setThinking(preferredThinking)
            void send({ type: "config", configId: "thinking_level", value: preferredThinking }).catch(() => {})
          }
          setPhase("session")
          return
        }
        case "running":
          setRunning(true)
          return
        case "update":
          handleUpdate(event.update)
          return
        case "done":
          setRunning(false)
          finishAssistant()
          return
        case "error":
          setRunning(false)
          setError(typeof event.message === "string" ? event.message : t("antigravity.error"))
          setPhase("error")
          return
        case "exit":
          setRunning(false)
          setError(t("antigravity.exited"))
          setPhase("error")
          return
      }
    },
    [finishAssistant, handleUpdate, t]
  )

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      unlisten = await listen<string>(EVENT, (event) => {
        if (disposed) return
        try {
          handleEvent(JSON.parse(event.payload))
        } catch {
          // A malformed bridge line is not a protocol state; keep the last known state.
        }
      })
      try {
        await commands.antigravityStart()
        if (!disposed) await send({ type: "initialize" })
      } catch (failure) {
        if (disposed) return
        setError(failure instanceof Error ? failure.message : String(failure))
        setPhase("error")
      }
    })()
    return () => {
      disposed = true
      unlisten?.()
      void commands.antigravityStop().catch(() => {})
    }
  }, [handleEvent])

  const login = (): void => {
    setError(null)
    setPhase("connecting")
    void send({ type: "login", methodId: "oauth-personal" }).catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure))
      setPhase("error")
    })
  }

  const logout = (): void => {
    void send({ type: "logout" }).catch(() => {})
    localStorage.removeItem("alwith:antigravity:tier")
    setTier(null)
    setSessionId(null)
    setMessages([])
    setPhase("login")
    signedIn.current = Promise.resolve(false)
  }

  const setConfig = (configId: string, value: string): void => {
    if (configId === "model") setModel(value)
    if (configId === "thinking_level") setThinking(value)
    setConfigOptions((current) =>
      current.map((entry) => (entry.id === configId ? { ...entry, currentValue: value } : entry))
    )
    void send({ type: "config", configId, value }).catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : String(failure))
    )
  }

  const submit = (): void => {
    if (sessionId === null || running) return
    const text = input.trim()
    if (text === "") return
    setInput("")
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text }])
    setRunning(true)
    void send({ type: "prompt", text }).catch((failure: unknown) => {
      setRunning(false)
      setError(failure instanceof Error ? failure.message : String(failure))
      setPhase("error")
    })
  }

  const cancel = (): void => {
    setRunning(false)
    void send({ type: "cancel" }).catch(() => {})
  }

  const modelOptions = configOptions.find((entry) => entry.category === "model")?.options ?? []
  const thinkingOptions = configOptions.find((entry) => entry.category === "thought_level")?.options ?? []
  const pickerModels: ChatModelOption[] = (
    modelOptions.length > 0 ? modelOptions.map((option) => ({ api_id: option.value, label: option.name })) : ANTIGRAVITY_MODELS.map((entry) => ({ api_id: entry.id, label: entry.label }))
  ).map((entry) => ({ ...entry, icon: <GoogleMark className="size-4 text-[9px]" /> }))
  const pickerValue = pickerModels.find((entry) => entry.api_id === model) ?? pickerModels[0] ?? { api_id: "", label: "" }

  return (
    <div className="bg-background flex h-full min-h-0 flex-col" data-antigravity-page="">
      <header className="border-border/70 flex min-h-12 shrink-0 items-center gap-3 border-b px-4">
        {!embedded && onClose !== undefined && (
          <Button variant="ghost" size="icon-sm" aria-label={t("antigravity.back")} onClick={onClose}>
            <ArrowLeftIcon />
          </Button>
        )}
        <span className="grid size-7 place-items-center rounded-lg bg-[linear-gradient(135deg,#4285f4,#8b6de0_55%,#ea4335)] text-xs font-bold text-white">
          ✦
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{t("antigravity.title")}</h1>
            <span className="border-border text-muted-foreground rounded-full border px-1.5 py-0.5 text-[10px]">
              {t("antigravity.experimental")}
            </span>
          </div>
          <p className="text-muted-foreground truncate text-[11px]">
            {tier?.name ?? t("antigravity.subtitle")}
          </p>
        </div>
        {onSwitchToCodex !== undefined && (
          <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={onSwitchToCodex}>
            Codex
          </Button>
        )}
        {phase === "session" && (
          <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {tier?.name ?? t("antigravity.connected")}
            <Button variant="ghost" size="icon-sm" aria-label={t("antigravity.logout")} onClick={logout}>
              <LogOutIcon />
            </Button>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {phase === "starting" && (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            {t("antigravity.starting")}
          </div>
        )}

        {(phase === "login" || phase === "connecting") && (
          <div className="mx-auto mt-20 w-full max-w-md px-6">
            <div className="border-border bg-card rounded-2xl border p-6 text-center shadow-sm">
              <GoogleMark className="mx-auto size-10" />
              <h2 className="mt-4 text-base font-semibold">{t("antigravity.connectTitle")}</h2>
              <p className="text-muted-foreground mt-2 text-xs leading-6">{t("antigravity.connectHint")}</p>
              <Button className="mt-5 w-full" disabled={phase === "connecting"} onClick={login}>
                {phase === "connecting" ? <Loader2Icon className="animate-spin" /> : <LogInIcon />}
                {phase === "connecting" ? t("antigravity.waitingLogin") : t("antigravity.connect")}
              </Button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="mx-auto mt-20 w-full max-w-lg px-6">
            <div className="border-destructive/30 bg-destructive/5 rounded-2xl border p-6">
              <h2 className="text-destructive text-sm font-semibold">{t("antigravity.error")}</h2>
              <p className="text-muted-foreground mt-2 whitespace-pre-wrap text-xs leading-6">{error}</p>
              <Button className="mt-4" variant="outline" onClick={() => setPhase("login")}>
                {t("antigravity.retry")}
              </Button>
            </div>
          </div>
        )}

        {phase === "session" && (
          <div className="mx-auto w-full max-w-3xl px-5 py-6">
            {messages.length === 0 && (
              <div className="text-muted-foreground pt-20 text-center text-sm">{t("antigravity.empty")}</div>
            )}
            <div className="space-y-4">
              {messages.map((message) =>
                message.role === "tool" ? (
                  <div
                    key={message.id}
                    className="border-sky-500/20 bg-sky-500/5 text-muted-foreground ml-1 flex w-fit max-w-[85%] items-center gap-2 rounded-lg border px-3 py-2 text-[11px]"
                  >
                    <SparklesIcon className="size-3 text-sky-500" />
                    <span className="text-foreground/80">{message.title}</span>
                    <span className="text-[10px]">{message.status ?? ""}</span>
                  </div>
                ) : (
                  <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                    <div
                      className={cn(
                        "max-w-[82%] whitespace-pre-wrap rounded-2xl border px-3.5 py-2.5 text-[13px] leading-6",
                        message.role === "user"
                          ? "bg-muted border-border/60 rounded-br-md"
                          : "bg-card border-border/70 rounded-bl-md"
                      )}
                    >
                      {message.text}
                      {message.streaming === true && <span className="ml-0.5 animate-pulse">▍</span>}
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </div>

      {phase === "session" && (
        <footer className="border-border/70 shrink-0 border-t px-4 py-3">
          <div className="bg-card border-border mx-auto w-full max-w-3xl overflow-hidden rounded-2xl border">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  submit()
                }
              }}
              rows={2}
              className="placeholder:text-muted-foreground/60 w-full resize-none bg-transparent px-3.5 py-3 text-[13px] leading-6 outline-none"
              placeholder={t("antigravity.placeholder")}
            />
            <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5">
              {pickerModels.length > 0 && (
                <ModelSelect
                  value={{ ...pickerValue, icon: <GoogleMark className="size-4 text-[9px]" /> }}
                  models={pickerModels}
                  modelGroups={[{ id: "google-antigravity", name: "Google Antigravity", models: pickerModels }]}
                  compactCatalog
                  header={{ name: t("antigravity.model") }}
                  className="model-picker-trigger"
                  onChange={(entry) => setConfig("model", entry.api_id)}
                  t={(key) => t(key, { ns: "alwithChat" })}
                />
              )}
              {thinkingOptions.length > 0 && (
                <select
                  aria-label={t("antigravity.thinking")}
                  value={thinking}
                  onChange={(event) => setConfig("thinking_level", event.target.value)}
                  className="border-border bg-muted/40 text-muted-foreground rounded-md border px-2 py-1 text-[11px] outline-none"
                >
                  {thinkingOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.name}
                    </option>
                  ))}
                </select>
              )}
              <span className="text-muted-foreground ml-auto hidden text-[10px] sm:block">
                {t("antigravity.official")}
              </span>
              <Button size="icon-sm" aria-label={running ? t("antigravity.stop") : t("antigravity.send")} onClick={running ? cancel : submit}>
                {running ? <SquareIcon className="size-3" /> : <ArrowUpIcon className="size-4" />}
              </Button>
            </div>
          </div>
        </footer>
      )}
    </div>
  )
}
