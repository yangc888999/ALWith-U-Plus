// The platform account owns `nickname` and `avatar`, but its profile endpoint is read-only,
// so "edit my profile" is a local override kept in the settings store. Every window hydrates
// from the same preferences, which is also what keeps the sidebar and the settings window
// showing the same person.
//
// Overrides belong to the account that wrote them: the uuid travels with them so logging in
// as somebody else never inherits the previous person's nickname or photo.
import { createStore } from "zustand/vanilla"

import { usePlatformAuth } from "@/features/auth/store"
import { savePreference } from "@/lib/preferences"

export type ProfileOverrides = {
  /** Account uuid the overrides belong to. */
  owner: string | null
  /** Replaces the account nickname when set. */
  nickname: string | null
  /** Square data URL that replaces the account avatar when set. */
  avatar: string | null
}

export const profileOverrides = createStore<ProfileOverrides>(() => ({ owner: null, nickname: null, avatar: null }))

export function hydrateProfileOverrides(overrides: ProfileOverrides): void {
  profileOverrides.setState(overrides)
}

function currentOwner(): string | null {
  return usePlatformAuth.getState().user?.user_uuid ?? null
}

// The value lands before its owner: if the second write fails the override stays attributed to
// the old account (invisible) instead of leaking onto the new one.
async function persist(change: { nickname?: string | null; avatar?: string | null }): Promise<void> {
  const owner = currentOwner()
  if ("nickname" in change) await savePreference("profileNickname", change.nickname ?? null)
  if ("avatar" in change) await savePreference("profileAvatar", change.avatar ?? null)
  await savePreference("profileOwner", owner)
  profileOverrides.setState({ ...change, owner })
}

export async function saveProfileNickname(nickname: string | null): Promise<void> {
  await persist({ nickname })
}

export async function saveProfileAvatar(avatar: string | null): Promise<void> {
  await persist({ avatar })
}
