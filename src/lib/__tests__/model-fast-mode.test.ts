import { beforeEach, describe, expect, test } from "vitest"

import {
  modelFastModeChoiceFor,
  modelFastModeFor,
  modelFastModeSnapshot,
  setModelFastMode
} from "../model-fast-mode"

/**
 * Acceleration has three states and the sender must be able to tell them apart: an explicit "off"
 * has to produce a different request than "never configured", otherwise turning acceleration off
 * silently does nothing because the field is merely omitted.
 */
beforeEach(() => {
  localStorage.clear()
  // The module caches its record; re-importing is not an option inside one test file, so reset
  // through the public API by writing an empty record.
  for (const model of Object.keys(modelFastModeSnapshot())) setModelFastMode(model, false)
  localStorage.clear()
})

describe("fast mode states", () => {
  test("never configured is not the same as explicitly off", () => {
    expect(modelFastModeChoiceFor("gpt-6.2-sol")).toBeNull()
    expect(modelFastModeFor("gpt-6.2-sol")).toBe(false)
  })

  test("an explicit off survives, so the sender can honour it", () => {
    setModelFastMode("gpt-6.2-sol", true)
    expect(modelFastModeChoiceFor("gpt-6.2-sol")).toBe(true)

    setModelFastMode("gpt-6.2-sol", false)
    // Still a decision, not an absence: `null` here would make the turn omit the field.
    expect(modelFastModeChoiceFor("gpt-6.2-sol")).toBe(false)
    expect(modelFastModeFor("gpt-6.2-sol")).toBe(false)
  })

  test("repeating the same value is a no-op", () => {
    setModelFastMode("gpt-6.2-sol", false)
    const first = modelFastModeSnapshot()
    setModelFastMode("gpt-6.2-sol", false)
    expect(modelFastModeSnapshot()).toBe(first)
  })

  test("models are independent", () => {
    setModelFastMode("gpt-6.2-sol", false)
    setModelFastMode("gpt-6.1-sol", true)
    expect(modelFastModeChoiceFor("gpt-6.2-sol")).toBe(false)
    expect(modelFastModeChoiceFor("gpt-6.1-sol")).toBe(true)
    expect(modelFastModeChoiceFor("gpt-6-sol")).toBeNull()
  })
})