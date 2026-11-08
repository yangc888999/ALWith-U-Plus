/**
 * Unseen activity — runs that finished or are waiting on the user since the activity panel was
 * last opened. The badge lives in the window title bar now, but the sidebar panel still clears it,
 * so both read the same derivation.
 */

import { useEffect, useMemo } from "react"

import { useApp } from "@/lib/client"

import { type SidebarView, useSessionsUiStore } from "./store"

export function useActivityNotification(view: SidebarView): {
  notifications: Map<string, string>
  hasNotification: boolean
} {
  const runStates = useApp((state) => state.runStates)
  const draftSessions = useApp((state) => state.draftSessions)
  const activitySeen = useSessionsUiStore((state) => state.activitySeen)
  const setActivitySeen = useSessionsUiStore((state) => state.setActivitySeen)
  const notifications = useMemo(
    () =>
      new Map(
        Object.values(runStates)
          .filter(
            (record) =>
              (record.state === "done" || record.state === "requires_action") &&
              (!record.reusableDraft || draftSessions[record.sessionId] !== undefined)
          )
          .map((record) => [record.sessionId, JSON.stringify([record.state, record.since, record.interruption])])
      ),
    [runStates, draftSessions]
  )
  const hasNotification =
    view !== "activity" && [...notifications].some(([id, notification]) => activitySeen.get(id) !== notification)
  // Opening the panel is the acknowledgement; it lives here so every reader of the badge agrees.
  useEffect(() => {
    if (view === "activity") setActivitySeen(notifications)
  }, [view, notifications, setActivitySeen])
  return { notifications, hasNotification }
}
