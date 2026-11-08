import { type SessionListHost, SessionListProvider } from "@alwith/module-chat/session-list"
import { type ReactNode, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { client } from "@/lib/client"

import { ProjectPathAction } from "./project-path-action"

function SessionPathAction({ cwd, onOpened }: { cwd: string; onOpened: () => void }) {
  return <ProjectPathAction cwd={cwd} onOpened={onOpened} appearance="session" />
}

/**
 * The vendored list titles its own groups; the quick-chat group is U's 会话 section, whose hover
 * card already uses `sidebar.quickChats`. Answering that one key from the app bundle keeps the
 * group header and its popover title saying the same thing.
 */
const APP_STRING_KEYS: Readonly<Record<string, string>> = { "sessionList.quickChats": "sidebar.quickChats" }

/** U's strings, toasts and folder action for `@alwith/module-chat`'s session list, over the app's client. */
export function SessionListHostProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation()
  const language = i18n.language
  const host = useMemo(
    () =>
      ({
        t: (key, values) => {
          const appKey = APP_STRING_KEYS[key]
          if (appKey !== undefined) return i18n.t(appKey)
          return i18n.t(key, { ...values, ns: "alwithChat" })
        },
        i18n: { language },
        PathAction: SessionPathAction,
        reportError: (error) => toast.error(error instanceof Error ? error.message : String(error))
      }) satisfies SessionListHost,
    [i18n, language]
  )
  return (
    <SessionListProvider host={host} client={client}>
      {children}
    </SessionListProvider>
  )
}
