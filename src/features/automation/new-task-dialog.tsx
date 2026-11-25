// 「新建定时任务」弹窗：名称 + 大号提示词 + 工作空间/完全访问两个下拉 +
// 重复/时间/有效期一行 + 取消/确定。自定义工作空间用原生目录选择器，不让人手敲绝对路径。
// 编辑时复用同一个弹窗，字段从既有任务回填。

import { isTauri } from "@tauri-apps/api/core"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { FolderOpenIcon, ShieldCheckIcon } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { commands } from "@/bindings"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { defaultModelChoice } from "@/lib/default-model"
import { describeError } from "@/lib/error-text"
import type { ModelOption } from "@/lib/model-options"
import { useModelOptions } from "@/lib/use-model-options"
import { cn } from "@/lib/utils"
import { openSettingsWindow } from "@/lib/window-manager"

import { LarkTargetPicker } from "./lark-target-picker"
import {
  isRepeatRule,
  type LarkTarget,
  REPEAT_RULES,
  type RepeatRule,
  type ScheduledTask,
  type TaskDraft
} from "./types"

/** 新建一个任务时的默认字段（时间 08:05 对应参考图的卡片示例）。 */
export const DEFAULT_TASK_DRAFT: TaskDraft = {
  name: "",
  prompt: "",
  cwd: "",
  fullAccess: true,
  model: "",
  effort: "",
  fastMode: false,
  larkNotify: false,
  larkTargets: [],
  larkEmptyResultNoticeToSelf: false,
  larkIdentity: "bot",
  repeat: "daily",
  intervalMinutes: 60,
  time: "08:05",
  validUntil: null,
  enabled: true
}

/** 原生 select：和 Input 同一套高度 / 边框，让每个控件在深色底上都能被认出来。 */
const selectClass =
  "h-9 w-full min-w-0 cursor-pointer rounded-md border border-input bg-background px-2.5 text-sm text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"

