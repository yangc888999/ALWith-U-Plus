// The usage charts are hand-drawn SVG, so the hover values are the only reading a line gives:
// without the panel a curve says "more or less" and never "how much".
import { fireEvent, render, screen } from "@testing-library/react"
import { expect, test } from "vitest"

import { GroupLines, Spark, StackedBars } from "../usage-charts"
import type { GroupSeries } from "../usage-data"

const series: GroupSeries = {
  groups: [
    { key: "a", label: "model-a", total: 30 },
    { key: "b", label: "model-b", total: 20 }
  ],
  buckets: [
    { key: "2026-11-01", label: "11/01", values: [10, 5] },
    { key: "2026-11-02", label: "11/02", values: [20, 15] }
  ],
  max: 35
}
const format = (value: number): string => String(value)

test("hovering a line bucket names every group's value and the total", () => {
  const { container } = render(<GroupLines series={series} formatValue={format} totalLabel="Total" />)
  const columns = container.querySelectorAll("[data-usage-bucket]")
  expect(columns).toHaveLength(2)
  fireEvent.mouseEnter(columns[1]!)

  const panel = screen.getByRole("tooltip")
  expect(panel).toHaveTextContent("11/02")
  expect(panel).toHaveTextContent("model-a")
  expect(panel).toHaveTextContent("model-b")
  expect(panel).toHaveTextContent("20")
  expect(panel).toHaveTextContent("15")
  // The stack's total for that bucket, not just the individual lines.
  expect(panel).toHaveTextContent("35")

  fireEvent.mouseLeave(columns[0]!.parentElement!)
  expect(screen.queryByRole("tooltip")).toBeNull()
})

test("time lines are smoothed cubic curves instead of jagged polylines", () => {
  const { container } = render(<GroupLines series={series} formatValue={format} totalLabel="Total" />)
  const paths = container.querySelectorAll("svg path[d]")
  expect(paths).toHaveLength(2)
  for (const path of paths) expect(path.getAttribute("d")).toContain("C")
  expect(container.querySelector("polyline")).toBeNull()
})

test("the overview sparkline uses the same smoothing", () => {
  const { container } = render(<Spark values={[1, 5, 3, 8, 4]} />)
  expect(container.querySelector("path")?.getAttribute("d")).toContain("C")
  expect(container.querySelector("polyline")).toBeNull()
})

test("bars show the same panel for the column under the pointer", () => {
  const { container } = render(<StackedBars series={series} formatValue={format} totalLabel="Total" />)
  const columns = container.querySelectorAll("[data-usage-bucket]")
  fireEvent.mouseEnter(columns[0]!)

  const panel = screen.getByRole("tooltip")
  expect(panel).toHaveTextContent("11/01")
  expect(panel).toHaveTextContent("10")
  expect(panel).toHaveTextContent("15")

  fireEvent.mouseLeave(columns[0]!.parentElement!)
  expect(screen.queryByRole("tooltip")).toBeNull()
})
