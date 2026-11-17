export interface EnterpriseStatus {
  enabled: boolean
  authorization_status: string
  email?: string
}
export interface EnterpriseRenewal {
  automatic_renewal: boolean
  requires_login: boolean
  error: string | null
}

export function parseEnterpriseRenewal(value: unknown): EnterpriseRenewal {
  if (
    typeof value !== "object" ||
    value === null ||
    !("automatic_renewal" in value) ||
    !("requires_login" in value) ||
    !("error" in value) ||
    typeof value.automatic_renewal !== "boolean" ||
    typeof value.requires_login !== "boolean" ||
    (value.error !== null && typeof value.error !== "string")
  )
    throw new Error("Invalid enterprise renewal response")
  return { automatic_renewal: value.automatic_renewal, requires_login: value.requires_login, error: value.error }
}

export function enterpriseLoginAvailable(status: EnterpriseStatus, renewal: EnterpriseRenewal): boolean {
  return (
    status.enabled &&
    status.authorization_status === "authorized" &&
    renewal.automatic_renewal &&
    !renewal.requires_login
  )
}

/** The native layer's own verdict, when it reports one. */
export function nativeAuthorizationStatus(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("authorization_status" in value)) return null
  const status = (value as { authorization_status?: unknown }).authorization_status
  return typeof status === "string" && status !== "" ? status : null
}

/**
 * "Is the enterprise channel signed in", in the order of freshness the account page relies on:
 *
 *   1. the native layer's `authorization_status` — it owns the gateway session and renews it every
 *      few minutes, so a successful gateway login is proof even while the account service's record
 *      still says the previous session expired;
 *   2. the account service answering "authorized";
 *   3. no server answer at all (off the company network is not a sign-out).
 *
 * Local automatic renewal gates all three: without it nothing can be vouched for. A revocation the
 * service announces arrives as a native event and re-runs this.
 */
export function enterpriseSignedIn(input: {
  nativeAuthorization: string | null
  renewal: EnterpriseRenewal
  status: EnterpriseStatus | null
}): boolean {
  if (!input.renewal.automatic_renewal || input.renewal.requires_login) return false
  if (input.nativeAuthorization === "authorized") return true
  if (input.status === null) return true
  return enterpriseLoginAvailable(input.status, input.renewal)
}
