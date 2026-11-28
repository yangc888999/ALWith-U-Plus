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

test("the solid dark theme is charcoal, not a pure-black slab", () => {
  const dark = /\.dark\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ""
  expect(dark).toContain("--foreground: #d2d2d2")
  expect(dark).toContain("--background: color-mix(in srgb, #1f1f1f")
  expect(dark).not.toContain("--foreground: oklch(0.985")

  const solid = /html\.dark\[data-appearance="solid"\]\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ""
  expect(solid).toContain("--background: #1f1f1f")
  expect(solid).toContain("--sidebar: #1b1b1b")
  expect(solid).not.toContain("--background: #000")
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

// 玻璃/雾面档的「控件色」必须和底色用同一根透明度系数。`--muted` 是输入区卡面
// （`--chat-input-bg-color` 在深色档取它）、按钮与 chip 的填充：它若漏乘 alpha，透明度拉满时
// 页面已经透成桌面，输入区却仍是 64% 的深色板 —— 用户看到的就是「上面和输入框下面两种背景色」。
test("every glass mode scales secondary/muted/accent with the transparency factor", () => {
  const blocks = [
    /html\[data-appearance="liquid-glass"\]:not\(\.dark\)\s*\{([^}]*)\}/,
    /html\[data-appearance="liquid-glass"\]\.dark\s*\{([^}]*)\}/,
    /html\[data-appearance="aero"\]:not\(\.dark\)\s*\{([^}]*)\}/,
    /html\[data-appearance="aero"\]\.dark\s*\{([^}]*)\}/
  ]
  for (const block of blocks) {
    const body = block.exec(styles)?.[1] ?? ""
    expect(body).not.toBe("")
    for (const token of ["secondary", "muted", "accent"]) {
      const declaration = new RegExp(`--${token}:[^;]*;`).exec(body)?.[0] ?? ""
      expect(declaration).toContain("var(--appearance-alpha, 1)")
    }
  }
})

test("floating menus and panels share a readable transparency-controlled surface", () => {
  const blocks = [
    /html\[data-appearance="liquid-glass"\]:not\(\.dark\)\s*\{([^}]*)\}/,
    /html\[data-appearance="liquid-glass"\]\.dark\s*\{([^}]*)\}/,
    /html\[data-appearance="aero"\]:not\(\.dark\)\s*\{([^}]*)\}/,
    /html\[data-appearance="aero"\]\.dark\s*\{([^}]*)\}/
  ]
  for (const block of blocks) {
    const body = block.exec(styles)?.[1] ?? ""
    expect(body).toContain("--overlay-alpha: calc(")
    expect(body).toMatch(/--popover:\s*oklch\([^;]*\/ var\(--overlay-alpha\)/)
  }
  expect(styles).toMatch(
    /html\[data-appearance="liquid-glass"\][\s\S]*?\[data-appearance-surface="overlay"\][\s\S]*?background-color:\s*var\(--popover\);/
  )
  expect(styles).toContain('[data-appearance-surface="overlay"]')
  expect(styles).toContain('[data-slot="popover-content"]')
  expect(styles).not.toMatch(/\[data-slot="popover"\]/)
  expect(styles).toMatch(
    /\[data-wallpaper="active"\]\s*:is\(\s*\[data-slot="popover-content"\],[\s\S]*?background-color:\s*var\(--popover\);/
  )
  const translucentSettingsRule =
    /\[data-wallpaper="active"\] \.settings-card\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--card\) 96%, transparent\)/.exec(styles)?.[0] ?? ""
  expect(translucentSettingsRule).toContain('.settings-card')
  expect(translucentSettingsRule).not.toContain('[data-slot="popover"]')
  expect(styles).not.toContain('--popover: oklch(0.995 0.006 240 / 0.92)')
  expect(styles).not.toContain('--popover: oklch(0.22 0.014 250 / 0.94)')
})

test("the frosted composer borrows the card material instead of an opaque slab", () => {
  // The old 97%-opaque charcoal fill made the input read as a grey rectangle pasted over the
  // glass page. The frosted modes must reuse the appearance-aware --card token and add blur.
  const tokenRule =
    /html:is\(\[data-appearance="aero"\], \[data-appearance="liquid-glass"\]\)\s*\{([^}]*)\}/.exec(styles)?.[1] ??
    ""
  expect(tokenRule).toContain("--composer-surface: var(--card)")
  expect(tokenRule).toContain("--composer-surface-alpha: 1")

  const glassCard =
    /html:is\(\[data-appearance="aero"\], \[data-appearance="liquid-glass"\]\)\s*\n?\s*\[data-composer\][\s\S]*?\{([^}]*)\}/.exec(
      styles
    )?.[1] ?? ""
  expect(glassCard).toContain("backdrop-filter: blur(22px)")
  expect(glassCard).toContain("inset 0 1px 0")
  expect(styles).toMatch(
    /html:is\(\[data-appearance="aero"\], \[data-appearance="liquid-glass"\]\):not\(\.dark\)[\s\S]*?background-image: linear-gradient\(180deg, oklch\(1 0 0 \/ 0\.38\)/
  )
})

test("frosted accents adapt in both light and dark appearances", () => {
  expect(styles).toMatch(
    /html\[data-appearance="aero"\]:not\(\.dark\)\s*\{[^}]*--settings-accent:\s*color-mix/
  )
  expect(styles).toMatch(/html\[data-appearance="aero"\]\.dark\s*\{[^}]*--settings-accent:\s*color-mix/)
})
