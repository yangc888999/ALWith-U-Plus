// 「运行记录」tab：时间线式的摘要列表。
//
// 一次运行默认只占一行：时间 + 状态点 + 一句结果。运行中的任务也只留「正在运行」这一行，
// 完整的错误、耗时、会话 id、结果全文都在点开之后才展开——记录多起来时，一屏能扫完最近
// 几十次执行，而不是被表格里的大段输出挤满。

import { ChevronRightIcon, Trash2Icon } from "lucide-react"
import { useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"

import { clearRuns, getAutomationSnapshot, listRuns, subscribeAutomation } from "./task-store"
import type { RunRecord, RunStatus } from "./types"

function useRuns(): RunRecord[] {
  useSyncExternalStore(subscribeAutomation, getAutomationSnapshot, getAutomationSnapshot)
  return listRuns()
}

function formatWhen(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatClock(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
    date.getSeconds()
  ).padStart(2, "0")}`
}

function formatDuration(record: RunRecord): string {
  if (record.finishedAt === null) return "—"
  const seconds = Math.max(0, Math.round((record.finishedAt - record.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

const STATUS_DOT: Record<RunStatus | "waiting", string> = {
  running: "bg-sky-500",
  success: "bg-emerald-500",
  failed: "bg-rose-500",
  waiting: "bg-amber-500"
}

const STATUS_TEXT: Record<RunStatus | "waiting", string> = {
  running: "text-sky-700 dark:text-sky-300",
  success: "text-emerald-700 dark:text-emerald-300",
  failed: "text-rose-700 dark:text-rose-300",
  waiting: "text-amber-700 dark:text-amber-300"
}

/**
 * 一行摘要：运行中给固定文案；失败优先给错误；成功时，引擎内部停止原因
 * （end_turn / tool_call / …）对用户无意义，回退为任务名或「已完成」；agent 写的真实结果照常显示。
 */
function briefOf(record: RunRecord, runningLabel: string, t: (key: string) => string): string {
  if (record.status === "running") return runningLabel
  if (record.status === "success") {
    const ENGINE_STOP_TOKENS = /^(end_turn|tool_call|max_tokens|stop|length|content_filter)$/
    const summary = record.summary?.trim() ?? ""
    if (summary !== "" && !ENGINE_STOP_TOKENS.test(summary)) return summary
    return record.taskName?.trim() || t("automation.ranOk")
  }
  const text = (record.error ?? record.summary ?? "").replace(/\s+/g, " ").trim()
  return text === "" ? "—" : text
}

export function RunRecords() {
  const { t } = useTranslation()
  const runs = useRuns()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [clearOpen, setClearOpen] = useState(false)

  const toggle = (id: string): void =>
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("automation.runsHint", { total: runs.length })}</p>
        <Button
          variant="ghost"
          size="sm"
          disabled={runs.length === 0}
          onClick={() => setClearOpen(true)}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2Icon className="size-3.5" data-icon="inline-start" />
          {t("automation.runsClear")}
        </Button>
        <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>{t("automation.runsClearConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("automation.runsClearConfirmDesc", { total: runs.length })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("automation.runsClearCancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => clearRuns()}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t("automation.runsClearConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 py-12 text-center text-sm text-muted-foreground">
          {t("automation.runsEmpty")}
        </div>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border/60">
          {runs.map((record, index) => {
            const open = expanded.has(record.id)
            return (
              <li key={record.id} className={cn(index > 0 && "border-t border-border/50")}>
                <button
                  type="button"
                  onClick={() => toggle(record.id)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-2 px-3 py-2 text-start hover:bg-foreground/[0.03]"
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[record.status === "running" && record.needsAuth ? "waiting" : record.status])} />
                  <span className="w-24 shrink-0 tabular-nums text-[11px] text-muted-foreground">
                    {formatWhen(record.startedAt)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {record.status === "running" && record.needsAuth
                      ? t("automation.runNowWaiting")
                      : briefOf(record, t("automation.runNowRunning"), t)}
                  </span>
                  <span className={cn("shrink-0 text-[11px]", STATUS_TEXT[record.status === "running" && record.needsAuth ? "waiting" : record.status])}>
                    {t(
                      record.status === "running" && record.needsAuth
                        ? "automation.runStatusWaiting"
                        : record.status === "running"
                          ? "automation.runStatusRunning"
                          : record.status === "success"
                            ? "automation.runStatusSuccess"
                            : "automation.runStatusFailed"
                    )}
                  </span>
                  <ChevronRightIcon
                    className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                  />
                </button>

                {open && (
                  <div className="space-y-2 border-t border-border/40 bg-muted/20 px-3 py-2 text-[11px]">
                    <div className="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1">
                      <span className="text-muted-foreground">{t("automation.runColTask")}</span>
                      <span className="min-w-0 break-words text-foreground">{record.taskName || record.taskId}</span>
                      <span className="text-muted-foreground">{t("automation.runDetailStart")}</span>
                      <span className="tabular-nums text-foreground">{formatClock(record.startedAt)}</span>
                      <span className="text-muted-foreground">{t("automation.runColDuration")}</span>
                      <span className="tabular-nums text-foreground">{formatDuration(record)}</span>
                      {record.sessionId !== null && (
                        <>
                          <span className="text-muted-foreground">{t("automation.runDetailSession")}</span>
                          <span className="min-w-0 break-all font-mono text-[10px] text-muted-foreground">
                            {record.sessionId}
                          </span>
                        </>
                      )}
                    </div>
                    {(record.error ?? record.summary ?? "") !== "" && (
                      <div>
                        <div className="mb-0.5 text-muted-foreground">
                          {record.error !== null ? t("automation.runDetailError") : t("automation.runDetailResult")}
                        </div>
                        <pre className="max-h-48 overflow-auto rounded bg-background/70 p-2 font-sans text-[11px] whitespace-pre-wrap break-words text-foreground">
                          {record.error ?? record.summary}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
