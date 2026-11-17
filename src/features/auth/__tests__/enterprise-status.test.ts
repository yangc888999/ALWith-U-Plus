import { expect, test } from "vitest"

import { enterpriseSignedIn, nativeEnterpriseStatus, parseEnterpriseRenewal } from "../enterprise-status"

const renewal = { automatic_renewal: true, requires_login: false, error: null }

test("the native authorization is the sign-in signal, gated by the local renewal", () => {
  // The reported state on 2026-11-17: the gateway session was fresh while the account service still
  // carried `enterprise_session_expired`, so the card said 未登录 with working internal models.
  expect(
    enterpriseSignedIn({ native: nativeEnterpriseStatus({ authorization_status: "authorized" }), renewal })
  ).toBe(true)
  expect(
    enterpriseSignedIn({ native: nativeEnterpriseStatus({ authorization_status: "unauthorized" }), renewal })
  ).toBe(false)
  // A native answer cannot outlive the renewal it depends on.
  expect(
    enterpriseSignedIn({
      native: nativeEnterpriseStatus({ authorization_status: "authorized" }),
      renewal: { automatic_renewal: false, requires_login: false, error: null }
    })
  ).toBe(false)
  expect(
    enterpriseSignedIn({
      native: nativeEnterpriseStatus({ authorization_status: "authorized" }),
      renewal: { automatic_renewal: true, requires_login: true, error: "invalid_grant" }
    })
  ).toBe(false)
  // The channel being switched off for this account still wins.
  expect(
    enterpriseSignedIn({
      native: nativeEnterpriseStatus({ enabled: false, authorization_status: "authorized" }),
      renewal
    })
  ).toBe(false)
})

test("a native status that omits fields never reads as authorized", () => {
  for (const value of [{}, null, "authorized", { authorization_status: "" }, { authorization_status: 42 }]) {
    expect(enterpriseSignedIn({ native: nativeEnterpriseStatus(value), renewal })).toBe(false)
  }
})

test("native fields that are absent read as null instead of a guess", () => {
  expect(nativeEnterpriseStatus({})).toEqual({ enabled: null, authorization_status: null, email: null })
  expect(nativeEnterpriseStatus({ enabled: false, email: "user@example.com" })).toEqual({
    enabled: false,
    authorization_status: null,
    email: "user@example.com"
  })
  expect(nativeEnterpriseStatus({ enabled: "no", email: "  " })).toEqual({
    enabled: null,
    authorization_status: null,
    email: null
  })
})

test("invalid native status is reported instead of looking like a signed-out account", () => {
  expect(() => parseEnterpriseRenewal({})).toThrow()
  expect(parseEnterpriseRenewal({ automatic_renewal: false, requires_login: false, error: null })).toEqual({
    automatic_renewal: false,
    requires_login: false,
    error: null
  })
})
