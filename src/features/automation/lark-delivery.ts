import type { AutomationRunRequest, AutomationRunResult, DeliveryReceipt, LarkTarget } from "./types"

export async function deliverLarkResult(
  request: Pick<AutomationRunRequest, "larkTargets" | "taskName">,
  result: Pick<AutomationRunResult, "status" | "summary" | "error" | "failureKind">,
  failedLabel: string,
  failedFallback: string,
  send: (targets: LarkTarget[], text: string) => Promise<DeliveryReceipt[]>
): Promise<DeliveryReceipt[]> {
  const targets = request.larkTargets
  const modelFailure = result.status === "failed" && result.failureKind === "model"
  if (modelFailure || result.status === "no_content" || (result.status === "success" && !result.summary.trim())) {
    return targets.map((target) => ({
      targetId: target.id,
      targetName: target.name,
      kind: target.kind,
      status: "skipped",
      error: modelFailure ? "model_error" : "no_content"
    }))
  }
  if (targets.length === 0) return []
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, "0")
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const header = result.status === "failed" ? `${stamp} · ${failedLabel}` : stamp
  const body = result.status === "failed" ? (result.error ?? failedFallback) : result.summary.trim()
  return send(targets, [`【${request.taskName}】`, header, "", body].join("\n").slice(0, 4000))
}
