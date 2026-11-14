import type { ReactNode } from "react"

/**
 * A single WYSIWYG toolbar button. Two variants share one visual language so the Markdown and HTML
 * toolbars can never drift:
 *  - `icon` (default): a 32px square holding a 16px linear icon.
 *  - `primary`: the only accent action (the edit toggle) — outline when idle, filled when active.
 *
 * Every button keeps the editor selection on mousedown (so a click never blurs the document first)
 * unless `keepSelection` is false (the edit toggle does not need it). All colours come from the
 * app's semantic theme variables, so the button is correct in light + dark + 主题色 presets.
 */
export interface ToolbarButtonProps {
  /** The lucide icon node; CSS sizes it to 16px. */
  icon: ReactNode
  /** Tooltip and default accessible name. */
  title: string
  /** Explicit accessible name; defaults to `title` (lets the edit button show a richer tooltip). */
  ariaLabel?: string
  /** When set, renders the icon beside this text — a wider action button. */
  label?: string
  /** Visual variant. @default "icon" */
  variant?: "icon" | "primary"
  /** Toggle state: an applied format (icon) or active edit mode (primary). */
  pressed?: boolean
  /** Disabled state. */
  disabled?: boolean
  /** Keep the editor selection by preventing the default mousedown blur. @default true */
  keepSelection?: boolean
  onClick?: () => void
}

export function ToolbarButton({
  icon,
  title,
  ariaLabel,
  label,
  variant = "icon",
  pressed = false,
  disabled = false,
  keepSelection = true,
  onClick
}: ToolbarButtonProps): ReactNode {
  const isPrimary = variant === "primary"
  return (
    <button
      type="button"
      className={isPrimary ? "alwith-markdown-action alwith-toolbar-btn--primary" : "alwith-markdown-action"}
      title={title}
      aria-label={ariaLabel ?? title}
      aria-pressed={pressed}
      disabled={disabled}
      onMouseDown={
        keepSelection
          ? (event) => {
              // Keep the editor selection: a toolbar click must not blur the document first.
              event.preventDefault()
            }
          : undefined
      }
      onClick={() => onClick?.()}
    >
      {icon}
      {label !== undefined && <span>{label}</span>}
    </button>
  )
}
