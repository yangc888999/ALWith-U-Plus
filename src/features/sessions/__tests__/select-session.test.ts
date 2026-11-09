import type { ComposerDraft } from "@alwith/module-chat/conversation"
import { expect, test, vi } from "vitest"

import type { ChatTransfer } from "@/lib/chat-window"

import { selectSession, type SelectSessionActions } from "../select-session"

const sessionRow = {
  sessionId: "history-1",
  cwd: "/tmp/project",
  title: "History",
  updatedAt: null,
  archived: false
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

type Options = {
  selected: string[]
  errors: unknown[]
  connect?: () => Promise<void>
  unarchive?: () => Promise<void>
  release?: () => Promise<ChatTransfer | null>
  include?: () => void
  open?: () => Promise<void>
  onSettled?: () => void
}

function actions(options: Options): SelectSessionActions {
  return {
    connect: options.connect ?? (async () => {}),
    unarchive: options.unarchive ?? (async () => {}),
    release: options.release ?? ((): Promise<ChatTransfer | null> => Promise.resolve(null)),
    importDraft: (_id: string, _draft: ComposerDraft | null) => {},
    include: options.include ?? (() => {}),
    open: options.open ?? (async () => {}),
    show: (id) => options.selected.push(id),
    onOpenError: (error) => options.errors.push(error),
    onSettled: options.onSettled
  }
}

test("switches immediately even while preparation is stalled", async () => {
  const connect = deferred()
  const selected: string[] = []
  const opened: string[] = []

  selectSession(
    sessionRow,
    actions({
      selected,
      errors: [],
      connect: () => connect.promise,
      open: async () => {
        opened.push(sessionRow.sessionId)
      }
    })
  )

  // The view changes in the same tick as the click; no engine, Drive or window request may gate it.
  expect(selected).toEqual(["history-1"])
  expect(opened).toEqual([])
  connect.resolve()
  await vi.waitFor(() => expect(opened).toEqual(["history-1"]))
})

test("selects a chat while its history is still restoring", async () => {
  const restoration = deferred()
  const selected: string[] = []
  const errors: unknown[] = []

  selectSession(sessionRow, actions({ selected, errors, open: () => restoration.promise }))

  expect(selected).toEqual(["history-1"])
  expect(errors).toEqual([])
  restoration.resolve()
  await restoration.promise
})

test("restores an archived chat before including and opening it", async () => {
  const order: string[] = []
  const selected: string[] = []

  selectSession(
    { ...sessionRow, archived: true },
    actions({
      selected,
      errors: [],
      unarchive: async () => {
        order.push("unarchive")
      },
      include: () => order.push("include"),
      open: async () => {
        order.push("open")
      }
    })
  )

  expect(selected).toEqual([sessionRow.sessionId])
  await vi.waitFor(() => expect(order).toEqual(["unarchive", "include", "open"]))
})

test("reports a background restore failure without undoing the switch", async () => {
  const selected: string[] = []
  const errors: unknown[] = []
  const failure = new Error("resume failed")

  selectSession(sessionRow, actions({ selected, errors, open: () => Promise.reject(failure) }))

  expect(selected).toEqual(["history-1"])
  await vi.waitFor(() => expect(errors).toEqual([failure]))
  expect(selected).toEqual(["history-1"])
})

test("a failed connect reports itself but never looks like a dead click", async () => {
  const selected: string[] = []
  const errors: unknown[] = []
  const opened: string[] = []
  const failure = new Error("Drive request timed out: connect after 45000ms")

  selectSession(
    sessionRow,
    actions({
      selected,
      errors,
      connect: () => Promise.reject(failure),
      open: async () => {
        opened.push(sessionRow.sessionId)
      }
    })
  )

  expect(selected).toEqual(["history-1"])
  await vi.waitFor(() => expect(errors).toEqual([failure]))
  expect(opened).toEqual([])
})

test("only the last of several rapid clicks finishes preparation", async () => {
  let generation = 0
  const shown: string[] = []
  const included: string[] = []
  const opened: string[] = []
  const settled: string[] = []
  const errors: unknown[] = []
  const gates: Array<ReturnType<typeof deferred>> = []

  const pick = (id: string): void => {
    const mine = ++generation
    const gate = deferred()
    gates.push(gate)
    selectSession(
      { ...sessionRow, sessionId: id },
      actions({
        selected: shown,
        errors,
        connect: () => gate.promise,
        include: () => included.push(id),
        open: async () => {
          opened.push(id)
        },
        onSettled: () => settled.push(id)
      }),
      () => mine === generation
    )
  }

  pick("a")
  pick("b")
  pick("c")
  // Every click still switches the view immediately.
  expect(shown).toEqual(["a", "b", "c"])
  for (const gate of gates) gate.resolve()

  await vi.waitFor(() => expect(opened).toEqual(["c"]))
  expect(included).toEqual(["c"])
  expect(settled).toEqual(["c"])
  expect(errors).toEqual([])
})

test("a superseded chain never reports a failure for a conversation the reader left", async () => {
  const errors: unknown[] = []
  const settled: string[] = []
  const first = deferred()
  const second = deferred()
  let firstIsCurrent = true

  selectSession(
    sessionRow,
    actions({
      selected: [],
      errors,
      connect: () => first.promise,
      onSettled: () => settled.push("first")
    }),
    () => firstIsCurrent
  )
  // A second click wins; the first chain is now stale.
  firstIsCurrent = false
  selectSession(
    sessionRow,
    actions({ selected: [], errors, connect: () => second.promise, onSettled: () => settled.push("second") }),
    () => true
  )

  first.reject(new Error("stale connect failed"))
  second.resolve()
  await vi.waitFor(() => expect(settled).toEqual(["second"]))
  expect(errors).toEqual([])
})

test("clears the opening state even when preparation fails", async () => {
  const errors: unknown[] = []
  const settled: string[] = []
  const failure = new Error("connect failed")

  selectSession(
    sessionRow,
    actions({
      selected: [],
      errors,
      connect: () => Promise.reject(failure),
      onSettled: () => settled.push(sessionRow.sessionId)
    })
  )

  await vi.waitFor(() => expect(errors).toEqual([failure]))
  expect(settled).toEqual(["history-1"])
})
