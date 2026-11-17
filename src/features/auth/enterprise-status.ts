/** The enterprise channel as the native layer reports it. A field it does not send reads as null,
 *  never as a guess: the native layer owns the gateway session, so its silence is not a verdict. */
export interface EnterpriseStatus {
  enabled: boolean | null
  authorization_status: string | null
  email: string | null
}
export interface EnterpriseRenewal {
  automatic_renewal: boolean
  requires_login: boolean
  error: string | null
}

/**
 * Read `enterprise_status` (the native answer) without ever inventing a field.
 *
 * Deliberately lenient, unlike `parseEnterpriseRenewal`: the renewal flags decide whether anything
 * can be vouched for at all, so a malformed renewal must surface as "unknown". The authorization
 * fields only refine the answer, and a native build that omits one must not turn a working channel
 * into an error card.
 */
export function nativeEnterpriseStatus(value: unknown): EnterpriseStatus {
  const field = (key: string): unknown =>
    typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined
  const text = (key: string): string | null => {
    const raw = field(key)
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null
  }
  const enabled = field("enabled")
  return {
    enabled: typeof enabled === "boolean" ? enabled : null,
    authorization_status: text("authorization_status"),
    email: text("email")
  }
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

/**
 * "Is the enterprise channel signed in", decided by the native layer alone.
 *
 * The native layer has owned the gateway session since 0.6.5: it is the component that renews the
 * token every few minutes, so its own `authorization_status` is the live answer. The account
 * service only keeps a *record* of the enterprise link, and a gateway login does not write that
 * record back — on 2026-11-17 the record still read `enterprise_session_expired` while the gateway
 * session was seconds old, which is how a signed-in account showed 未登录 with working internal
 * models. Asking the service for a second opinion therefore produced a stale veto: it is no longer
 * consulted.
 *
 * Local automatic renewal gates everything: a native "authorized" cannot outlive the renewal it
 * depends on. A revocation arrives as a native event and re-runs this.
 */
export function enterpriseSignedIn(input: { native: EnterpriseStatus; renewal: EnterpriseRenewal }): boolean {
  if (!input.renewal.automatic_renewal || input.renewal.requires_login) return false
  if (input.native.enabled === false) return false
  return input.native.authorization_status === "authorized"
}
