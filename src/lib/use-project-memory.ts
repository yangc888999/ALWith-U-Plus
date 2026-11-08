import { getCurrentWindow } from "@tauri-apps/api/window"
import { isTauri } from "@tauri-apps/api/core"
import { useEffect } from "react"
import type { Session } from "@alwith/api"

import { client } from "@/lib/client"
import { groupByDirectory } from "@/lib/groups"
import { recordTurnInProjectMemory } from "@/lib/project-memory"

/**
 * Mirrors completed turns into each project's `memory.md`.
 *
 * The client store is the only place that observes every turn regardless of which surface (main
 * or floating chat) ran it, so the subscription lives here rather than in a chat component that
 * unmounts on session switches.
 *
 * Only the main window records: the floating chat mirrors the same store, so letting both write
 * produced two appends of one turn within milliseconds — the file lives in a synced project, and
 * that race is what generated `memory (冲突副本 …).md` copies. The native side additionally skips a
 * turn it already contains, so a replay or an interrupted relaunch stays idempotent.
 */
export function useProjectMemory(): void {
  useEffect(() => {
    if (isTauri() && getCurrentWindow().label !== "main") return
    const recorded = new Set<string>()
    let swept = false

    // A group writes its own record (one section per round, with the moderator's conclusion); the
    // flat per-turn log is what made a group's memory.md unreadable. The discussion runner owns it.
    const worthRecording = (session: { cwd: string }): boolean => groupByDirectory(session.cwd) === null

    // Startup sweep: a turn can finish while the app is quitting, and the restored session list
    // may already sit in "idle" — the transition watcher below never sees those. The sweep runs on
    // the first snapshot that actually carries sessions (the list loads after mount); the native
    // side skips a marker it already has, so re-handing a recorded turn is harmless.
    const sweep = (sessions: Record<string, unknown>): void => {
      if (swept || Object.keys(sessions).length === 0) return
      swept = true
      for (const session of Object.values(sessions)) {
        const candidate = session as { state?: string; id: string; items?: unknown[]; cwd: string }
        if (candidate.state !== "idle") continue
        if (!worthRecording(candidate)) continue
        const last = candidate.items?.at(-1) as { id?: string } | undefined
        if (!last?.id) continue
        recorded.add(`${candidate.id}:${last.id}`)
        void recordTurnInProjectMemory(candidate as unknown as Session)
      }
    }

    const unsubscribe = client.store.subscribe((state, previous) => {
      sweep(state.sessions as unknown as Record<string, unknown>)
      for (const [id, session] of Object.entries(state.sessions)) {
        const before = previous.sessions[id]
        // Only a turn that actually ended counts: running/requires_action -> idle.
        if (!before || before.state === "idle" || session.state !== "idle") continue
        if (!worthRecording(session)) continue
        const last = session.items.at(-1)
        if (!last || recorded.has(`${id}:${last.id}`)) continue
        recorded.add(`${id}:${last.id}`)
        void recordTurnInProjectMemory(session)
      }
    })
    sweep(client.store.getState().sessions as unknown as Record<string, unknown>)
    return unsubscribe
  }, [])
}
