import { describe, expect, test } from "vitest"

import {
  canonicalModelSelection,
  isGatewayModelIdentity,
  modelDisplayId,
  modelSelectionId,
  modelVendorId,
  parseModelIdentity,
  sameModelIdentity
} from "../model-identity"

describe("model identity", () => {
  test("parses the picker spelling and keeps a round-trippable session value", () => {
    const identity = parseModelIdentity("gateway:deepseek:deepseek-V4.1-flash")
    expect(identity).toEqual({
      kind: "gateway",
      selectionId: "gateway:deepseek:deepseek-V4.1-flash",
      routeId: "deepseek/deepseek-V4.1-flash",
      gatewayId: "deepseek",
      modelId: "deepseek-V4.1-flash"
    })
  })

  test("parses the routed spelling Codex hands the Router", () => {
    const identity = parseModelIdentity("custom-637573746f6d/deepseek/V4.1-flash")
    expect(identity.kind).toBe("gateway")
    expect(identity.gatewayId).toBe("custom-637573746f6d")
    expect(identity.modelId).toBe("deepseek/V4.1-flash")
    expect(identity.selectionId).toBe(
      "gateway:custom-637573746f6d:deepseek%2FV4.1-flash"
    )
  })

  test("keeps native ids bare", () => {
    const identity = parseModelIdentity("gpt-6.2-sol")
    expect(identity).toEqual({
      kind: "native",
      selectionId: "gpt-6.2-sol",
      routeId: "gpt-6.2-sol",
      gatewayId: null,
      modelId: "gpt-6.2-sol"
    })
  })

  test("decodes provider and model components only once", () => {
    const selection = modelSelectionId("custom-abc", "model%2Fone")
    expect(selection).toBe("gateway:custom-abc:model%252Fone")
    expect(parseModelIdentity(selection).modelId).toBe("model%2Fone")
  })

  test("rejects malformed gateway spellings instead of misclassifying them as native", () => {
    expect(parseModelIdentity("gateway:deepseek").kind).toBe("invalid")
    expect(parseModelIdentity("gateway::model").kind).toBe("invalid")
    expect(parseModelIdentity("gateway:deepseek:").kind).toBe("invalid")
  })

  test("exposes one comparison and display surface for every spelling", () => {
    const selection = "gateway:deepseek:deepseek-flash"
    const routed = "deepseek/deepseek-flash"
    expect(sameModelIdentity(selection, routed)).toBe(true)
    expect(modelVendorId(selection)).toBe("deepseek")
    expect(modelVendorId("gpt-6.2-sol")).toBe("native")
    expect(modelDisplayId(routed)).toBe("deepseek-flash")
    expect(isGatewayModelIdentity(routed)).toBe(true)
    expect(canonicalModelSelection(routed)).toBe(selection)
  })
})
