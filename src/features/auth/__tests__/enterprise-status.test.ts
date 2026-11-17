import { expect, test } from "vitest"

import { enterpriseLoginAvailable, enterpriseSignedIn, parseEnterpriseRenewal } from "../enterprise-status"

test("server authorization requires local automatic renewal before models are usable", () => {
  const server = { enabled: true, authorization_status: "authorized" }
  expect(enterpriseLoginAvailable(server, { automatic_renewal: true, requires_login: false, error: null })).toBe(true)
  expect(enterpriseLoginAvailable(server, { automatic_renewal: false, requires_login: false, error: null })).toBe(false)
  expect(
    enterpriseLoginAvailable(server, { automatic_renewal: true, requires_login: true, error: "invalid_grant" })
  ).toBe(false)
  expect(
    enterpriseLoginAvailable(
      { ...server, enabled: false },
      { automatic_renewal: true, requires_login: false, error: null }
    )
  ).toBe(false)
})

test("invalid native status is reported instead of looking like a signed-out account", () => {
  expect(() => parseEnterpriseRenewal({})).toThrow()
  expect(parseEnterpriseRenewal({ automatic_renewal: false, requires_login: false, error: null })).toEqual({
    automatic_renewal: false,
    requires_login: false,
    error: null
  })
})

test("a gateway login the native layer vouches for beats a stale 'expired' record in the account service", () => {
  const renewal = { automatic_renewal: true, requires_login: false, error: null }
  const stale = { enabled: true, authorization_status: "unauthorized" }
  // The reported state: the gateway session was refreshed seconds ago while the account service
  // still carried the old expired session, so the card said 未登录 with working internal models.
  expect(enterpriseSignedIn({ nativeAuthorization: "authorized", renewal, status: stale })).toBe(true)
  // Nothing vouches for it: the stale record stands.
  expect(enterpriseSignedIn({ nativeAuthorization: "unauthorized", renewal, status: stale })).toBe(false)
  // The native layer being silent is not a sign-in.
  expect(enterpriseSignedIn({ nativeAuthorization: null, renewal, status: stale })).toBe(false)
  // No server answer at all is offline, not signed out.
  expect(enterpriseSignedIn({ nativeAuthorization: null, renewal, status: null })).toBe(true)
  // A native verdict cannot outlive the renewal it depends on.
  expect(
    enterpriseSignedIn({
      nativeAuthorization: "authorized",
      renewal: { automatic_renewal: false, requires_login: false, error: null },
      status: stale
    })
  ).toBe(false)
  expect(
    enterpriseSignedIn({
      nativeAuthorization: "authorized",
      renewal: { automatic_renewal: true, requires_login: true, error: "invalid_grant" },
      status: stale
    })
  ).toBe(false)
})
