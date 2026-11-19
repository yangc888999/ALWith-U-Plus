/**
 * One entry, three pickers: which one a surface gets is decided here and nowhere else.
 *
 * The two surfaces used to carry their own ternaries (and the composer a third fallback), which is
 * how the same screen ended up rendering two model controls (2026-11-17). The pure functions below
 * are the whole decision, so they are tested exhaustively; the component tests only prove the
 * mapping reaches the right leaf.
 */
import { createSession } from "@alwith/api"
import { render } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

import { ModelEntry, modelEntryKind, modelGateOf } from "../model-entry"

vi.mock("../draft-model-select", () => ({
  DraftModelSelect: () => <div data-testid="draft-picker" />
}))
vi.mock("../recovery-model-select", () => ({
  RecoveryModelSelect: () => <div data-testid="recovery-picker" />
}))
// The package menu needs a conversation host; this file tests the slot U renders around it.
vi.mock("@alwith/module-chat/conversation", () => ({
  ModelMenu: () => <div data-testid="model-menu" />
}))

await initI18n("en")

const modelOption = { type: "select" as const, configId: "model", name: "Model", category: "model" }
const effortOption = { type: "select" as const, configId: "reasoning_effort", name: "Effort", category: "thought_level" }

function sessionWith(configOptions: readonly unknown[], extra: Record<string, unknown> = {}) {
  return { ...createSession("chat", "/tmp/model-entry"), configOptions: configOptions as never, ...extra }
}

test("a draft gets the menu once its session exists, the picker only after a failed preparation", () => {
  const session = sessionWith([modelOption])
  expect(modelEntryKind(session, "draft")).toBe("menu")
  // No session and nothing failed yet: the slot stays empty. Offering a picker mid-preparation made
  // the control blink in and out of every new chat as it opened.
  expect(modelEntryKind(null, "draft", { failure: null, preparing: true })).toBe("none")
  expect(modelEntryKind(null, "draft", { failure: null, preparing: false })).toBe("none")
  expect(modelEntryKind(null, "draft", { failure: new Error("boom"), preparing: false })).toBe("draft")
  // Picking a model clears the card and re-enters preparation: the control must not vanish first.
  expect(modelEntryKind(null, "draft", { failure: new Error("boom"), preparing: true })).toBe("none")
})

test("a conversation gets the menu while its options load, and the recovery picker when the model option is gone", () => {
  expect(modelEntryKind(sessionWith([effortOption, modelOption]), "session")).toBe("menu")
  // Empty options are how every chat starts; the replay fills them in.
  expect(modelEntryKind(sessionWith([], { restoring: true }), "session")).toBe("menu")
  // …but a replay that already settled with no options is the revoked-model case, not a loading one.
  expect(modelEntryKind(sessionWith([], { restoring: false }), "session")).toBe("recovery")
  expect(modelEntryKind(sessionWith([effortOption]), "session")).toBe("recovery")
  expect(modelEntryKind(null, "session")).toBe("none")
})

test("the gate names one reason, and only ready enables the control", () => {
  const ready = sessionWith([modelOption], { attached: true })
  expect(modelGateOf(ready)).toBe("ready")
  expect(modelGateOf(ready, { preparing: true })).toBe("preparing")
  expect(modelGateOf(ready, { failure: new Error("boom") })).toBe("failed")
  expect(modelGateOf(ready, { connected: false })).toBe("offline")
  expect(modelGateOf(null)).toBe("detached")
  expect(modelGateOf(sessionWith([modelOption], { attached: false }))).toBe("detached")
  expect(modelGateOf(sessionWith([modelOption], { attached: true, restoring: true }))).toBe("restoring")
  expect(modelGateOf(sessionWith([modelOption], { attached: true, readOnly: true }))).toBe("read-only")
})

test("a failed draft preparation renders the draft picker", () => {
  const view = render(
    <ModelEntry
      surface="draft"
      session={null}
      snapshot={null}
      model={null}
      preparing={false}
      failure={new Error("acpRequest: boom")}
      connected={false}
      onChange={() => {}}
    />
  )
  try {
    expect(view.getByTestId("draft-picker")).toBeInTheDocument()
    expect(view.queryByTestId("recovery-picker")).not.toBeInTheDocument()
  } finally {
    view.unmount()
  }
})

test("a conversation without a model option renders the recovery picker", () => {
  const view = render(<ModelEntry surface="session" session={sessionWith([effortOption])} />)
  try {
    expect(view.getByTestId("recovery-picker")).toBeInTheDocument()
  } finally {
    view.unmount()
  }
})

// The trigger ellipsises in a narrow composer (index.css), so the full name must stay readable on
// hover. The slot carries it as a native title; `display: contents` keeps the toolbar layout intact.
test("the session menu slot carries the full model name as a hover title", () => {
  const option = {
    ...modelOption,
    currentValue: "gpt-6.2-sol",
    options: [{ value: "gpt-6.2-sol", name: "GPT 6.2 Sol (Long Catalogue Name)" }]
  }
  const view = render(<ModelEntry surface="session" session={sessionWith([option], { attached: true })} />)
  try {
    const slot = view.container.querySelector("div.contents")
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute("title")).toBe("GPT 6.2 Sol (Long Catalogue Name)")
  } finally {
    view.unmount()
  }
})
