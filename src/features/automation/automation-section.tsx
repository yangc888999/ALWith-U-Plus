// 设置 → 定时任务：纯 UI 的列表页 + tabs + 筛选 + 任务卡片 + 新建/编辑/删除。
//
// 调度器已搬到主窗口（automation-scheduler.ts），只要 App 开着就会跑，本窗口关不关、
// 有没有打开过都不影响。这里只订阅共享 KV 刷新界面、订阅执行结果弹 toast；「立即运行」
// 也只是向主窗口发一个请求，运行记录由主窗口统一写入。

import { isTauri } from "@tauri-apps/api/core"
import {
  CalendarClockIcon,
  FilterIcon,
  ListChecksIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon
} from "lucide-react"
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { commands } from "@/bindings"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { defaultModelChoice } from "@/lib/default-model"
import { modelDisplayId } from "@/lib/model-identity"
import { useBooleanSetting } from "@/lib/use-boolean-setting"
import { cn } from "@/lib/utils"

import { requestAutomationRun, subscribeAutomationRunResult } from "./automation-bridge"
import { NewTaskDialog } from "./new-task-dialog"
import { RunRecords } from "./run-records"
import {
  createTask,
  getAutomationSnapshot,
  listTasks,
  newRunId,
  removeTask,
  setTaskEnabled,
  startAutomationSync,
  subscribeAutomation,
  updateTask
} from "./task-store"
import type { ScheduledTask, TaskDraft, TaskFilter } from "./types"

type Translate = ReturnType<typeof useTranslation>["t"]

/** 界面只负责同步共享数据 + 提示执行结果；到点调度由主窗口常驻负责。 */
function useAutomationSync(): void {
  const { t } = useTranslation()
  useEffect(() => {
    const stopSync = startAutomationSync()
    const stopResults = subscribeAutomationRunResult((result) => {
      if (result.status === "success") toast.success(t("automation.toastRunSuccess"))
      else toast.error(result.error || t("automation.toastRunFailed"))
    })
    return () => {
      stopSync()
      stopResults()
    }
  }, [t])
}

/** 每分钟强制一次重渲染，让卡片上的「X小时后执行」自己往前走。 */
function useMinuteTick(): void {
  const [, bump] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => bump((value) => value + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])
}

function scheduleLabel(task: ScheduledTask, t: Translate): string {
  const repeat = t(`automation.repeat.${task.repeat}`)
  return task.repeat === "interval" ? `${repeat} · ${task.intervalMinutes}min` : `${repeat} ${task.time}`
}

function nextRunLabel(task: ScheduledTask, t: Translate): string {
  if (!task.enabled) return t("automation.filterPaused")
  if (task.nextRunAt === null) return t("automation.noSchedule")
  const diff = task.nextRunAt - Date.now()
  if (diff <= 0) return t("automation.runSoon")
  const minutes = Math.ceil(diff / 60_000)
  if (minutes < 60) return t("automation.runInMinutes", { minutes })
  return t("automation.runInHours", { hours: Math.ceil(diff / 3_600_000) })
}

