import type { ReactElement, SVGProps } from "react"

type GlyphProps = SVGProps<SVGSVGElement>

function Glyph({ children, width = 18, height = 18, ...props }: GlyphProps & { children: ReactElement | ReactElement[] }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={width}
      height={height}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

/** A recurring clock: schedule cadence first, clock face second. */
export function ScheduledTasksGlyph(props: GlyphProps): ReactElement {
  return (
    <Glyph data-feature-glyph="scheduled-tasks" {...props}>
      <g transform="translate(12 12) scale(1.18) translate(-12 -12)">
        <path d="M20.1 12.9a8.25 8.25 0 1 1-2.2-7" />
        <path d="M20.35 3.8v4.2h-4.2" />
        <path d="M12 7.25v4.95l3.05 1.8" />
        <circle cx="12" cy="12.2" r="0.8" fill="currentColor" stroke="none" />
      </g>
    </Glyph>
  )
}

/** Three participants around a round table: distinct from a generic contacts icon. */
export function MeetingsGlyph(props: GlyphProps): ReactElement {
  return (
    <Glyph data-feature-glyph="meetings" {...props}>
      <g transform="translate(12 13.2) scale(1.18) translate(-12 -12)">
        <ellipse cx="12" cy="12" rx="4.65" ry="2.75" />
        <circle cx="12" cy="4.35" r="1.55" fill="currentColor" stroke="none" />
        <circle cx="5.35" cy="16.65" r="1.55" fill="currentColor" stroke="none" />
        <circle cx="18.65" cy="16.65" r="1.55" fill="currentColor" stroke="none" />
        <path d="M12 5.9v3.15M7.05 15.45l1.55-1.15M16.95 15.45l-1.55-1.15" />
      </g>
    </Glyph>
  )
}
