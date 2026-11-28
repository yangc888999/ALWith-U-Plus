import { Building2 } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useEnterpriseLogin } from "@/features/auth/use-enterprise-login"
import { companyModelLabel, setCompanyModelDisplayName, useCompanyModelDisplayName } from "@/lib/company-display-name"
import type { CustomProvider } from "@/lib/providers"
import { openSettingsWindow } from "@/lib/window-manager"

import { CompanyReasoningRow } from "./company-reasoning-row"

/** The tab id the company provider uses while no account has issued one yet. */
export const COMPANY_PROVIDER_TAB = "__company__"

/**
 * The company channel as a first-class provider card.
 *
 * It is not a custom provider the user fills in: the account issues the gateway, the key and the
 * model list, so the card shows state instead of inputs. Sign-in is read from the enterprise
 * renewal, NOT from the provider list: the cached provider survives offline and outlives an
 * expired token, so "a provider exists" used to keep showing 已登录 after the login had dropped.
 * The only editable part is the default thinking level, a property of the models below it.
 */
export function CompanyProviderCard({ provider }: { provider: CustomProvider | null }) {
  const { t } = useTranslation()
  const login = useEnterpriseLogin()
  const displayName = useCompanyModelDisplayName()
  /** null until the user types, so 保存 can drop back to the stored value after a save. */
  const [draft, setDraft] = useState<string | null>(null)
  const name = companyModelLabel(provider?.name?.trim() || t("provider.companyName"))
  const models = provider?.models ?? []
  // The name is a form field with a button, not a live-typing broadcast: every keystroke used to
  // rewrite the channel name in the sidebar, the picker and the model table at once. A save makes
  // the change one deliberate act, which is also how the other cards behave (see 保存配置).
  const pendingName = draft ?? displayName
  const nameDirty = pendingName.trim() !== displayName
  const saveName = (): void => {
    if (!nameDirty) return
    setCompanyModelDisplayName(pendingName)
    setDraft(null)
    toast.success(t("provider.companyDisplayNameSaved"))
  }

  // The native layer owns the gateway session and is the only judge (see `enterpriseSignedIn`).
  // The account service used to be consulted as a second opinion, and its stale record — it does
  // not learn about a gateway login — is what kept saying 未登录 while the models worked.
  const signedIn = login.authorized
  const needsLogin = !login.checking && !signedIn
  const expired = login.renewal !== null && (login.renewal.requires_login || login.renewal.error !== null)

  const state = login.checking
    ? t("provider.companyChecking")
    : signedIn
      ? login.email === null
        ? t("provider.companySignedIn")
        : t("provider.companySignedInAs", { email: login.email })
      : expired
        ? t("provider.companyExpired")
        : login.error
          ? t("provider.companyUnknown")
          : t("provider.companySignedOut")
  const dot = login.checking
    ? "bg-muted-foreground/30 animate-pulse"
    : signedIn
      ? "bg-emerald-500"
      : "bg-muted-foreground/30"

  return (
    <div className="space-y-4 rounded-xl border p-5" data-testid="company-provider-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Building2 className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{name}</span>
          </p>
          <p className="text-xs text-muted-foreground" data-testid="company-provider-state">
            {state}
          </p>
        </div>
        <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${dot}`} />
      </div>

      {needsLogin ? (
        <>
          <p className="text-xs leading-5 text-muted-foreground">
            {expired ? t("provider.companyExpiredHint") : t("provider.companySignedOutHint")}
          </p>
          <Button variant="outline" onClick={() => void openSettingsWindow("account")}>
            {t(expired ? "provider.companyRelogin" : "provider.companyLogin")}
          </Button>
        </>
      ) : (
        <>
          <p className="text-xs leading-5 text-muted-foreground">
            {login.error ? t("provider.companyUnknownHint") : t("provider.companyHint")}
          </p>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("provider.companyModels")}</p>
            <ul className="space-y-1" data-testid="company-provider-models">
              {models.map((model) => (
                <li
                  key={model.api_id}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg bg-muted/40 px-2.5 py-1.5"
                >
                  <span className="text-[13px]">{model.label}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{model.api_id}</span>
                  {typeof model.contextWindow === "number" && model.contextWindow > 0 && (
                    <span className="text-[11px] text-muted-foreground">
                      {t("provider.companyWindow", { tokens: Math.round(model.contextWindow / 1000) })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="company-model-display-name">
              {t("provider.companyDisplayName")}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="company-model-display-name"
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={pendingName}
                placeholder={t("provider.companyName")}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveName()
                }}
              />
              <Button className="rounded-sm" disabled={!nameDirty} onClick={saveName}>
                {t("provider.companyDisplayNameSave")}
              </Button>
            </div>
          </div>
          <CompanyReasoningRow />
        </>
      )}
    </div>
  )
}
