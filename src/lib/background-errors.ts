import { error as logError } from "@tauri-apps/plugin-log"
import { toast } from "sonner"

import { describeError } from "./error-text"
import { startupSilent } from "./startup-window"

/** Preserve nested causes in the log; native errors may also arrive as plain objects. */
export function errorDetails(error: unknown): string {
  const seen = new Set<unknown>()
  const describe = (value: unknown): string => {
    if (value instanceof Error) {
      if (seen.has(value)) return "[circular error cause]"
      seen.add(value)
      const detail = value.stack ?? value.message
      const fields = Object.fromEntries(
        ["method", "code", "data", "reason"].flatMap((key) => {
          const field = (value as unknown as Record<string, unknown>)[key]
          return field === undefined ? [] : [[key, field]]
        })
      )
      const structured = Object.keys(fields).length === 0 ? detail : `${detail}\nDetails: ${describe(fields)}`
      return value.cause === undefined ? structured : `${structured}\nCaused by: ${describe(value.cause)}`
    }
    if (typeof value === "string") return value
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  }
  return describe(error)
}

export function logBackgroundError(context: string, error: unknown): void {
  void logError(`[${context}] ${errorDetails(error)}`).catch((failure) => console.error("[error-log]", failure))
}

/** A stable notice per operation prevents concurrent startup failures from flooding the screen. */
export function reportBackgroundError(
  context: string,
  error: unknown,
  options: { message?: string; action?: { label: string; onClick: () => void } } = {}
): void {
  logBackgroundError(context, error)
  // This module imports `sonner` directly, so it bypassed the gate in `lib/toast-error.ts` and
  // was the one exit that could still paint an error during startup. On 2026-11-08 that is
  // exactly what reached the reader: `connect()` sets `connection = "ready"` before providers are
  // applied, so `reportBackgroundError("provider-startup", …)` fired with the silent window
  // already closed — a raw `acpRequest: Codex process has exited with code 1 …` toast in the
  // corner, gone a second later. The log keeps the details; the screen waits for the window.
  if (startupSilent()) return
  // The log keeps the raw details; the toast is user-facing and goes through the same
  // localization table as every other error (Drive's package errors are English).
  toast.error(options.message ?? describeError(error), {
    id: context,
    action: options.action
  })
}
