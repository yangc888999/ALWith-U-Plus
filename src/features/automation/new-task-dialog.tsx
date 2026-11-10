// 「新建定时任务」弹窗：名称 + 大号提示词 + 工作空间/完全访问两个下拉 +
// 重复/时间/有效期一行 + 取消/确定。自定义工作空间用原生目录选择器，不让人手敲绝对路径。
// 编辑时复用同一个弹窗，字段从既有任务回填。

import { isTauri } from "@tauri-apps/api/core"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { FolderOpenIcon, ShieldCheckIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { modelEntries, type ModelEntry } from "@/features/settings/sections/model-section"
import { NATIVE_MODEL_GROUP } from "@/agent/native-models"
import { commands } from "@/bindings"
import { defaultModelChoice } from "@/lib/default-model"
import { useSettingsNativeModels } from "@/lib/settings-bridge"
import { useProviders } from "@/lib/use-providers"
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
import { describeError } from "@/lib/error-text"
import { cn } from "@/lib/utils"
import { openSettingsWindow } from "@/lib/window-manager"

import {
  REPEAT_RULES,
  isRepeatRule,
  type LarkTarget,
  type ScheduledTask,
  type TaskDraft,
  type RepeatRule
} from "./types"
import { LarkTargetPicker } from "./lark-target-picker"

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
  larkIdentity: "bot",
  repeat: "daily",
  intervalMinutes: 60,
  time: "08:05",
  validUntil: null,
  enabled: true
}

/** 裸 select：整块只有一个外框，控件本身不再画边框和底色。 */
const bareFieldClass = "w-full cursor-pointer appearance-none bg-transparent text-sm text-foreground outline-none disabled:cursor-not-allowed disabled:text-muted-foreground"
/** 裸 input：同上，去掉 shadcn Input 默认的边框 / 高度 / 阴影。 */
const bareInputClass =
  "h-6 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 disabled:cursor-not-allowed"

/**
 * 一格调度设置：迷你 label + 裸控件，整块共用一个边框。
 *
 * 参考图里「重复 / 时间 / 有效期」是三个并排的浅色格子，而不是三张各自带标题、内层再套一个
 * 输入框的卡片 —— 后者的边框会叠成两层，看着比内容还重（2026-11-08）。
 */
