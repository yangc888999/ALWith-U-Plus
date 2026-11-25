import { type Session, textOf, type TurnError } from "@alwith/api"
import { codexMessageError, codexRetryNotice } from "@nyssance/codex-acp-v2/client"

import { isAccountModelRefusal, ModelSelectionError } from "@/agent/model-selection-error"

import type { AutomationRunResult } from "./types"

type Outcome = Pick<AutomationRunResult, "status" | "summary" | "error" | "failureKind">

export function failedRun(cause: unknown): Outcome {
  const error = cause instanceof Error ? cause.message : String(cause)
  return {
    status: "failed",
    summary: "",
    error,
    ...(cause instanceof ModelSelectionError || isAccountModelRefusal(error) ? { failureKind: "model" as const } : {})
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function turnFailure(failure: TurnError): Outcome {
  const detail = record(record(failure.error?.data)?.codex) ?? record(record(failure.meta?.codex)?.error)
  const message = typeof detail?.message === "string" ? detail.message : (failure.error?.message ?? failure.stopReason)
  const code = detail?.codexErrorInfo
  return failedRun(code === "model_not_found" || code === "modelNotFound" ? new ModelSelectionError(message) : message)
}

export function completedRun(
  session: Pick<Session, "error" | "turnEndedAt" | "lastStopReason" | "items"> | undefined,
  receipt: string
): Outcome {
  if (!session || !Object.hasOwn(session.turnEndedAt, receipt))
    return failedRun("本轮在执行器放行前仍未结束；未把过程输出当作日报推送。")
  const start = session.items.findLastIndex((item) => item.kind === "user" && item.id === receipt)
  if (start < 0) return failedRun("无法确认本轮输出所属的请求，未生成日报。")
  let answer = ""
  for (let index = start + 1; index < session.items.length; index++) {
    const item = session.items[index]
    if (item.kind === "user") return failedRun("监控会话已收到另一条请求，无法独立确认本轮结果。")
    if (item.kind !== "assistant") continue
    const failure = codexMessageError(item)
    if (failure) return turnFailure(failure)
    const meta = record(item._meta?.codex)
    if (meta?.notice === true || meta?.phase === "commentary" || codexRetryNotice(item._meta)) continue
    const text = textOf(item.content)
    if (text.trim()) answer = text
  }
  if (session.error) return turnFailure(session.error)
  if (isAccountModelRefusal(answer)) return failedRun(answer.trim())
  if (session.lastStopReason !== null && session.lastStopReason !== "end_turn") return failedRun(session.lastStopReason)
  return answer.trim()
    ? { status: "success", summary: answer, error: null }
    : { status: "no_content", summary: "", error: null }
}
