import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "vitest"

const styles = readFileSync(join(__dirname, "../../../../index.css"), "utf8")

test("the docked navigation leaves native vibrancy visible", () => {
  expect(styles).toMatch(/\[data-slot="sidebar-wrapper"\]\s*\{\s*background-color:\s*transparent;\s*\}/)
  expect(styles).toMatch(/\n\[data-slot="sidebar"\]\s*\{\s*background-color:\s*transparent;\s*\}/)
  expect(styles).not.toMatch(
    /\n\[data-slot="sidebar"\]\s*\{\s*background-color:\s*color-mix\(in srgb, var\(--sidebar\) 90%, transparent\);\s*\}/
  )
})

test("the floating navigation paints a separate surface over the chat", () => {
  expect(styles).toMatch(
    /\[data-sidebar-mode="floating"\] \[data-slot="sidebar"\]\s*\{\s*background-color:\s*var\(--background\);\s*\}/
  )
})

// 玻璃/雾面档把 --appearance-alpha 乘进底色后，没有自己背景的区域会整片透底——功能屏曾因此
// 变成「两张卡浮在纯黑里」。它必须跟随主题 token 铺一张与主屏相同的表面；纯色档保持 0.4.3
// 的无背景原样（token 本身恒不透明）。
test("the trailing apps screen paints a themed surface in translucent appearance modes", () => {
  expect(styles).toMatch(
    /html:not\(\[data-appearance="solid"\]\) \.main-screen-trailing\s*\{\s*background-color:\s*var\(--background\);\s*\}/
  )
  // 纯色档不得额外铺底色：0.4.3 基线里 .main-screen-trailing 没有任何 background 声明。
  const plainRule = /\.main-screen-trailing\s*\{[^}]*\}/.exec(styles)?.[0] ?? ""
  expect(plainRule).not.toContain("background")
})
