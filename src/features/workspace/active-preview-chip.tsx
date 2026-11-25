import { QuoteIcon, XIcon } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import { getActivePreview, setActivePreview, subscribeActivePreview, type ActivePreviewDocument } from "@/lib/active-preview"
import { cn } from "@/lib/utils"

/** Subscribes a component to the document currently shown in the preview pane. */
function useActivePreview(): ActivePreviewDocument | null {
  return useSyncExternalStore(subscribeActivePreview, getActivePreview, getActivePreview)
}

/**
 * A long document name loops instead of being cut.
 *
 * The chip is capped at a third of the composer, so a real chart title ("余额下降与风险管控影响
 * 分析_2610…") never fits. A tooltip only helps after a hover, so the name itself slides: two copies
 * with a trailing gap, translated by exactly one copy's width, which makes the loop seamless.
 */
function MarqueeName({ children }: { children: string }): ReactNode {
  const container = useRef<HTMLSpanElement>(null)
  const measure = useRef<HTMLSpanElement>(null)
  const [looping, setLooping] = useState(false)

  useEffect(() => {
    const box = container.current
    const text = measure.current
    if (box === null || text === null) return
    const check = (): void => setLooping(text.offsetWidth > box.clientWidth + 2)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(box)
    return () => observer.disconnect()
  }, [children])

  return (
    <span ref={container} className="relative min-w-0 flex-1 overflow-hidden">
      {/* The natural width of the name, laid out invisibly: the visible track is two copies once
          it loops, so measuring it would always report an overflow. */}
      <span ref={measure} aria-hidden="true" className="invisible pointer-events-none absolute whitespace-nowrap">
        {children}
      </span>
      <span className={cn("inline-flex w-max", looping && "alwith-marquee")}>
        <span className="pe-6">{children}</span>
        {/* The second copy is what the loop slides in; screen readers already read the first. */}
        {looping && (
          <span className="pe-6" aria-hidden="true">
            {children}
          </span>
        )}
      </span>
    </span>
  )
}

/**
 * A small chip above the composer that tells the user which document their next message refers to.
 *
 * It mirrors exactly what `CodexClient.prompt` attaches to the model request, so the behaviour is
 * visible instead of silent. Hidden when the preview is closed or showing no document.
 *
 * The wording lives in the tooltip/accessible name only: a leading "正在引用" cost more room than
 * the chip had, and the quote mark already says "this answer is quoting a document".
 */
export function ActivePreviewChip(): ReactNode {
  const doc = useActivePreview()
  const { t } = useTranslation()
  if (doc === null) return null
  // Clearing publishes `null`; the workspace only re-publishes when the visible document
  // changes, so the choice sticks instead of being re-applied on the next render.
  const clear = (): void => setActivePreview(null)
  const label = t("chat.previewContext", { name: doc.title })
  return (
    <span
      className="border-border/60 bg-muted/40 text-muted-foreground inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border px-1 py-0.5 text-[11px]"
      title={`${label}\n${doc.path}\n${t("chat.previewContextClearHint")}`}
      aria-label={label}
      onDoubleClick={clear}
    >
      <QuoteIcon className="size-3 shrink-0 opacity-70" aria-hidden="true" />
      {/* The document name is the point of the chip: accent it so the eye lands on the file
          rather than on the quote mark. */}
      <span className="flex min-w-0 flex-1 font-medium text-sky-600 dark:text-sky-400">
        <MarqueeName>{doc.title}</MarqueeName>
      </span>
      <button
        type="button"
        aria-label={t("chat.previewContextClear")}
        title={t("chat.previewContextClear")}
        className="hover:bg-muted hover:text-foreground -me-0.5 ms-0.5 grid size-3.5 shrink-0 place-items-center rounded-sm"
        onClick={clear}
      >
        <XIcon className="size-3" />
      </button>
    </span>
  )
}
