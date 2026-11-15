/**
 * 四处模型选择器共用的图标渲染。
 *
 * 图标类别由 `model-options.ts` 的 `modelIconKind()` 统一判定，这里只负责把它画出来：
 * ChatGPT 用 OpenAI 标，企业 / 账号模型用 ALwith 标，其余按供应商目录取品牌标，都没有则
 * 用通用 Bot。聊天框的紧凑菜单靠 `data-model-group-title` 在每组第一行的图标上补分组标题，
 * 设置页的分组下拉有 `SelectLabel`，不传这个属性即可。
 */

import { Bot } from "lucide-react"
import type { ReactNode } from "react"

import openaiLogo from "@/components/icons/openai-logo.svg"
import { ProviderMark } from "@/components/provider-mark"
import type { ModelIconKind } from "@/lib/model-options"
import { PROVIDERS } from "@/lib/providers"

import alwithLogo from "../../../src-tauri/icons/32x32.png"

export interface ModelOptionIconProps {
  kind: ModelIconKind
  /** 仅聊天紧凑菜单使用：在本行图标上方渲染供应商分组标题。 */
  groupTitle?: string | null
  className?: string
}

/** 统一图标；同一 `ModelIconKind` 在四处必得同一个视觉。 */
export function ModelOptionIcon({
  kind,
  groupTitle = null,
  className = "model-picker-icon"
}: ModelOptionIconProps): ReactNode {
  const providerId = kind.startsWith("provider:") ? kind.slice("provider:".length) : ""
  const provider = providerId === "" ? undefined : PROVIDERS.find((entry) => entry.id === providerId)
  const glyph =
    kind === "chatgpt" ? (
      <img src={openaiLogo} alt="" className="dark:invert" />
    ) : kind === "enterprise" || kind === "account" ? (
      <img src={alwithLogo} alt="" className="size-4" />
    ) : provider !== undefined ? (
      <ProviderMark provider={provider} className="" />
    ) : (
      <Bot className="size-4" />
    )
  return (
    <span
      aria-hidden="true"
      className={className}
      data-model-group-title={groupTitle === null || groupTitle === "" ? undefined : groupTitle}
    >
      {glyph}
    </span>
  )
}
