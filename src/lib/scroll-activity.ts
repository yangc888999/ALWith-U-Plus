/**
 * 滚动条只在滚动时出现（macOS overlay 行为）。
 *
 * 背景：`index.css` 为了统一尺寸给 `::-webkit-scrollbar` 定了宽度和 thumb 颜色，这会让
 * Chromium 从「滚动才浮现的 overlay 条」退化成「常驻的 classic 条」。设置页右侧那条细长的
 * 灰轨就是这么一直挂着的——它挡住内容边缘，也让整页显得脏。
 *
 * 做法：`scroll` 不冒泡，但用 capture 能在 document 上收到所有元素（含嵌套容器）的滚动。
 * 给正在滚的那个元素打 `data-scrolling="true"`，停下 900ms 后摘掉；CSS 里只有带这个属性
 * 的元素才画出 thumb，其余时间 thumb 透明但仍占位（不产生布局跳动）。
 *
 * 例外：编辑器与代码块的滚动条保持常驻（`[data-scroll-always]`），长文档编辑时读者需要知道
 * 自己在文中的位置。
 */
const STOP_DELAY = 900
const timers = new WeakMap<Element, number>()

function mark(target: EventTarget | null): void {
  if (!(target instanceof Element)) return
  target.setAttribute("data-scrolling", "true")
  const previous = timers.get(target)
  if (previous !== undefined) window.clearTimeout(previous)
  timers.set(
    target,
    window.setTimeout(() => {
      target.removeAttribute("data-scrolling")
      timers.delete(target)
    }, STOP_DELAY)
  )
}

let installed = false

/** Idempotent: every window entry calls this once. */
export function installScrollActivity(): void {
  if (installed || typeof document === "undefined") return
  installed = true
  // `passive` keeps wheel scrolling off the main thread's critical path.
  document.addEventListener("scroll", (event) => mark(event.target), { capture: true, passive: true })
}
