/**
 * Match the account policy used by the desktop host, without developer overrides.
 *
 * A synced drive (`configured`) counts as proof of access even when the login email does not carry
 * the company domain — phone-login accounts still sync, and hiding the panel then would hide a
 * running sync from its owner.
 */
export function isDriveVisible(
  authenticated: boolean,
  email: string | null | undefined,
  configured = false
): boolean {
  return authenticated && ((email?.toLowerCase().endsWith("@finture.id") ?? false) || configured)
}
