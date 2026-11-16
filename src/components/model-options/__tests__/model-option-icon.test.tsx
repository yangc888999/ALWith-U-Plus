// 回归探针 —— v1.0.5：设置页下拉里智谱 GLM 的图标被撑成大方块。
//
// 根因不是图标本身，而是一个**静默失效的类名**：`ModelOptionsSelect` 曾给 `ModelOptionIcon`
// 传 `className="model-option-icon"`，而 `src/index.css` 里只定义了 `.model-picker-icon`。
// 类名不存在 → span 没有任何尺寸约束 → 智谱是唯一挂远程 favicon 的供应商，那张原图按自身
// 像素撑成大方块；其余供应商走 lucide，恰好有 24px 默认尺寸，所以"看起来正常"，掩盖了问题。
//
// 这类错误没有任何运行时报错，只能靠测试盯住：任何传给图标容器的类名，都必须在样式表里
// 真的有定义。

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"

import { ModelOptionIcon } from "../model-option-icon"

const CSS = readFileSync(join(process.cwd(), "src", "index.css"), "utf8")

afterEach(cleanup)

/** 递归收集 src 下所有 tsx 源码（跳过测试自身）。 */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : sources(path)
    return path.endsWith(".tsx") ? [path] : []
  })
}

test("图标容器默认类在样式表里真的有定义", () => {
  const { container } = render(<ModelOptionIcon kind="provider:zhipu" />)
  const box = container.querySelector("span[aria-hidden='true']")
  expect(box).not.toBeNull()
  const className = box?.className ?? ""
  expect(className).toBe("model-picker-icon")
  // 类名存在的判据是它真的带着尺寸约束，而不是只在注释里被提过。
  expect(CSS).toContain(`.${className} {`)
  expect(CSS).toMatch(new RegExp(`\\.${className} :is\\(img, svg\\)`))
})

test("智谱的远程 favicon 被画在受约束的盒子里，不会按原图尺寸铺开", () => {
  const { container } = render(<ModelOptionIcon kind="provider:zhipu" />)
  const image = container.querySelector("span[aria-hidden='true'] > img")
  // 智谱是目录里唯一带 favicon 的供应商；它命中 ProviderMark 的远程图标分支。
  expect(image).not.toBeNull()
  expect(image?.getAttribute("src")).toContain("bigmodel.cn")
  // 真正约束尺寸的是父级的 `.model-picker-icon :is(img, svg)`；子元素自己不带 size-* 类，
  // 所以父级类名必须是对的——上一条断言守的就是这个。
})

test("所有调用点传给图标的类名都在样式表里有定义", () => {
  const offenders: string[] = []
  for (const file of sources(join(process.cwd(), "src"))) {
    const code = readFileSync(file, "utf8")
    // 只匹配 `ModelOptionIcon` 自闭合标签里显式写的 className。
    for (const match of code.matchAll(/<ModelOptionIcon\b[^>]*?\bclassName="([^"]+)"/g)) {
      for (const token of (match[1] ?? "").split(/\s+/).filter(Boolean)) {
        // Tailwind 原子类不算在内：这里只盯自定义布局类。
        if (!CSS.includes(`.${token}`)) offenders.push(`${file}: ${token}`)
      }
    }
  }
  expect(offenders).toEqual([])
})
