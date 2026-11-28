import type { Session } from "@alwith/api"
import { expect, test } from "vitest"

import { countSessionRounds } from "../turn-count"

function item(
  kind: "user" | "assistant",
  id: string,
  turnId: string | null,
  at = 1,
  liveEcho: "pending" | "acknowledged" | "adopted" | null = null,
  replayed = false
): Session["items"][number] {
  return {
    kind,
    id,
    at,
    replayed,
    _meta: turnId === null ? null : { codex: { turnId } },
    ...(kind === "user"
      ? { content: [], echo: liveEcho }
      : { content: [{ type: "text", text: "answer" }], echo: null })
  } as Session["items"][number]
}

function session(items: Session["items"]): Session {
  return { items } as Session
}

test("steering inside one native turn still counts as one round", () => {
  const rounds = countSessionRounds(
    session([
      item("user", "u1", "turn-1"),
      item("assistant", "a1", "turn-1"),
      item("user", "steer-1", "turn-1"),
      item("assistant", "a2", "turn-1"),
      item("user", "steer-2", "turn-1"),
      item("user", "u2", "turn-2")
    ])
  )
  expect(rounds).toBe(2)
})

test("live steers without an echo stay inside the current round", () => {
  expect(
    countSessionRounds(
      session([
        item("user", "prompt", null, 1, "acknowledged"),
        item("assistant", "answer", null),
        item("user", "steer", null),
        item("assistant", "continued", null)
      ])
    )
  ).toBe(1)
})

test("replayed user messages without a native turn id count one by one", () => {
  expect(
    countSessionRounds(
      session([
        item("user", "u1", null, 1, null, true),
        item("assistant", "a1", null, 1, null, true),
        item("user", "u2", null, 1, null, true)
      ])
    )
  ).toBe(2)
})

test("assistant-only native turns do not add rounds", () => {
  expect(countSessionRounds(session([item("assistant", "a1", "turn-1"), item("user", "u1", "turn-2")]))).toBe(1)
})
