/**
 * Warns, once per conversation per launch, when its recorded 分工 points at a closed provider.
 *
 * A split is stored with the chat, so closing a provider leaves old conversations asking for a
 * model that no longer resolves. Nothing crashes — the roles fall back to the main model — but that
 * is a silent behaviour change, so the conversation says it out loud when it is opened.
 */
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { getProviderSnapshot } from "@/lib/providers"
import { providerOfModel } from "@/lib/provider-usage"
import { orchestrationFor } from "@/lib/session-orchestration"

export function useOrchestrationProviderWarning(sessionId: string): void {
  const { t } = useTranslation()
  const warned = useRef<string | null>(null)
  useEffect(() => {
    if (warned.current === sessionId) return
    const split = orchestrationFor(sessionId)
    if (split === null) return
    const snapshot = getProviderSnapshot()
    if (snapshot === null) return
    const configured = new Set(Object.keys(snapshot.providers))
    const missing = new Set(
      [split.planner.model, split.worker.model]
        .map(providerOfModel)
        .filter((id): id is string => id !== null && !configured.has(id))
    )
    warned.current = sessionId
    if (missing.size === 0) return
    toast.warning(t("chat.orchestrationProviderClosed", { count: missing.size }), { duration: 10_000 })
  }, [sessionId, t])
}
