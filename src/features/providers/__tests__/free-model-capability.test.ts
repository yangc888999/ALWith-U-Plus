import { expect, test } from "vitest"

import { capabilityScore, freeModelProfiles, isMultimodal, modelFacts } from "../free-model-capability"

/** A catalog row shaped like OpenRouter's `/api/v1/models` entry. */
function row(overrides: Record<string, unknown> = {}): { id: string; [key: string]: unknown } {
  return { id: "vendor/model:free", ...overrides }
}

test("facts come only from published fields and are never filled in with defaults", () => {
  const empty = modelFacts(row())
  expect(empty.contextLength).toBeNull()
  expect(empty.inputModalities).toEqual([])
  expect(empty.tools).toBe(false)
  expect(empty.reasoning).toBe(false)
  // Nothing published means nothing scored — not a silently "average" model.
  expect(capabilityScore(empty)).toBe(0)

  const full = modelFacts(
    row({
      context_length: 1_000_000,
      architecture: { input_modalities: ["text", "image"] },
      supported_parameters: ["tools", "reasoning"]
    })
  )
  expect(full.contextLength).toBe(1_000_000)
  expect(full.tools).toBe(true)
  expect(full.reasoning).toBe(true)
  expect(capabilityScore(full)).toBe(100)
})

test("the context component is logarithmic and clamped at both ends", () => {
  const at = (contextLength: number): number => capabilityScore(modelFacts(row({ context_length: contextLength })))
  expect(at(8_000)).toBe(0)
  expect(at(1_000_000)).toBe(40)
  // Below the floor and above the ceiling both clamp instead of going negative or past the weight.
  expect(at(1_000)).toBe(0)
  expect(at(4_000_000)).toBe(40)
  // A 200k window is worth about two thirds of the range: log(25)/log(125) * 40 ≈ 27.
  const mid = at(200_000)
  expect(mid).toBe(27)
})

test("multimodality is any non-text input modality, and it is worth exactly 20", () => {
  const base = modelFacts(row({ context_length: 8_000 }))
  expect(isMultimodal(base)).toBe(false)
  for (const modality of ["image", "audio", "video", "file"]) {
    const facts = modelFacts(row({ architecture: { input_modalities: ["text", modality] } }))
    expect(isMultimodal(facts), modality).toBe(true)
    expect(capabilityScore(facts) - capabilityScore(base), modality).toBe(20)
  }
  // Text-only is not multimodal just because the field exists.
  expect(isMultimodal(modelFacts(row({ architecture: { input_modalities: ["text"] } })))).toBe(false)
})

test("recommended marks the top three by score, with a stable tie-break", () => {
  const rows = [
    row({ id: "a:free", context_length: 8_000 }),
    row({ id: "b:free", context_length: 1_000_000, supported_parameters: ["reasoning"] }),
    row({ id: "c:free", context_length: 200_000, architecture: { input_modalities: ["image"] } }),
    row({ id: "d:free", context_length: 8_000, supported_parameters: ["tools"] }),
    // Same score as `e`, different id: the tie is broken by id so the badge never jumps on refresh.
    row({ id: "e:free", context_length: 8_000, supported_parameters: ["tools"] })
  ]
  const profiles = freeModelProfiles(rows)
  expect(profiles.get("b:free")?.recommended).toBe(true)
  expect(profiles.get("c:free")?.recommended).toBe(true)
  // 45 (8k + tools) beats 40 (8k alone); `d` wins the third slot over `e` on the id tie-break.
  expect(profiles.get("d:free")?.recommended).toBe(true)
  expect(profiles.get("e:free")?.recommended).toBe(false)
  expect(profiles.get("a:free")?.recommended).toBe(false)
})

test("a model with no published metadata never wins a recommendation slot", () => {
  const profiles = freeModelProfiles([row({ id: "unknown:free" }), row({ id: "known:free", context_length: 128_000 })])
  expect(profiles.get("known:free")?.recommended).toBe(true)
  expect(profiles.get("unknown:free")?.recommended).toBe(false)
})
