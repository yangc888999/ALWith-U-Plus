// QA probe: the 4-state × saved-row matrix of `resolveModelConfig`, run independently of the
// implementation's own suite.
//
// The claim under test: **a non-authoritative surface never produces 已下架 and never says anything
// about a row's availability**, in any of the four catalog states, with or without a saved
// shortlist. This file states that as a loop over the matrix instead of one example per state, and
// keeps the tombstone verdict in a separate assertion so the two can never contaminate silently.
//
// It also pins two things the implementation's tests do not state:
//   * a malformed bridge payload (an object with no `models`) is "answered nothing", never
//     "everything withdrawn";
//   * whether the "every entry is `unknown`" invariant really holds for gateway rows.

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { beforeEach, expect, test } from "vitest"

import { resolveModelConfig, type ModelConfigSource } from "../model-config"
import { gatewayModelId, type CustomModel, type ProviderSnapshot } from "../providers"

const SOL = "gpt-6.1-sol"
const TERRA = "gpt-6.1-terra"

function saved(apiId: string, extra: Partial<CustomModel> = {}): CustomModel {
  return { api_id: apiId, label: "", enabled: true, ...extra } as CustomModel
}

function modelSelect(ids: string[]): acp.SessionConfigOption[] {
  return [
    {
      configId: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: ids[0] ?? "",
      options: [
        {
          groupId: "chatgpt",
          name: "ChatGPT",
          options: ids.map((id) => ({ value: id, name: id.toUpperCase() }))
        }
      ]
    } as unknown as acp.SessionConfigOption
  ]
}

function snapshot(): ProviderSnapshot {
  return {
    revision: 1,
    appliedRevision: 1,
    status: "applied",
    error: null,
    providers: {},
    builtInModels: {},
    customProviders: [
      { id: "custom_vendor", name: "Vendor", models: [saved("vendor-large", { label: "Large" })] }
    ],
    managedProviders: []
  } as unknown as ProviderSnapshot
}

/** Every state a surface can be in, with the exact inputs that produce it. */
const STATES: Array<{ name: string; authoritative: boolean; config: Partial<ModelConfigSource> }> = [
  {
    name: "ready/session (authoritative)",
    authoritative: true,
    config: { sessionOptions: modelSelect([SOL, "gpt-6-astra"]) }
  },
  {
    name: "ready/published-session",
    authoritative: true,
    config: { native: { sourceKind: "session", name: "ChatGPT", models: [{ id: SOL, label: "Sol" }] } }
  },
  {
    name: "partial/bundled",
    authoritative: false,
    config: { native: { sourceKind: "bundled", name: "ChatGPT", models: [{ id: SOL, label: "Sol" }] } }
  },
  { name: "pending", authoritative: false, config: { native: undefined } },
  { name: "unavailable/null", authoritative: false, config: { native: null } },
  { name: "unavailable/empty", authoritative: false, config: { native: { name: "ChatGPT", models: [] } } }
]

beforeEach(() => {
  localStorage.clear()
})

test("non-authoritative never withdraws and never judges, with or without a saved shortlist", () => {
  for (const state of STATES) {
    for (const savedRows of [[], [saved(SOL), saved(TERRA)]]) {
      const result = resolveModelConfig({
        providerSnapshot: null,
        savedOverrides: savedRows,
        tombstones: new Set<string>(),
        ...state.config
      })
      const label = `${state.name} / saved=${savedRows.length}`

      expect(result.authoritative, label).toBe(state.authoritative)
      if (state.authoritative) {
        // Absence from the catalog is now "unverified", not a 已下架 verdict.
        expect(result.unverifiedIds, label).toEqual(savedRows.length === 0 ? [] : [TERRA])
        expect(result.withdrawnIds, label).toEqual([])
      } else {
        expect(result.withdrawnIds, label).toEqual([])
        expect(result.retiredIds, label).toEqual([])
        // No row may carry the withdrawn verdict either — the status is the second way to say it.
        expect(result.entries.filter((entry) => entry.status === "withdrawn"), label).toEqual([])
        // …and every GPT row states nothing about availability.
        for (const entry of result.entries.filter((row) => row.groupId === "chatgpt")) {
          expect(entry.status, `${label} / ${entry.id}`).toBe("unknown")
        }
      }
    }
  }
})

