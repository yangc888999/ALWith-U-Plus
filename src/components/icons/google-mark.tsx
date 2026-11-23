import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/** The four-colour Google mark used by the Antigravity account rows and model menu. */
export function GoogleMark({ className }: { className?: string }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative grid size-5 shrink-0 place-items-center rounded-full bg-white text-[11px] font-bold text-[#202124]",
        className
      )}
    >
      <span className="absolute inset-0 rounded-full bg-[conic-gradient(from_-40deg,#4285f4_0_25%,#34a853_25%_50%,#fbbc05_50%_75%,#ea4335_75%_100%)]" />
      <span className="absolute inset-[2px] rounded-full bg-white" />
      <span className="relative">G</span>
    </span>
  )
}