export function AutomationSection({ onOpenExtensions }: { onOpenExtensions: () => void }) {
  const { t } = useTranslation()
  useSyncExternalStore(subscribeAutomation, getAutomationSnapshot, getAutomationSnapshot)
  useAutomationSync()
  useMinuteTick()

  const tasks = listTasks()
  const [tab, setTab] = useState<"tasks" | "runs">("tasks")
  const [filter, setFilter] = useState<TaskFilter>("all")
  const [query, setQuery] = useState("")
  const [showFilters, setShowFilters] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ScheduledTask | null>(null)
  const [completionSound, setCompletionSound] = useBooleanSetting("automation.completionSound")
  // 默认工作空间地址：任务没指定 cwd 时，把真正会用的目录显示在卡片上。
  const [defaultCwd, setDefaultCwd] = useState("")
  useEffect(() => {
    if (!isTauri()) return
    void commands
      .quickChatDirectory()
      .then(setDefaultCwd)
      .catch(() => undefined)
  }, [])

  const counts: Record<TaskFilter, number> = {
    all: tasks.length,
    enabled: tasks.filter((task) => task.enabled).length,
    paused: tasks.filter((task) => !task.enabled).length
  }
  const q = query.trim().toLowerCase()
  const visible = tasks.filter((task) => {
    if (filter === "enabled" && !task.enabled) return false
    if (filter === "paused" && task.enabled) return false
    if (q !== "" && !task.name.toLowerCase().includes(q) && !task.prompt.toLowerCase().includes(q)) return false
    return true
  })

  const openNew = (): void => {
    setEditing(null)
    setDialogOpen(true)
  }
  const openEdit = (task: ScheduledTask): void => {
    setEditing(task)
    setDialogOpen(true)
  }
  const submit = (draft: TaskDraft): void => {
    if (editing !== null) {
      updateTask(editing.id, draft)
      toast.success(t("automation.toastUpdated"))
    } else {
      createTask(draft)
      toast.success(t("automation.toastCreated"))
    }
  }
  const remove = (task: ScheduledTask): void => {
    if (!window.confirm(t("automation.deleteConfirm", { name: task.name }))) return
    removeTask(task.id)
    toast.success(t("automation.toastDeleted"))
  }
  const runNow = (task: ScheduledTask): void => {
    const runId = newRunId()
    const request = {
      runId,
      taskId: task.id,
      taskName: task.name,
      prompt: task.prompt,
      cwd: task.cwd,
      fullAccess: task.fullAccess,
      model: task.model,
      effort: task.effort,
      fastMode: task.fastMode,
      larkNotify: task.larkNotify,
      larkTargets: task.larkTargets,
      larkIdentity: task.larkIdentity,
      monitorSessionId: task.monitorSessionId
    }
    // 运行记录由主窗口的执行器统一写，这里只发请求（本窗口可能马上被关掉）。
    requestAutomationRun(request)
    toast.info(t("automation.toastRunStarted"))
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-medium">{t("automation.schedulerHint")}</p>
          <p className="text-[11px] leading-4 text-muted-foreground">{t("automation.completionSoundDesc")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("automation.completionSound")}</span>
          <Switch
            checked={completionSound}
            onCheckedChange={setCompletionSound}
            aria-label={t("automation.completionSound")}
          />
        </div>
      </div>
      {/* 顶部 tab：定时任务 | 运行记录 */}
      <div className="flex items-center gap-1 border-b border-border/60 pb-2">
        <TabButton
          active={tab === "tasks"}
          onClick={() => setTab("tasks")}
          icon={<CalendarClockIcon className="size-3.5" />}
        >
          {t("automation.tabTasks")}
        </TabButton>
        <TabButton
          active={tab === "runs"}
          onClick={() => setTab("runs")}
          icon={<ListChecksIcon className="size-3.5" />}
        >
          {t("automation.tabRuns")}
        </TabButton>
      </div>

      {tab === "runs" ? (
        <RunRecords />
      ) : (
        <>
          {/* 右上：筛选 / 搜索 / 批量管理 / + 新建 */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="relative min-w-[10rem] flex-1 sm:max-w-[14rem] sm:flex-none">
              <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="ps-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("automation.search")}
                aria-label={t("automation.search")}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-pressed={showFilters}
              onClick={() => setShowFilters((value) => !value)}
            >
              <FilterIcon className="size-3.5" data-icon="inline-start" />
              {t("automation.filter")}
            </Button>
            <Button variant="outline" size="sm" disabled title={t("automation.batchHint")}>
              <ListChecksIcon className="size-3.5" data-icon="inline-start" />
              {t("automation.batch")}
            </Button>
            <Button size="sm" onClick={openNew}>
              <PlusIcon className="size-3.5" data-icon="inline-start" />
              {t("automation.new")}
            </Button>
          </div>

          {/* 筛选标签：全部 / 已启用 / 已暂停 */}
          {showFilters && (
            <div className="flex flex-wrap items-center gap-1.5">
              {(["all", "enabled", "paused"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    filter === value
                      ? "border-primary/45 bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground hover:bg-muted/50"
                  )}
                >
                  {t(`automation.filter${value.charAt(0).toUpperCase()}${value.slice(1)}`)} ({counts[value]})
                </button>
              ))}
            </div>
          )}

          {/* 任务卡片 */}
          {visible.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/70 py-14 text-center">
              <p className="text-sm text-muted-foreground">{t("automation.empty")}</p>
              <p className="mt-1 text-xs text-muted-foreground/70">{t("automation.emptyHint")}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {visible.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onToggle={(enabled) => setTaskEnabled(task.id, enabled)}
                  onEdit={() => openEdit(task)}
                  onRemove={() => remove(task)}
                  onRunNow={() => runNow(task)}
                  defaultCwd={defaultCwd}
                />
              ))}
            </div>
          )}
        </>
      )}

      <NewTaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        task={editing}
        onSubmit={submit}
        onOpenExtensions={onOpenExtensions}
      />
    </div>
  )
}

