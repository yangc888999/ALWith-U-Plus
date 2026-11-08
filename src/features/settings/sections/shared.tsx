// Settings primitives: a page header, cards that group related rows, and the row itself.
// Every settings page is built from these three pieces so the pages read the same way.
import { ChevronDownIcon } from "lucide-react"
import { type ReactNode, useId } from "react"

import { cn } from "@/lib/utils"

export function SettingLabel({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 cursor-default text-sm font-medium">{children}</h2>
}

export function SettingGroup({ children }: { children: ReactNode }) {
  return <div className="settings-group flex w-full min-w-0 flex-col">{children}</div>
}

/**
 * Page header: one tinted glyph, the page name and a sentence about what the page is for.
 * Rendered by the settings shell, so every page — including extension-provided ones — starts
 * with the same block instead of a bare list of controls.
 */
export function SettingsPageHeader({
  title,
  desc,
  icon
}: {
  title: string
  desc?: string
  icon?: ReactNode
}) {
  return (
    <header className="settings-page-header">
      {icon !== undefined && <span className="settings-icon-chip">{icon}</span>}
      <div className="min-w-0 flex-1">
        <h1 className="settings-page-title">{title}</h1>
        {desc !== undefined && <p className="settings-page-desc">{desc}</p>}
      </div>
    </header>
  )
}

/**
 * Card: a titled group of rows. The header carries a short "what lives here" line so a long
 * page can be skimmed by card title alone; `action` holds the one button that belongs to the
 * whole group (reset, open folder, …).
 */
export function SettingsCard({
  title,
  desc,
  icon,
  action,
  children
}: {
  title?: string
  desc?: string
  icon?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="settings-card">
      {title !== undefined && (
        <div className="settings-card-head">
          <div className="flex min-w-0 items-center gap-2">
            {icon !== undefined && <span className="settings-card-icon">{icon}</span>}
            <div className="min-w-0">
              <h2 className="settings-card-title">{title}</h2>
              {desc !== undefined && <p className="settings-card-desc">{desc}</p>}
            </div>
          </div>
          {action !== undefined && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className="settings-card-body">{children}</div>
    </section>
  )
}

/** A short explainer inside a card, for things that are not a control of their own. */
export function SettingsNote({ children }: { children: ReactNode }) {
  return <p className="settings-note">{children}</p>
}

/** Collapsible secondary detail (diagnostics, advanced options). */
export function SettingsDetails({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="settings-details">
      <summary>
        <ChevronDownIcon className="size-3.5" aria-hidden="true" />
        {summary}
      </summary>
      <div className="settings-details-body">{children}</div>
    </details>
  )
}

export function SettingRow({
  title,
  desc,
  children,
  aligned = false,
  compact = false
}: {
  title: string
  /** Short secondary text under the title. ReactNode so a row can render a monospace path etc. */
  desc?: ReactNode
  children?: ReactNode
  aligned?: boolean
  /** Tighter vertical rhythm for card-style pages (About). */
  compact?: boolean
}) {
  const id = useId()
  return (
    <div
      role="group"
      aria-labelledby={`${id}-title`}
      aria-describedby={desc ? `${id}-description` : undefined}
      className={cn("settings-row", aligned && "settings-row-aligned")}
      data-compact={compact ? "" : undefined}
    >
      <div className="min-w-0">
        <div id={`${id}-title`} className="text-sm leading-5 font-medium">
          {title}
        </div>
        {desc && (
          <div
            id={`${id}-description`}
            className="settings-row-description mt-1 text-xs leading-5 text-muted-foreground"
          >
            {desc}
          </div>
        )}
      </div>
      {children && <div className="settings-row-control">{children}</div>}
    </div>
  )
}
