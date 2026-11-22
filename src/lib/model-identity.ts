/**
 * The one model-identity contract shared by model selection, persisted session records and the
 * local Router.
 *
 * A model reaches different layers in three spellings:
 *
 *   * picker / session record: `gateway:<gatewayId>:<modelId>`
 *   * Codex -> Router:         `<gatewayId>/<modelId>`
 *   * native ChatGPT model:    `<modelId>`
 *
 * Gateway and model ids are URI components in the picker form, but raw in the routed form. Every
 * conversion goes through this module so a provider-qualified model can never silently become a
 * bare native id, which the Router would send to ChatGPT.
 */
export type ModelIdentity = {
  kind: "native" | "gateway" | "invalid"
  /** Canonical value used by model pickers and persisted session selection. */
  selectionId: string
  /** Canonical value Codex hands the local Router. Native ids stay bare. */
  routeId: string
  /** Decoded provider runtime id; null for native and invalid values. */
  gatewayId: string | null
  /** Decoded upstream model id; empty for invalid values. */
  modelId: string
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function invalid(raw: string): ModelIdentity {
  return { kind: "invalid", selectionId: raw, routeId: raw, gatewayId: null, modelId: "" }
}

/** Build the canonical picker/session value for a gateway model. */
export function modelSelectionId(gatewayId: string, modelId: string): string {
  return `gateway:${encodeURIComponent(gatewayId)}:${encodeURIComponent(modelId)}`
}

/** Parse any of the three supported spellings into one identity. */
export function parseModelIdentity(raw: string): ModelIdentity {
  const value = raw.trim()
  if (value === "") return invalid(value)

  if (value.startsWith("gateway:")) {
    const rest = value.slice("gateway:".length)
    const separator = rest.indexOf(":")
    if (separator <= 0 || separator === rest.length - 1) return invalid(value)
    const gatewayId = decode(rest.slice(0, separator))
    const modelId = decode(rest.slice(separator + 1))
    if (gatewayId === "" || modelId === "") return invalid(value)
    return {
      kind: "gateway",
      selectionId: modelSelectionId(gatewayId, modelId),
      routeId: `${gatewayId}/${modelId}`,
      gatewayId,
      modelId
    }
  }

  const separator = value.indexOf("/")
  if (separator > 0 && separator < value.length - 1) {
    const gatewayId = value.slice(0, separator)
    const modelId = value.slice(separator + 1)
    return {
      kind: "gateway",
      selectionId: modelSelectionId(gatewayId, modelId),
      routeId: `${gatewayId}/${modelId}`,
      gatewayId,
      modelId
    }
  }

  return { kind: "native", selectionId: value, routeId: value, gatewayId: null, modelId: value }
}

/** Canonical persisted value; malformed gateway strings stay untouched for diagnostics. */
export function canonicalModelSelection(raw: string): string {
  return parseModelIdentity(raw).selectionId
}

/** Vendor comparison key: the runtime gateway id, or `native`. */
export function modelVendorId(raw: string): string {
  return parseModelIdentity(raw).gatewayId ?? "native"
}

/** Model name without its routing prefix, for display and matching error text. */
export function modelDisplayId(raw: string): string {
  return parseModelIdentity(raw).modelId || raw.trim()
}

export function isGatewayModelIdentity(raw: string): boolean {
  return parseModelIdentity(raw).kind === "gateway"
}

/** True when both spellings name the same provider and upstream model. */
export function sameModelIdentity(left: string, right: string): boolean {
  const a = parseModelIdentity(left)
  const b = parseModelIdentity(right)
  return a.kind === b.kind && a.selectionId === b.selectionId
}