function CompactField({
  label,
  htmlFor,
  className,
  children
}: {
  label: string
  htmlFor: string
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 px-3.5 py-2.5 transition-colors focus-within:bg-muted/15",
        className
      )}
    >
      <label htmlFor={htmlFor} className="text-[10px] font-medium leading-4 text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
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
  // The same catalog as 设置 → 默认模型 and the chat picker: engine-listed GPT rows plus every
  // configured gateway model. A hand-built list here would offer ids the run cannot resolve.
  const providerSnapshot = useProviders()
  const nativeModels = useSettingsNativeModels()
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
    setForm((previous) =>
      previous.larkTargets.length > 0 ? previous : { ...previous, larkTargets: [selfTarget] }
    )
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
  const entries = useMemo(
    () => (open ? modelEntries(providerSnapshot, nativeModels) : []),
    [open, providerSnapshot, nativeModels]
  )
  const modelGroups = useMemo(() => {
    const groups: Array<{ id: string; name: string; entries: ModelEntry[] }> = []
    for (const entry of entries) {
      let group = groups.find((candidate) => candidate.id === entry.groupId)
      if (group === undefined) {
        group = { id: entry.groupId, name: entry.groupName, entries: [] }
        groups.push(group)
      }
      group.entries.push(entry)
    }
    return groups
  }, [entries])
  // An edited task may name a model the engine has since withdrawn. Keep it visible instead of
  // rendering a blank select that looks like "follow default" while actually saving the old id.
  const modelMissing = form.model !== "" && !entries.some((entry) => entry.id === form.model)
  // 选中的模型条目决定 Effort 档位与「加速」是否可用：档位来自引擎/供应商目录，不在这里另造。
  const selectedEntry = entries.find((entry) => entry.id === form.model)
  const effortOptions = selectedEntry?.efforts ?? []
  // 「加速」（fast mode）只有 GPT 组认；给其它厂商显示这个开关只会造出一个无效配置。
  const canFast = selectedEntry?.groupId === NATIVE_MODEL_GROUP.id
  // 只读摘要：任务没指定模型/档位时，把「设置 → 默认模型」里真正会生效的值显示出来，
  // 而不是让「跟随默认」变成一句看不出内容的空话。
  const defaultEntry = entries.find((entry) => entry.id === (defaultChoice?.model ?? ""))
  const pinned = form.model !== ""
  const summaryModel = pinned
    ? (selectedEntry?.label ?? form.model)
    : (defaultEntry?.label ?? defaultChoice?.model ?? t("automation.modelBuiltinDefault"))
  const summaryEffort = pinned
    ? (form.effort !== "" ? form.effort : (selectedEntry?.defaultEffort ?? t("automation.effortDefaultShort")))
    : (defaultChoice?.effort ?? defaultEntry?.defaultEffort ?? t("automation.effortDefaultShort"))
  // 选中模型后，Effort / 加速仍按所选模型来；留空时才显示全局默认。
  const effortDisabled = !pinned || effortOptions.length === 0
  // A custom workspace with no folder chosen would silently fall back to the default one. Make the
  // missing choice visible instead of writing a task that looks custom but is not.
  const canSubmit =
    form.name.trim() !== "" &&
    form.prompt.trim() !== "" &&
    (!workspaceCustom || form.cwd.trim() !== "")

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
      <DialogContent className="flex max-h-[92vh] min-h-0 flex-col overflow-hidden border-border/70 bg-background/95 p-0 shadow-2xl sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b border-border/60 px-6 pb-4 pt-6">
          <DialogTitle>{t(task === null ? "automation.newTitle" : "automation.editTitle")}</DialogTitle>
          <DialogDescription className="text-xs leading-5">{t("automation.newDesc")}</DialogDescription>
        </DialogHeader>

        <form
          id="automation-task-form"
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          {/* 名称：一行输入，不再套一层分组卡片（参照 WorkBuddy 的扁平弹窗）。 */}
          <Input
            id="automation-name"
            aria-label={t("automation.fieldName")}
            value={form.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder={t("automation.fieldNamePlaceholder")}
            autoFocus
            className="h-11 rounded-lg border-border/60 bg-muted/20 px-3.5 text-sm shadow-none transition-colors focus-visible:bg-background"
          />

          {/* 提示词：一个大输入区，工作空间 / 完全访问做成它底部的两个小胶囊。 */}
          <div className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-muted/10 transition-colors focus-within:border-ring/60 focus-within:bg-muted/15">
            <Textarea
              id="automation-prompt"
              aria-label={t("automation.fieldPrompt")}
              className="min-h-[128px] resize-none border-0 bg-transparent px-3.5 py-3 text-sm shadow-none focus-visible:ring-0"
              value={form.prompt}
              onChange={(event) => patch({ prompt: event.target.value })}
              placeholder={t("automation.fieldPromptPlaceholder")}
            />
            <div className="flex flex-wrap items-center gap-1 border-t border-border/50 px-2 py-1.5">
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

          {/* 调度：重复 / 时间 / 有效期共用一个容器，内部用细分隔线分成三格。 */}
          <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-border/60 bg-muted/10 [&>*+*]:border-t [&>*+*]:border-border/50 sm:grid-cols-3 sm:[&>*+*]:border-l sm:[&>*+*]:border-t-0">
            <CompactField label={t("automation.fieldRepeat")} htmlFor="automation-repeat">
              <select
                id="automation-repeat"
                className={bareFieldClass}
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
            </CompactField>
            <CompactField
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
                  className={bareInputClass}
                />
              ) : (
                <Input
                  id="automation-time"
                  type="time"
                  value={form.time}
                  onChange={(event) => patch({ time: event.target.value })}
                  className={bareInputClass}
                />
              )}
            </CompactField>
            <CompactField label={t("automation.fieldValidity")} htmlFor="automation-validity">
              <select
                id="automation-validity"
                className={bareFieldClass}
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
                  className="mt-1 h-7 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
                  type="date"
                  value={form.validUntil ?? ""}
                  onChange={(event) => patch({ validUntil: event.target.value || null })}
                  aria-label={t("automation.validityUntil")}
                />
              )}
            </CompactField>
          </div>

          {/* 运行模型：模型独占一行（名字长），Effort / 加速并排，共用一个容器。 */}
          <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-border/60 bg-muted/10 sm:grid-cols-2">
            <CompactField className="sm:col-span-2" label={t("automation.fieldModel")} htmlFor="automation-model">
              <select
                id="automation-model"
                className={bareFieldClass}
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
                    {group.entries.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {modelMissing && <option value={form.model}>{form.model}</option>}
              </select>
              <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground/80">
                {t("automation.modelHint")}
              </p>
            </CompactField>
            <CompactField
              className="border-t border-border/50 sm:border-r"
              label={t("automation.fieldEffort")}
              htmlFor="automation-effort"
            >
              <select
                id="automation-effort"
                className={bareFieldClass}
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
              {effortDisabled && (
                <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground/80">
                  {t("automation.effortPickModelFirst")}
                </p>
              )}
            </CompactField>
            <CompactField
              className="border-t border-border/50"
              label={t("automation.fieldFast")}
              htmlFor="automation-fast"
            >
              <select
                id="automation-fast"
                className={bareFieldClass}
                value={form.fastMode ? "on" : "off"}
                disabled={!canFast}
                onChange={(event) => patch({ fastMode: event.target.value === "on" })}
              >
                <option value="off">
                  {canFast ? t("automation.fastDefaultOff") : t("automation.fastUnsupported")}
                </option>
                {canFast && <option value="on">{t("automation.fastOn")}</option>}
              </select>
            </CompactField>
          </div>

          {/* 推送结果到飞书：常驻可见，新建任务默认打开（收件人 = 授权人本人）。单层边框，无内套。 */}
          <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/10 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="text-sm font-medium text-foreground">{t("automation.fieldLark")}</span>
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                  {t("automation.larkOffHint")}
                </p>
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
            {/* 没装 CLI：这条链路根本走不通。给一句实话 + 一个直接跳到组件安装页的入口，
                而不是让人对着一个永远发不出去的开关猜（2026-11-08）。 */}
            {cliAvailable === false && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2">
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
              <div className="flex flex-col gap-2.5 border-t border-border/50 pt-2.5">
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
                <CompactField label={t("automation.fieldLarkIdentity")} htmlFor="automation-lark-identity">
                  <select
                    id="automation-lark-identity"
                    className={bareFieldClass}
                    value={form.larkIdentity}
                    onChange={(event) => patch({ larkIdentity: event.target.value })}
                  >
                    <option value="bot">{t("automation.larkIdentityBot")}</option>
                    <option value="user">{t("automation.larkIdentityUser")}</option>
                  </select>
                  <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground/80">
                    {t("automation.larkIdentityHint")}
                  </p>
                </CompactField>
                {selfTarget !== null && (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-foreground">
                        {t("automation.larkSelfTarget", { name: selfTarget.name })}
                      </div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground">
                        {selfTarget.id}
                      </div>
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
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-medium leading-4 text-muted-foreground">
                    {t("automation.fieldLarkTargets")}
                  </span>
                  <LarkTargetPicker
                    targets={form.larkTargets}
                    onChange={(next) => patch({ larkTargets: next })}
                    disabled={!open}
                  />
                  <p className="text-[10px] leading-4 text-muted-foreground/80">
                    {form.larkTargets.length === 0 ? t("automation.larkNoTarget") : t("automation.larkHint")}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* 右下：取消 / 确定 */}
        </form>
        <DialogFooter className="shrink-0 gap-2 border-t border-border/60 bg-muted/10 px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("actions.cancel")}
          </Button>
          <Button type="submit" form="automation-task-form" disabled={!canSubmit} className={cn(!canSubmit && "opacity-50")}>
            {t("actions.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
