import { type SessionListClient, type SessionListHost, SessionListProvider } from "@alwith/module-chat/session-list"
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
  const listClient = useMemo<SessionListClient>(
    () => ({
      store: client.store,
      get state() {
        return client.state
      },
      listSessions: (options) => client.listSessions(options),
      listArchived: (options) => client.listArchived(options),
      renameSession: (id, name) => client.renameSession(id, name),
      fork: (id, cwd) => client.fork(id, cwd),
      archive: (id) => client.archive(id),
      unarchive: (id) => client.unarchive(id),
      delete: (id) => client.delete(id),
      // A row's stop button is a reader gesture on an existing chat, not a delete: reopen the
      // chat when it is the one on screen so it is immediately ready for another message.
      stopSession: (id) => client.stopSessionAndReopen(id),
      activityReply: (id) => client.activityReply(id),
      projectPath: (cwd) => client.projectPath(cwd)
    }),
    []
  )
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
    <SessionListProvider host={host} client={listClient}>
      {children}
    </SessionListProvider>
  )
}
