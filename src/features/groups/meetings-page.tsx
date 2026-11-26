import type { SessionSummary } from "@/agent/client"
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"

import { MeetingsGlyph } from "@/features/layout/components/feature-glyphs"
import { GroupSection } from "@/features/settings/sections/group-section"
import "@/features/settings/settings.css"

import { GroupPanel } from "./group-panel"

/** The leading-screen meeting workspace: live meetings first, role library beside it on wide pages. */
export function MeetingsPage({
  onSelect,
  onNewChat,
  onViewFiles,
  focusRolesRevision = 0
}: {
  onSelect: (row: SessionSummary) => void
  onNewChat: (cwd: string, groupId?: string | null) => void
  onViewFiles?: (directory: string, groupId: string) => void
  /** Bumped when the sidebar's empty-roster action asks this page to reveal the role library. */
  focusRolesRevision?: number
}) {
  const { t } = useTranslation()
  const rolesRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (focusRolesRevision === 0) return
    const frame = requestAnimationFrame(() => {
      rolesRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })
      rolesRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusRolesRevision])
  const revealRoles = (): void => {
    rolesRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })
    rolesRef.current?.focus({ preventScroll: true })
  }
  return (
    <div data-meetings-page="" className="@container h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-8 sm:px-6 lg:px-8">
        <header className="mb-5 flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <MeetingsGlyph className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl leading-7 font-semibold">{t("settings.groups")}</h1>
            <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">{t("settings.groupsDesc")}</p>
          </div>
        </header>

        <div className="grid min-w-0 grid-cols-1 gap-4 @5xl:grid-cols-[minmax(17rem,0.72fr)_minmax(0,1.55fr)]">
          <section
            aria-label={t("groups.panelSessions")}
            className="flex h-[22rem] min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-background/45 shadow-xs @5xl:h-[calc(100vh-13rem)] @5xl:max-h-[38rem] @5xl:sticky @5xl:top-6 @5xl:self-start"
          >
            <GroupPanel
              onSelect={onSelect}
              onNewChat={onNewChat}
              onViewFiles={onViewFiles}
              onManageRoles={revealRoles}
            />
          </section>

          <section
            ref={rolesRef}
            id="meeting-role-library"
            tabIndex={-1}
            className="min-w-0 scroll-mt-6 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            <GroupSection />
          </section>
        </div>
      </div>
    </div>
  )
}
