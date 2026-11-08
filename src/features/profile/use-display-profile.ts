import { useStore } from "zustand"

import { usePlatformAuth } from "@/features/auth/store"

import { profileOverrides } from "./profile-store"

export type DisplayProfile = {
  displayName: string
  /** What the account itself calls this person; the editor's placeholder. */
  accountName: string
  email: string
  /** Local avatar, else the account avatar; undefined means "draw the initials". */
  avatarUrl: string | undefined
  initials: string
  /** True when the avatar on screen is the local override rather than the account one. */
  hasCustomAvatar: boolean
}

/** "Leo Wang" → LW, "小明" → 小明, "leo" → LE. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0] ?? ""
  if (words.length > 1) {
    const [a, b] = [first, words[1]]
    return `${[...(a ?? "")][0] ?? ""}${[...(b ?? "")][0] ?? ""}`.toLocaleUpperCase()
  }
  return [...first].slice(0, 2).join("").toLocaleUpperCase()
}

/**
 * The nickname and avatar to render. A local edit wins over the account profile because the
 * platform profile API is read-only; the account remains the fallback so nothing regresses for
 * users who never open the editor.
 */
export function useDisplayProfile(): DisplayProfile | null {
  const user = usePlatformAuth((state) => state.user)
  const owner = useStore(profileOverrides, (state) => state.owner)
  const nickname = useStore(profileOverrides, (state) => state.nickname)
  const avatar = useStore(profileOverrides, (state) => state.avatar)
  if (!user) return null
  // A different login must not inherit the previous person's edits.
  const owns = owner !== null && owner === user.user_uuid
  const accountName = user.nickname || user.login_email
  const displayName = (owns ? nickname?.trim() : "") || accountName
  return {
    displayName,
    accountName,
    email: user.login_email,
    avatarUrl: (owns ? avatar : null) ?? user.avatar ?? undefined,
    initials: initialsOf(displayName),
    hasCustomAvatar: owns && avatar !== null
  }
}
