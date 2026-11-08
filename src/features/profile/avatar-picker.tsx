import { CameraIcon } from "lucide-react"
import { type ReactElement, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"

import { AvatarImageError, readAvatarFile } from "./avatar-image"

type Props = {
  avatarUrl: string | undefined
  initials: string
  /** Whether "use the account avatar" has anything to fall back to. */
  hasCustomAvatar: boolean
  disabled?: boolean
  onAvatarChange: (avatar: string) => void
  onAvatarReset: () => void
}

/** The round avatar in settings: clicking it opens the file picker, like every other product. */
export function AvatarPicker({
  avatarUrl,
  initials,
  hasCustomAvatar,
  disabled = false,
  onAvatarChange,
  onAvatarReset
}: Props): ReactElement {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const blocked = disabled || busy

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return
    setBusy(true)
    try {
      onAvatarChange(await readAvatarFile(file))
    } catch (error: unknown) {
      const code = error instanceof AvatarImageError ? error.code : "unreadable"
      toast.error(t(`settings.profileAvatarErrors.${code}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-label={t("settings.profileAvatarChange")}
        disabled={blocked}
        onClick={() => input.current?.click()}
        className="group/avatar-picker relative size-16 shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50"
      >
        <Avatar className="size-16 after:border-0">
          {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
          <AvatarFallback className="bg-primary text-lg text-primary-foreground">{initials}</AvatarFallback>
        </Avatar>
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-foreground/55 text-background opacity-0 transition-opacity group-hover/avatar-picker:opacity-100 group-focus-visible/avatar-picker:opacity-100">
          <CameraIcon className="size-5" />
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        tabIndex={-1}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Reset first so picking the same file twice still fires a change event.
          event.target.value = ""
          void pick(file)
        }}
      />
      <div className="flex flex-col items-start gap-1">
        <Button
          size="sm"
          variant="outline"
          className="rounded-sm"
          disabled={blocked}
          onClick={() => input.current?.click()}
        >
          {t("settings.profileAvatarChange")}
        </Button>
        {hasCustomAvatar && (
          <button
            type="button"
            disabled={blocked}
            onClick={onAvatarReset}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
          >
            {t("settings.profileAvatarReset")}
          </button>
        )}
      </div>
    </div>
  )
}
