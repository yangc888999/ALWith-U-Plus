import type { Session } from "@alwith/api"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { client } from "@/lib/client"
import { useProviders } from "@/lib/use-providers"

import { DraftModelSelect } from "./draft-model-select"

/**
 * Shown when an account-owned model was revoked: the history stays readable while a new pick
 * resumes it. This card is the *only* model picker on the surface during recovery — the package's
 * own picker is disabled and replaced by `modelSelector` in the composer — and "继续" stays
 * unavailable until a model has actually been picked. Everything still goes through
 * `client.resumeAccountModel`: the account-consistency lock in the client is intentional.
 */
export function AccountModelRecovery({ session }: { session: Session }) {
  const { t } = useTranslation()
  const snapshot = useProviders()
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  async function recover(selected: string | null): Promise<void> {
    if (selected === null) return
    setBusy(true)
    setFailure(null)
    try {
      await client.resumeAccountModel(session.id, selected)
      toast.success(t("provider.managed.recovered"))
    } catch (error) {
      // Keep `model`: the reader must be able to retry the same pick or change it, not start over.
      const reason = error instanceof Error ? error.message : String(error)
      setFailure(reason)
      toast.error(reason)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="account-model-recovery flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 text-sm text-muted-foreground"
      data-account-recovery=""
      data-recovery-model={model ?? "none"}
      aria-busy={busy}
    >
      <span>{t("provider.managed.reselect")}</span>
      <fieldset disabled={busy} className="flex min-w-0 items-center gap-2">
        <DraftModelSelect
          snapshot={snapshot}
          model={model}
          onChange={(next) => {
            setModel(next)
            setFailure(null)
          }}
          placeholder={t("provider.managed.selectModelPlaceholder")}
        />
      </fieldset>
      {model === null && (
        <span className="text-xs text-amber-600 dark:text-amber-400">{t("provider.managed.selectModelFirst")}</span>
      )}
      {failure !== null && (
        <span role="alert" className="w-full text-xs text-destructive">
          {failure}
        </span>
      )}
      <Button size="sm" disabled={busy || model === null} onClick={() => void recover(model)}>
        {t("provider.managed.resume")}
      </Button>
    </div>
  )
}
