import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { describeError } from "@/lib/error-text"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PlatformLogin } from "@/features/auth/auth-gate"
import { logoutPlatform, usePlatformAuth } from "@/features/auth/store"
import { AvatarPicker } from "@/features/profile/avatar-picker"
import { saveProfileAvatar, saveProfileNickname } from "@/features/profile/profile-store"
import { useDisplayProfile } from "@/features/profile/use-display-profile"

import { EnterpriseSection } from "./enterprise-section"
import { SettingRow, SettingsCard } from "./shared"

export function AccountSection() {
  const { t } = useTranslation()
  const profile = useDisplayProfile()
  const [busy, setBusy] = useState(false)
  /** null until the user types, so a save can drop back to the stored value. */
  const [draft, setDraft] = useState<string | null>(null)
  const [savingName, setSavingName] = useState(false)
  const authenticated = usePlatformAuth((state) => state.isAuthenticated)
  // Signed out, this page used to render nothing — and it is the only place to sign in. Host the
  // form here instead of gating the whole settings window behind it (2026-11-08).
  if (!authenticated) {
    return (
      <SettingsCard title={t("settings.account")} desc={t("platformAuth.intro")}>
        <PlatformLogin
          embedded
          onPassphrase={() => toast.success(t("platformAuth.passphraseAccepted"))}
        />
      </SettingsCard>
    )
  }
  if (!profile) return null

  const nickname = draft ?? profile.displayName
  const trimmed = nickname.trim()
  // Empty means "use the account nickname", so it is a saveable value too.
  const canSaveName = trimmed !== profile.displayName

  async function saveName(): Promise<void> {
    if (!canSaveName) return
    setSavingName(true)
    try {
      await saveProfileNickname(trimmed === "" ? null : trimmed)
      setDraft(null)
      toast.success(t("settings.profileNameSaved"))
    } catch (error: unknown) {
      toast.error(describeError(error))
    } finally {
      setSavingName(false)
    }
  }

  function saveAvatar(value: string | null): void {
    void saveProfileAvatar(value)
      .then(() => toast.success(t(value === null ? "settings.profileAvatarResetDone" : "settings.profileAvatarUpdated")))
      .catch((error: unknown) => toast.error(describeError(error)))
  }

  return (
    <>
      {/* Sign-in state comes first: it is the page's premise (which account these details belong
          to), and the sign-out button used to sit below the profile block it signs out of. */}
      <SettingsCard title={t("settings.cardSession")} desc={t("settings.cardSessionDesc")}>
        <SettingRow title={t("settings.accountSession")} desc={t("platformAuth.accountHint")}>
          <Button
            className="rounded-sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void logoutPlatform()
                .catch(() => toast.error(t("platformAuth.failed")))
                .finally(() => setBusy(false))
            }}
          >
            {t("platformAuth.signOut")}
          </Button>
        </SettingRow>
      </SettingsCard>
      <SettingsCard title={t("settings.cardProfile")} desc={t("settings.cardProfileDesc")}>
        <SettingRow title={t("settings.profileTitle")} desc={t("settings.profileTitleDesc")}>
          <AvatarPicker
            avatarUrl={profile.avatarUrl}
            initials={profile.initials}
            hasCustomAvatar={profile.hasCustomAvatar}
            onAvatarChange={saveAvatar}
            onAvatarReset={() => saveAvatar(null)}
          />
        </SettingRow>
        <SettingRow title={t("settings.profileName")} desc={t("settings.profileNameDesc")} aligned>
          <div className="flex w-full items-center gap-2">
            <Input
              aria-label={t("settings.profileName")}
              className="min-w-0 flex-1"
              value={nickname}
              maxLength={32}
              placeholder={profile.accountName}
              disabled={savingName}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveName()
              }}
            />
            <Button className="rounded-sm" disabled={!canSaveName || savingName} onClick={() => void saveName()}>
              {t("settings.profileSave")}
            </Button>
          </div>
        </SettingRow>
        <SettingRow title={t("settings.profileEmail")} desc={t("settings.profileEmailDesc")}>
          <span className="block max-w-[13rem] truncate text-sm text-muted-foreground" title={profile.email}>
            {profile.email}
          </span>
        </SettingRow>
      </SettingsCard>
      <EnterpriseSection />
    </>
  )
}
