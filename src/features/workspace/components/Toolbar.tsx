import type { ReactNode } from "react"
import { Fragment } from "react"

import { ToolbarButton, type ToolbarButtonProps } from "./ToolbarButton"

/**
 * One toolbar entry. The visual is identical for every button (handled by ToolbarButton); the caller
 * computes the business logic (disabled / pressed / onClick) and simply lists the entries. `Toolbar`
 * arranges the groups and draws a short, low-contrast separator before any entry flagged
 * `separator`. Both the Markdown and HTML toolbars feed this component, so their layout, sizing,
 * grouping and active/disabled states can never diverge.
 */
export interface ToolbarItem extends ToolbarButtonProps {
  /** Stable React key. */
  key: string
  /** Draw a short separator before this entry. */
  separator?: boolean
}

export function Toolbar({
  ariaLabel,
  items
}: {
  ariaLabel: string
  items: ToolbarItem[]
}): ReactNode {
  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      className="alwith-wysiwyg-toolbar"
    >
      {items.map((item) => {
        const { key, separator, ...buttonProps } = item
        return (
          <Fragment key={key}>
            {separator === true && <span className="alwith-wysiwyg-separator" aria-hidden="true" />}
            <ToolbarButton {...buttonProps} />
          </Fragment>
        )
      })}
    </div>
  )
}