/** 一个字段 = 标签 + 控件 + 可选说明。标签在上方，窄屏时三者仍然对齐。 */
function ControlField({
  label,
  htmlFor,
  hint,
  className,
  children
}: {
  label: string
  htmlFor: string
  hint?: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground/80">
        {label}
      </label>
      {children}
      {hint !== undefined && <p className="text-[11px] leading-4 text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** 一组字段的标题：把弹窗读成「任务 → 调度 → 执行 → 推送」四段，而不是一长串控件。 */
function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {description !== undefined && <p className="text-xs leading-5 text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function draftFromTask(task: ScheduledTask | null): TaskDraft {
  if (task === null) return { ...DEFAULT_TASK_DRAFT }
  return {
    name: task.name,
    prompt: task.prompt,
    cwd: task.cwd,
    fullAccess: task.fullAccess,
    model: task.model,
    effort: task.effort,
    fastMode: task.fastMode,
    larkNotify: task.larkNotify,
    larkTargets: task.larkTargets,
    larkEmptyResultNoticeToSelf: task.larkEmptyResultNoticeToSelf === true,
    larkIdentity: task.larkIdentity,
    repeat: task.repeat,
    intervalMinutes: task.intervalMinutes,
    time: task.time,
    validUntil: task.validUntil,
    enabled: task.enabled
  }
}

export function NewTaskDialog({
  open,
  onOpenChange,
  task,
  onSubmit
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = 新建；否则为编辑。 */
  task: ScheduledTask | null
  onSubmit: (draft: TaskDraft) => void
}) {
  const { t } = useTranslation()
  // 与 ① ② ③ ④ 同一个出口：候选集、分组名、显示名（已清洗星号别名 / 「可能不可用」）、
  // Effort 档位、可用性与 GPT 家族判定全部由 `useModelOptions()` 提供。定时任务无人值守，
  // 更不能在这里自建第二份清单去猜哪些 id 能跑。
  const modelOptions = useModelOptions()
  const [form, setForm] = useState<TaskDraft>(() => draftFromTask(task))
  const [workspaceCustom, setWorkspaceCustom] = useState(() => Boolean(task?.cwd))
  const [validityMode, setValidityMode] = useState<"forever" | "until">(() => (task?.validUntil ? "until" : "forever"))
  // 高级设置是常驻分组：折叠把「推送到飞书」这个本轮主角藏起来，编辑历史任务时尤其难找。
  // selfTarget = 飞书 CLI 登录态里的本人，新建/开启推送时作为默认收件人列出来。
  // authChecked 只用来决定「读不到本人」这句提示何时出现，不做 spinner：这个请求通常瞬时返回，
  // 放个转圈反而让常驻分组看起来一直在加载。
  const [selfTarget, setSelfTarget] = useState<LarkTarget | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  // 飞书 CLI 组件本身装没装：没装的话推送这条路根本走不通，要给出「去安装」的入口，
  // 而不是让人对着一个永远发不出去的开关发愣（2026-11-08）。
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null)
  const [defaultCwd, setDefaultCwd] = useState("")
  const autoFilledSelf = useRef(false)
  const defaultNotifyApplied = useRef(false)
  const defaultChoice = useMemo(() => (open ? defaultModelChoice() : null), [open])

  // 每次打开（或切换编辑对象）都用当前任务回填，避免残留上一次的草稿。
  useEffect(() => {
    if (!open) return
    setForm(draftFromTask(task))
    setWorkspaceCustom(Boolean(task?.cwd))
    setValidityMode(task?.validUntil ? "until" : "forever")
    setAuthChecked(false)
    setCliAvailable(null)
    autoFilledSelf.current = false
    defaultNotifyApplied.current = false
  }, [open, task])

  // 默认工作空间地址 + 授权人本人（飞书 CLI 登录态里的 user identity）。
  useEffect(() => {
    if (!open || !isTauri()) return
    let cancelled = false
    void commands
      .quickChatDirectory()
      .then((path) => {
        if (!cancelled) setDefaultCwd(path)
      })
      .catch(() => undefined)
    void commands
      .larkCliStatus()
      .then((status) => {
        if (!cancelled) setCliAvailable(status.available)
      })
      .catch(() => {
        if (!cancelled) setCliAvailable(false)
      })
    void commands
      .larkCliAuthStatus()
      .then((status) => {
        if (cancelled) return
        const user = status.identities.find(
          (identity) =>
            identity.kind === "user" &&
            identity.available &&
            typeof identity.openId === "string" &&
            identity.openId !== ""
        )
        if (user?.openId) {
          setSelfTarget({
            id: user.openId,
            name: user.userName ?? t("automation.larkSelfFallback"),
            kind: "user"
          })
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAuthChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, t])

  // 打开「推送结果到飞书」且没有收件人时，默认发给授权人本人；只补一次，之后用户可自由删改。
  useEffect(() => {
    if (!open || !form.larkNotify || selfTarget === null || autoFilledSelf.current) return
    if (form.larkTargets.length > 0) {
      autoFilledSelf.current = true
      return
    }
    autoFilledSelf.current = true
    setForm((previous) => (previous.larkTargets.length > 0 ? previous : { ...previous, larkTargets: [selfTarget] }))
  }, [open, form.larkNotify, form.larkTargets.length, selfTarget])

  // 「推送结果到飞书」对**新建任务**默认打开，收件人就是授权人本人（2026-11-08 用户要求：
  // 每次新建都要手动开一遍太啰嗦）。只在真的读到本人账号时才默认开：读不到（没装 CLI / 没登录）
  // 还默认开，等于给每个任务埋一个必然发不出去的动作，那种情况交给下面的安装 / 登录引导。
  useEffect(() => {
    if (!open || task !== null || defaultNotifyApplied.current) return
    if (selfTarget !== null) {
      defaultNotifyApplied.current = true
      setForm((previous) => (previous.larkNotify ? previous : { ...previous, larkNotify: true }))
      return
    }
    // 检查完了还是没有本人：就此定案，别等用户手动关掉之后再被异步结果翻回开启。
    if (authChecked) defaultNotifyApplied.current = true
  }, [open, task, selfTarget, authChecked])

  const patch = (next: Partial<TaskDraft>): void => setForm((previous) => ({ ...previous, ...next }))
  // 分组也直接取统一出口的 `groups`，不再按 groupId 自建一份：分组名、顺序、图标口径
  // 与设置页 / 聊天框 / 拉会成员完全一致。
  const options: readonly ModelOption[] = open ? modelOptions.options : []
  const modelGroups = open ? modelOptions.groups : []
  // An edited task may name a model the engine has since withdrawn. Keep it visible instead of
  // rendering a blank select that looks like "follow default" while actually saving the old id.
  const modelMissing = form.model !== "" && !options.some((entry) => entry.id === form.model)
  // 选中的模型条目决定 Effort 档位与「加速」是否可用：档位来自统一出口，不在这里另造。
  const selectedEntry = options.find((entry) => entry.id === form.model)
  const effortOptions = selectedEntry?.efforts ?? []
  // 「加速」（fast mode）只有 GPT 家族认；用出口的 `isNative` 判定，与四处口径一致。
  const canFast = selectedEntry?.isNative === true
  // 只读摘要：任务没指定模型/档位时，把「设置 → 默认模型」里真正会生效的值显示出来，
  // 而不是让「跟随默认」变成一句看不出内容的空话。
  const defaultEntry = options.find((entry) => entry.id === (defaultChoice?.model ?? ""))
  const pinned = form.model !== ""
  const summaryModel = pinned
    ? (selectedEntry?.label ?? form.model)
    : (defaultEntry?.label ?? defaultChoice?.model ?? t("automation.modelBuiltinDefault"))
  const summaryEffort = pinned
    ? form.effort !== ""
      ? form.effort
      : (selectedEntry?.defaultEffort ?? t("automation.effortDefaultShort"))
    : (defaultChoice?.effort ?? defaultEntry?.defaultEffort ?? t("automation.effortDefaultShort"))
  // 选中模型后，Effort / 加速仍按所选模型来；留空时才显示全局默认。
  const effortDisabled = !pinned || effortOptions.length === 0
  // A custom workspace with no folder chosen would silently fall back to the default one. Make the
  // missing choice visible instead of writing a task that looks custom but is not.
  const canSubmit =
    form.name.trim() !== "" &&
    form.prompt.trim() !== "" &&
    (!workspaceCustom || form.cwd.trim() !== "") &&
    // A task with delivery on but no recipient would be saved and then silently never send.
    (!form.larkNotify || form.larkTargets.length > 0)

  /** Pick the working directory through the OS dialog: hand-typed absolute paths are easy to get
   *  wrong and cannot be validated without touching the filesystem. */
  const pickWorkspace = async (): Promise<void> => {
    if (!isTauri()) return
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: form.cwd.trim() || undefined
      })
      if (typeof picked === "string" && picked !== "") patch({ cwd: picked })
    } catch (cause) {
      toast.error(describeError(cause))
    }
  }

  const submit = (): void => {
    if (!canSubmit) return
    onSubmit({
      ...form,
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      cwd: workspaceCustom ? form.cwd.trim() : "",
      validUntil: validityMode === "forever" ? null : form.validUntil
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] min-h-0 flex-col overflow-hidden border-border/70 p-0 shadow-2xl sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border/60 px-4 pt-5 pb-4 sm:px-6 sm:pt-6">
          <DialogTitle className="text-base">
            {t(task === null ? "automation.newTitle" : "automation.editTitle")}
          </DialogTitle>
          <DialogDescription className="text-xs leading-5">{t("automation.newDesc")}</DialogDescription>
        </DialogHeader>

        <form
          id="automation-task-form"
          className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5 sm:px-6"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <FormSection title={t("automation.sectionBasic")}>
            <ControlField label={t("automation.fieldName")} htmlFor="automation-name">
              <Input
                id="automation-name"
                aria-label={t("automation.fieldName")}
                value={form.name}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder={t("automation.fieldNamePlaceholder")}
                autoFocus
              />
            </ControlField>

            <ControlField label={t("automation.fieldPrompt")} htmlFor="automation-prompt">
              <div className="overflow-hidden rounded-lg border border-input bg-background shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
                <Textarea
                  id="automation-prompt"
                  aria-label={t("automation.fieldPrompt")}
                  className="min-h-[112px] resize-y border-0 bg-transparent px-3 py-2.5 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
                  value={form.prompt}
                  onChange={(event) => patch({ prompt: event.target.value })}
                  placeholder={t("automation.fieldPromptPlaceholder")}
                />
                <div className="flex flex-wrap items-center gap-1 border-t border-border/60 bg-muted/30 px-2 py-1.5">
                  <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted">
                    <FolderOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
                    <select
                      aria-label={t("automation.fieldWorkspace")}
                      className="cursor-pointer appearance-none bg-transparent text-xs text-foreground outline-none"
                      value={workspaceCustom ? "custom" : "default"}
                      onChange={(event) => {
                        const custom = event.target.value === "custom"
                        setWorkspaceCustom(custom)
                        if (!custom) patch({ cwd: "" })
                      }}
                    >
                      <option value="default">{t("automation.workspaceDefault")}</option>
                      <option value="custom">{t("automation.workspaceCustom")}</option>
                    </select>
                  </label>
                  {workspaceCustom && (
                    <button
                      type="button"
                      onClick={() => void pickWorkspace()}
                      title={form.cwd || t("automation.workspacePick")}
                      aria-label={t("automation.workspacePick")}
                      className="inline-flex h-7 max-w-[260px] items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted"
                    >
                      <span
                        className={cn(
                          "truncate font-mono text-[11px]",
                          form.cwd === "" ? "text-muted-foreground" : "text-foreground"
                        )}
                      >
                        {form.cwd || t("automation.workspacePick")}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    aria-pressed={form.fullAccess}
                    onClick={() => patch({ fullAccess: !form.fullAccess })}
                    title={t(form.fullAccess ? "automation.fullAccessOn" : "automation.fullAccessOff")}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted",
                      form.fullAccess ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
                    {t("automation.fieldFullAccess")}
                  </button>
                  {!workspaceCustom && defaultCwd !== "" && (
                    <span
                      className="ms-auto max-w-[45%] truncate px-1 text-[10px] text-muted-foreground/70"
                      title={defaultCwd}
                    >
                      {t("automation.workspaceDefaultPath", { path: defaultCwd })}
                    </span>
                  )}
                </div>
              </div>
            </ControlField>
          </FormSection>

          <FormSection title={t("automation.sectionSchedule")}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <ControlField label={t("automation.fieldRepeat")} htmlFor="automation-repeat">
                <select
                  id="automation-repeat"
                  className={selectClass}
                  value={form.repeat}
                  onChange={(event) => {
                    const value = event.target.value
                    if (isRepeatRule(value)) patch({ repeat: value as RepeatRule })
                  }}
                >
                  {REPEAT_RULES.map((rule) => (
                    <option key={rule} value={rule}>
                      {t(`automation.repeat.${rule}`)}
                    </option>
                  ))}
                </select>
              </ControlField>
              <ControlField
                label={t(form.repeat === "interval" ? "automation.fieldInterval" : "automation.fieldTime")}
                htmlFor="automation-time"
              >
                {form.repeat === "interval" ? (
                  <Input
                    id="automation-time"
                    type="number"
                    min={1}
                    value={form.intervalMinutes}
                    onChange={(event) => patch({ intervalMinutes: Math.max(1, Number(event.target.value) || 1) })}
                  />
                ) : (
                  <Input
                    id="automation-time"
                    type="time"
                    value={form.time}
                    onChange={(event) => patch({ time: event.target.value })}
                  />
                )}
              </ControlField>
              <ControlField label={t("automation.fieldValidity")} htmlFor="automation-validity">
                <select
                  id="automation-validity"
                  className={selectClass}
                  value={validityMode}
                  onChange={(event) => {
                    const mode = event.target.value as "forever" | "until"
                    setValidityMode(mode)
                    if (mode === "forever") patch({ validUntil: null })
                    else if (form.validUntil === null) {
                      // 默认给一个「今天」的 ISO 日期，用户可直接改。
                      const now = new Date()
                      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
                      patch({ validUntil: today })
                    }
                  }}
                >
                  <option value="forever">{t("automation.validityForever")}</option>
                  <option value="until">{t("automation.validityUntil")}</option>
                </select>
                {validityMode === "until" && (
                  <Input
                    type="date"
                    value={form.validUntil ?? ""}
                    onChange={(event) => patch({ validUntil: event.target.value || null })}
                    aria-label={t("automation.validityUntil")}
                  />
                )}
              </ControlField>
            </div>
          </FormSection>

          <FormSection title={t("automation.sectionExecution")}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ControlField
                className="sm:col-span-2"
                label={t("automation.fieldModel")}
                htmlFor="automation-model"
                hint={t("automation.modelHint")}
              >
                <select
                  id="automation-model"
                  className={selectClass}
                  value={form.model}
                  onChange={(event) => {
                    const model = event.target.value
                    // 换模型必须清掉上一档 effort：档位是模型私有的，留着旧值要么被引擎拒绝，
                    // 要么被 landModelSwitch 静默改回默认，界面上却显示旧的。
                    patch({ model, effort: "", fastMode: false })
                  }}
                >
                  <option value="">{t("automation.modelDefaultWith", { value: summaryModel })}</option>
                  {modelGroups.map((group) => (
                    <optgroup key={group.id} label={group.name}>
                      {group.options.map((option) => (
                        <option key={option.id} value={option.id} disabled={!option.available}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  {modelMissing && <option value={form.model}>{form.model}</option>}
                </select>
              </ControlField>
              <ControlField
                label={t("automation.fieldEffort")}
                htmlFor="automation-effort"
                hint={effortDisabled ? t("automation.effortPickModelFirst") : undefined}
              >
                <select
                  id="automation-effort"
                  className={selectClass}
                  value={form.effort}
                  disabled={effortDisabled}
                  onChange={(event) => patch({ effort: event.target.value })}
                >
                  <option value="">{t("automation.effortDefaultWith", { value: summaryEffort })}</option>
                  {effortOptions.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </ControlField>
              <ControlField label={t("automation.fieldFast")} htmlFor="automation-fast">
                <select
                  id="automation-fast"
                  className={selectClass}
                  value={form.fastMode ? "on" : "off"}
                  disabled={!canFast}
                  onChange={(event) => patch({ fastMode: event.target.value === "on" })}
                >
                  <option value="off">
                    {canFast ? t("automation.fastDefaultOff") : t("automation.fastUnsupported")}
                  </option>
                  {canFast && <option value="on">{t("automation.fastOn")}</option>}
                </select>
              </ControlField>
            </div>
          </FormSection>

          <FormSection title={t("automation.sectionDelivery")} description={t("automation.sectionAdvancedHint")}>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-foreground">{t("automation.fieldLark")}</span>
                  <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{t("automation.larkOffHint")}</p>
                </div>
                <Switch
                  id="automation-lark-push"
                  checked={form.larkNotify}
                  // 没装 CLI 只锁「开」这个方向：老任务本来就开着推送，必须留一条关掉的路。
                  disabled={cliAvailable === false && !form.larkNotify}
                  onCheckedChange={(checked) => patch({ larkNotify: checked })}
                  aria-label={t("automation.fieldLark")}
                />
              </div>
              <div
                className={cn(
                  "mt-3 flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/60 px-3 py-2",
                  !form.larkNotify && "opacity-55"
                )}
              >
                <div className="min-w-0">
                  <label htmlFor="automation-lark-empty-notice" className="text-xs font-medium text-foreground">
                    {t("automation.larkEmptyNotice")}
                  </label>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    {t("automation.larkEmptyNoticeHint")}
                  </p>
                </div>
                <Switch
                  id="automation-lark-empty-notice"
                  checked={form.larkEmptyResultNoticeToSelf === true}
                  disabled={!form.larkNotify}
                  onCheckedChange={(checked) => patch({ larkEmptyResultNoticeToSelf: checked })}
                  aria-label={t("automation.larkEmptyNotice")}
                />
              </div>
              {/* 没装 CLI：这条链路根本走不通。给一句实话 + 一个直接跳到组件安装页的入口，
                  而不是让人对着一个永远发不出去的开关猜（2026-11-08）。 */}
              {cliAvailable === false && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2">
                  <p className="min-w-0 flex-1 text-[11px] leading-4 text-amber-600">
                    {t("automation.larkCliMissing")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 bg-background px-2 text-[11px]"
                    onClick={() => void openSettingsWindow("extensions").catch(() => undefined)}
                  >
                    {t("automation.larkCliInstall")}
                  </Button>
                </div>
              )}
              {form.larkNotify && (
                <div className="mt-3 space-y-3 border-t border-border/50 pt-3">
                  {/* 读不到本人不是错误：机器人身份发群聊根本不需要本人登录。所以只在
                      「检查完了 + 没本人 + 一个收件人都没加」时给一句低调提示，不用黄色告警；
                      装好了 CLI 只是没登录时，顺手给个去组件页登录的入口。 */}
                  {authChecked && selfTarget === null && form.larkTargets.length === 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 flex-1 text-[11px] leading-4 text-muted-foreground">
                        {t("automation.larkAuthMissing")}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-[11px]"
                        onClick={() => void openSettingsWindow("extensions").catch(() => undefined)}
                      >
                        {t("automation.larkOpenComponent")}
                      </Button>
                    </div>
                  )}
                  <ControlField
                    label={t("automation.fieldLarkIdentity")}
                    htmlFor="automation-lark-identity"
                    hint={t("automation.larkIdentityHint")}
                  >
                    <select
                      id="automation-lark-identity"
                      className={selectClass}
                      value={form.larkIdentity}
                      onChange={(event) => patch({ larkIdentity: event.target.value })}
                    >
                      <option value="bot">{t("automation.larkIdentityBot")}</option>
                      <option value="user">{t("automation.larkIdentityUser")}</option>
                    </select>
                  </ControlField>
                  {selfTarget !== null && (
                    <div className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-foreground">
                          {t("automation.larkSelfTarget", { name: selfTarget.name })}
                        </div>
                        <div className="truncate font-mono text-[10px] text-muted-foreground">{selfTarget.id}</div>
                      </div>
                      {/* 默认收件人已经在列表里了就不再摆一个灰掉的按钮。 */}
                      {!form.larkTargets.some((entry) => entry.id === selfTarget.id) && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 shrink-0 px-2 text-[11px]"
                          onClick={() =>
                            patch({
                              larkTargets: [
                                selfTarget,
                                ...form.larkTargets.filter((entry) => entry.id !== selfTarget.id)
                              ]
                            })
                          }
                        >
                          {t("automation.larkAddSelf")}
                        </Button>
                      )}
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-foreground/80">{t("automation.fieldLarkTargets")}</span>
                    <LarkTargetPicker
                      targets={form.larkTargets}
                      onChange={(next) => patch({ larkTargets: next })}
                      disabled={!open}
                    />
                    <p className="text-[11px] leading-4 text-muted-foreground">
                      {form.larkTargets.length === 0 ? t("automation.larkNoTarget") : t("automation.larkHint")}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </FormSection>
        </form>
        <DialogFooter className="shrink-0 gap-2 border-t border-border/60 bg-muted/10 px-4 py-3 sm:px-6 sm:py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("actions.cancel")}
          </Button>
          <Button
            type="submit"
            form="automation-task-form"
            disabled={!canSubmit}
            className={cn(!canSubmit && "opacity-50")}
          >
            {t("actions.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