test("a tombstone never becomes 已下架, in any state — and never hides a row", () => {
  for (const state of STATES) {
    const result = resolveModelConfig({
      providerSnapshot: null,
      savedOverrides: [saved(SOL), saved(TERRA)],
      tombstones: new Set<string>([TERRA]),
      ...state.config
    })
    const label = state.name

    // Being refused is not being unverified either: the two stay separate.
    if (state.authoritative) expect(result.unverifiedIds, label).toEqual([TERRA])
    else expect(result.unverifiedIds, label).toEqual([])
    // A tombstoned row that the catalog still lists is never 已下架 either.
    expect(result.withdrawnIds, label).not.toContain(`${SOL}`)
    // `retired` on the row itself stays truthful whenever the row is shown at all, so a surface
    // that needs the raw refusal is never blocked by the "verdicts are for authorities" rule.
    for (const entry of result.entries) {
      if (entry.id === TERRA) expect(entry.retired, label).toBe(true)
      if (entry.id === SOL) expect(entry.retired, label).toBe(false)
    }
  }
})

test("a tombstoned row the catalog still lists reads unsupported only when authoritative", () => {
  const authoritative = resolveModelConfig({
    providerSnapshot: null,
    sessionOptions: modelSelect([SOL]),
    savedOverrides: [saved(SOL)],
    tombstones: new Set<string>([SOL])
  })
  expect(authoritative.byId(SOL)?.status).toBe("unsupported")
  expect(authoritative.retiredIds).toEqual([SOL])

  const pending = resolveModelConfig({
    providerSnapshot: null,
    native: undefined,
    savedOverrides: [saved(SOL)],
    tombstones: new Set<string>([SOL])
  })
  // Nothing is claimed, not even the refusal — but the flag survives for the callers that ask.
  expect(pending.byId(SOL)?.status).toBe("unknown")
  expect(pending.byId(SOL)?.retired).toBe(true)
  expect(pending.retiredIds).toEqual([])
})

test("a payload that crossed the bridge without a models array is 'answered nothing'", () => {
  // The settings bridge serialises this object; a shape the type forbids is still possible on the
  // wire. Reading it as "everything was withdrawn" is the bug this module exists to prevent.
  const result = resolveModelConfig({
    providerSnapshot: null,
    native: { name: "ChatGPT" } as unknown as { name: string; models: [] },
    savedOverrides: [saved(SOL), saved(TERRA)],
    tombstones: new Set<string>()
  })
  expect(result.status).toBe("unavailable")
  expect(result.authoritative).toBe(false)
  expect(result.withdrawnIds).toEqual([])
  // An unavailable catalog shows nothing rather than replaying the shortlist.
  expect(result.entries).toEqual([])
})

test("an unpublished catalog and an empty one are different answers", () => {
  const pending = resolveModelConfig({ providerSnapshot: null, native: undefined, savedOverrides: [], tombstones: new Set() })
  const empty = resolveModelConfig({ providerSnapshot: null, native: null, savedOverrides: [], tombstones: new Set() })
  expect(pending.status).toBe("pending")
  expect(empty.status).toBe("unavailable")
  expect(pending.authoritative).toBe(false)
  expect(empty.authoritative).toBe(false)
})

test("gateway rows are this app's own list: they stay available and are never withdrawn", () => {
  // CHARACTERIZATION, reported to the implementer as a deviation from the "every entry is unknown
  // when not authoritative" wording: rows that come from the provider snapshot keep status
  // `available` and sourceKind `session` even when the GPT catalog is only a bundled fallback.
  const result = resolveModelConfig({
    providerSnapshot: snapshot(),
    native: { sourceKind: "bundled", name: "ChatGPT", models: [{ id: SOL, label: "Sol" }] },
    savedOverrides: [saved(SOL)],
    tombstones: new Set<string>()
  })
  const gateway = result.byId(gatewayModelId("custom_vendor", "vendor-large"))
  expect(gateway).not.toBeNull()
  expect(gateway?.status).toBe("available")
  expect(gateway?.sourceKind).toBe("session")
  // The GPT row in the same answer is still undecided, which is the part that matters.
  expect(result.byId(SOL)?.status).toBe("unknown")
  expect(result.withdrawnIds).toEqual([])
})
