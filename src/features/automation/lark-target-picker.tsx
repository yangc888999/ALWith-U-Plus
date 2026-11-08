// 飞书推送目标选择器：群聊列表 + 成员搜索，多选。
//
// 数据来自本机 `lark-cli`（Rust 侧 `larkCliTargets`）：群聊一次拉全量，成员必须给关键词
// 才搜（`contact +search-user` 不接受空查询）。目标 id 落库，名字只用于显示，所以群改名
// 不影响已经存好的任务。
//
// 默认折叠，只显示已选目标 + 一个「添加对象」按钮：弹窗一打开就渲染两个 tab、搜索框和
// 一屏群聊，把「推送怎么配」变成了最抢眼的一块，而多数任务只需要默认那一个收件人
// （2026-11-08）。点开才拉数据，而且**每次点开都重新拉**——群聊和成员是活的，拿一份
// 上次缓存的列表比不显示更糟。

import { isTauri } from "@tauri-apps/api/core"
import { ChevronDownIcon, Loader2Icon, PlusIcon, SearchIcon, XIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { commands, type LarkTarget } from "@/bindings"
import { Input } from "@/components/ui/input"
import { describeError } from "@/lib/error-text"
import { cn } from "@/lib/utils"

type Kind = "chat" | "user"

export function LarkTargetPicker({
  targets,
  onChange,
  disabled
}: {
  targets: LarkTarget[]
  onChange: (next: LarkTarget[]) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<Kind>("chat")
  const [query, setQuery] = useState("")
  const [rows, setRows] = useState<LarkTarget[]>([])
  // null = 这一轮展开还没拉过群聊。每次重新展开都清回 null，于是「点添加对象」= 刷新。
  const [chatRows, setChatRows] = useState<LarkTarget[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 群聊：展开后拉全量，再按关键词在前端过滤（CLI 不支持群聊搜索）；
  // 成员：必须给关键词才搜（空查询 CLI 直接返回空），输入防抖 350ms。
  useEffect(() => {
    if (!open || disabled || !isTauri()) return
    if (kind === "user" && query.trim() === "") {
      setRows([])
      return
    }
    if (kind === "chat" && chatRows !== null) {
      setRows(chatRows)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const timer = window.setTimeout(
      () => {
        void (async () => {
          try {
            const next = await commands.larkCliTargets({
              kind,
              query: kind === "user" ? query.trim() : ""
            })
            if (cancelled) return
            if (kind === "chat") setChatRows(next)
            setRows(next)
          } catch (cause) {
            if (!cancelled) setError(describeError(cause))
          } finally {
            if (!cancelled) setLoading(false)
          }
        })()
      },
      kind === "user" ? 350 : 0
    )
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, kind, query, disabled, chatRows])

  const selectedIds = new Set(targets.map((target) => target.id))
  const toggle = (target: LarkTarget): void => {
    onChange(
      selectedIds.has(target.id)
        ? targets.filter((entry) => entry.id !== target.id)
        : [...targets, target]
    )
  }

  const toggleOpen = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    // 每次展开都当新的一次：清缓存、回到群聊、清搜索词，让列表就是当前真实状态。
    setChatRows(null)
    setRows([])
    setQuery("")
    setKind("chat")
    setError(null)
    setOpen(true)
  }

  // 群聊按关键词在前端过滤（群聊列表已全量缓存）；成员由服务端搜索，无需再过滤。
  const term = query.trim().toLowerCase()
  const displayRows =
    kind === "chat" && term !== "" ? rows.filter((row) => row.name.toLowerCase().includes(term)) : rows

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {targets.map((target) => (
          <span
            key={target.id}
            className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground"
          >
            <span className="truncate">{target.name}</span>
            <button
              type="button"
              aria-label={t("automation.larkRemove", { name: target.name })}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => toggle(target)}
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
        <button
          type="button"
          aria-expanded={open}
          disabled={disabled}
          onClick={toggleOpen}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-border/70 px-2 text-[11px] transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60",
            open ? "text-foreground" : "text-muted-foreground"
          )}
        >
          <PlusIcon className="size-3" aria-hidden="true" />
          {t("automation.larkAddTarget")}
          <ChevronDownIcon
            className={cn("size-3 transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
        </button>
      </div>

      {open && (
        <div className="rounded-lg border border-border/60 bg-background">
          <div className="flex items-center gap-1 p-2 pb-1">
            {(["chat", "user"] as const).map((value) => (
              <button
                key={value}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setKind(value)
                  setQuery("")
                }}
                className={cn(
                  "rounded px-2 py-1 text-[11px]",
                  kind === value
                    ? "bg-foreground/10 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-foreground/5"
                )}
              >
                {t(value === "chat" ? "automation.larkGroups" : "automation.larkPeople")}
              </button>
            ))}
            <div className="relative ms-auto w-40">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                disabled={disabled}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t(kind === "user" ? "automation.larkSearchPeople" : "automation.larkAllGroups")}
                className="h-7 ps-6 text-xs"
              />
            </div>
          </div>

          <div className="max-h-40 overflow-y-auto px-1 pb-1">
            {loading && (
              <div className="flex items-center gap-2 px-2 py-3 text-[11px] text-muted-foreground">
                <Loader2Icon className="size-3 animate-spin" />
                {t("automation.larkLoading")}
              </div>
            )}
            {error !== null && !loading && (
              <div className="px-2 py-3 text-[11px] text-destructive">{error}</div>
            )}
            {!loading && error === null && displayRows.length === 0 && (
              <div className="px-2 py-3 text-[11px] text-muted-foreground">
                {kind === "user"
                  ? t("automation.larkSearchHint")
                  : term !== ""
                    ? t("automation.larkNoMatch")
                    : t("automation.larkNoGroups")}
              </div>
            )}
            {!loading &&
              displayRows.map((row) => {
                const checked = selectedIds.has(row.id)
                return (
                  <button
                    key={row.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => toggle(row)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-xs hover:bg-foreground/5",
                      checked && "bg-foreground/[0.06]"
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
                        checked ? "border-primary bg-primary text-primary-foreground" : "border-input"
                      )}
                    >
                      {checked && <span className="text-[9px] leading-none">✓</span>}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{row.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                      {row.id.slice(0, 6)}…
                    </span>
                  </button>
                )
              })}
          </div>
        </div>
      )}
    </div>
  )
}
