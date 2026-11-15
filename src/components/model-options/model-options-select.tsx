/**
 * 四处模型选择器共用的分组下拉渲染组件。
 *
 * ①②④ 直接使用本组件；③ 的聊天紧凑菜单受 `@alwith/module-chat` 的 `ModelMenu` 外壳约束，
 * 但它消费的仍然是同一个 `ModelOptionsResult`，并且复用同一份 `ModelOptionIcon`、
 * `modelGroupLabel()`、`modelShortLabel()` / `modelTriggerLabel()`。因此四处的分组、显示名、
 * 图标、排序、可用性、勾选态全部来自同一个出口，不再有各自手写的 option 列表。
 */

import type { ReactNode } from "react"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from "@/components/alwith-ui/select"
import { type ModelOptionsResult, modelTriggerLabel } from "@/lib/model-options"
import { cn } from "@/lib/utils"

import { ModelOptionIcon } from "./model-option-icon"

export interface ModelOptionsSelectProps {
  /** 唯一出口的结果。 */
  result: ModelOptionsResult
  value: string
  onValueChange: (value: string) => void
  /** 「自动（内置默认）」这类非模型哨兵项；不传表示没有。 */
  auto?: { value: string; label: string } | null
  /** 一个候选都没有时的占位文案。 */
  emptyLabel?: string
  disabled?: boolean
  ariaLabel?: string
  triggerClassName?: string
  testId?: string
}

/** 统一的分组下拉：组名、行名、图标、禁选态、勾选态都由统一出口决定。 */
export function ModelOptionsSelect({
  result,
  value,
  onValueChange,
  auto = null,
  emptyLabel = "",
  disabled = false,
  ariaLabel,
  triggerClassName = "w-full",
  testId
}: ModelOptionsSelectProps): ReactNode {
  const items = [
    ...(auto === null ? [] : [{ label: auto.label, value: auto.value }]),
    ...result.options.map((option) => ({ label: modelTriggerLabel(option), value: option.id }))
  ]
  return (
    <Select value={value} items={items} disabled={disabled} onValueChange={(next) => onValueChange(next ?? value)}>
      <SelectTrigger className={triggerClassName} aria-label={ariaLabel} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {auto !== null && <SelectItem value={auto.value}>{auto.label}</SelectItem>}
        {result.options.length === 0 && auto === null && emptyLabel !== "" && (
          <div role="presentation" className="px-2 py-1.5 text-xs text-muted-foreground">
            {emptyLabel}
          </div>
        )}
        {result.groups.map((group) => (
          <SelectGroup key={group.id}>
            <SelectLabel>{group.name}</SelectLabel>
            {group.options.map((option) => (
              <SelectItem key={option.id} value={option.id} disabled={!option.available}>
                <ModelOptionIcon kind={option.icon} className="model-option-icon" />
                <span className={cn("truncate", !option.available && "text-muted-foreground")}>{option.label}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