/** `gateway:vendor:path%2Fmodel` → `path/model`; engine-native ids stay as they are. */
function shortModelId(id: string): string {
  return modelDisplayId(id)
}

function TabButton({
  active,
  onClick,
  icon,
  children
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
      aria-current={active ? "page" : undefined}
    >
      {icon}
      {children}
    </button>
  )
}

function TaskCard({
  task,
  onToggle,
  onEdit,
  onRemove,
  onRunNow,
  defaultCwd
}: {
  task: ScheduledTask
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onRemove: () => void
  onRunNow: () => void
  defaultCwd: string
}) {
  const { t } = useTranslation()
  const schedule = scheduleLabel(task, t)
  const nextRun = nextRunLabel(task, t)
  // 没单独指定时，把「设置 → 默认模型」里真正生效的值显示出来，而不是空白一片。
  const choice = defaultModelChoice()
  const modelText =
    task.model !== ""
      ? shortModelId(task.model)
      : choice?.model
        ? shortModelId(choice.model)
        : t("automation.modelDefault")
  const effortText = task.effort !== "" ? task.effort : (choice?.effort ?? t("automation.effortDefaultShort"))
  const fastOn = task.model !== "" ? task.fastMode : choice?.fastMode === true
  const workspaceText = task.cwd !== "" ? task.cwd : defaultCwd
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border bg-card p-3.5 transition-opacity",
        task.enabled ? "border-border/70" : "border-border/40 opacity-70"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={task.name}>
          {task.name}
        </h3>
        <Switch checked={task.enabled} onCheckedChange={onToggle} aria-label={t("automation.filterEnabled")} />
      </div>

      {/* 提示词摘要：两三行截断 */}
      <p className="mt-2 line-clamp-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {task.prompt}
      </p>

      <div className="mt-3 flex items-end justify-between gap-2 border-t border-border/50 pt-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <CalendarClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
            {schedule}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{nextRun}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground/80">
            <span className="truncate" title={modelText}>
              {t("automation.summaryModel", { value: modelText })}
            </span>
            <span>{t("automation.summaryEffort", { value: effortText })}</span>
            <span>
              {t("automation.summaryFast", { value: t(fastOn ? "automation.fastOn" : "automation.fastOff") })}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground/70" title={workspaceText}>
            {workspaceText !== ""
              ? t("automation.summaryWorkspace", { value: workspaceText })
              : t("automation.workspaceDefault")}
          </div>
          {/* 运行时的额外配置：档位 / 加速 / 飞书推送，一眼能看出这个任务不是纯默认跑的 */}
          {(task.effort !== "" || task.fastMode || (task.larkNotify && task.larkTargets.length > 0)) && (
            <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
              {task.effort !== "" && (
                <span className="rounded bg-foreground/[0.07] px-1 py-0.5 text-muted-foreground">
                  {t("automation.badgeEffort", { value: task.effort })}
                </span>
              )}
              {task.fastMode && (
                <span className="rounded bg-amber-500/15 px-1 py-0.5 text-amber-700 dark:text-amber-300">
                  {t("automation.badgeFast")}
                </span>
              )}
              {task.larkNotify && task.larkTargets.length > 0 && (
                <span className="rounded bg-sky-500/15 px-1 py-0.5 text-sky-700 dark:text-sky-300">
                  {t("automation.badgeLark", { count: task.larkTargets.length })}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            title={t("automation.runNow")}
            aria-label={t("automation.runNow")}
            onClick={onRunNow}
          >
            <PlayIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title={t("automation.edit")}
            aria-label={t("automation.edit")}
            onClick={onEdit}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-destructive"
            title={t("sidebar.delete")}
            aria-label={t("sidebar.delete")}
            onClick={onRemove}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
