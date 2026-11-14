import type { Session } from "@alwith/api"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { client } from "@/lib/client"
import { useProviders } from "@/lib/use-providers"

import { DraftModelSelect } from "./draft-model-select"

/**
 * Account-model recovery: one notice, one model entry.
 *
 * The old surface put the picker in the recovery card *and* kept the composer's own (dead) picker
 * next to it, so readers saw two model controls and clicked the disabled one. The state now lives
 * at the composer level and is rendered exactly once — in the composer's bottom-right toolbar,
 * where the normal model picker lives. The card above is explanation only.
 */
export interface AccountRecoveryState {
  model: string | null
  setModel: (model: string | null) => void
  busy: boolean
  failure: string | null
  recover: () => void
}

/** Owns the recovery pick once per composer; both surfaces below read the same state. */
export function useAccountModelRecovery(session: Session): AccountRecoveryState {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const recover = (): void => {
    if (model === null) return
    setBusy(true)
    setFailure(null)
    void client
      .resumeAccountModel(session.id, model)
      .then(() => toast.success(t("provider.managed.recovered")))
      .catch((error: unknown) => {
        // Keep `model`: the reader must be able to retry the same pick or change it, not start over.
        const reason = error instanceof Error ? error.message : String(error)
        setFailure(reason)
        toast.error(reason)
      })
      .finally(() => setBusy(false))
  }

  return {
    model,
    setModel: (next) => {
      setModel(next)
      setFailure(null)
    },
    busy,
    failure,
    recover
  }
}

/** Explanation only — the picker and the resume action belong to the composer's bottom-right. */
export function AccountModelRecovery({ state }: { state: AccountRecoveryState }) {
  const { t } = useTranslation()
  return (
    <div
      className="account-model-recovery grid gap-1 px-4 py-2.5 text-sm text-muted-foreground"
      data-account-recovery=""
      data-recovery-model={state.model ?? "none"}
      aria-busy={state.busy}
    >
      <span>{t("provider.managed.reselect")}</span>
      {state.failure !== null && (
        <span role="alert" className="text-xs text-destructive">
          {state.failure}
        </span>
      )}
    </div>
  )
}

/**
 * The single model entry. Rendered through `Composer`'s `modelSelector` slot, so it sits in the
 * bottom-right toolbar next to the send button — the same place the normal picker occupies — and
 * there is never a second "选择模型" control elsewhere on the surface.
 */
export function RecoveryModelSelector({ state }: { state: AccountRecoveryState }) {
  const { t } = useTranslation()
  const snapshot = useProviders()
  return (
    <div className="flex min-w-0 items-center gap-1" data-recovery-model={state.model ?? "none"}>
      <fieldset disabled={state.busy} className="min-w-0">
        <DraftModelSelect
          snapshot={snapshot}
          model={state.model}
          onChange={state.setModel}
          placeholder={t("provider.managed.selectModelPlaceholder")}
        />
      </fieldset>
      <Button
        size="sm"
        className="shrink-0"
        title={t("provider.managed.resume")}
        aria-label={t("provider.managed.resume")}
        disabled={state.busy || state.model === null}
        onClick={state.recover}
      >
        {t("provider.managed.resumeShort")}
      </Button>
    </div>
  )
}
