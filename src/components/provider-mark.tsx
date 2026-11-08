/**
 * A provider's mark, shared by the settings grid and the model picker so both show the same badge.
 *
 * Priority is an explicit catalog icon, then the vendor site's favicon, then the drawn mark. The
 * favicon is loaded straight from the vendor (the key page is the closest thing to the official
 * site the catalog keeps), so a change on their end shows up without a release; a file that is
 * missing — 智谱's `/favicon.ico` is an HTML page, Kimi's API host returns 404 — falls back.
 */

import { useState } from "react"

import type { Provider } from "@/lib/providers"

export function ProviderMark({ provider, className }: { provider: Provider; className: string }) {
  const [broken, setBroken] = useState(false)
  const Logo = provider.logo
  // 优先使用绘制好的品牌图标（即「默认图标」）；只有目录里显式给出的 favicon（如智谱 GLM）才用远程图标。
  // 自动推导的 origin/favicon.ico 不可靠——小米/MiMo 的主机返回 404 或脏数据，正是「图标不对、太丑」的来源，故弃用；
  // 取不到远程图标时回退到绘制 logo，再不行则用 Provider.logo 的兜底（SparklesIcon）。
  const favicon = provider.favicon ?? null
  if (favicon === null || broken) return <Logo className={className} />
  return (
    <img src={favicon} alt="" className={`${className} rounded object-contain`} onError={() => setBroken(true)} />
  )
}
