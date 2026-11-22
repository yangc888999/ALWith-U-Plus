import { expect, test } from "vitest"

import { pinCheckedFreeModels } from "../free-model-order"

test("checked free models are pinned first and both groups keep their original order", () => {
  const rows = [
    { api_id: "paid/a", enabled: true },
    { api_id: "free/unchecked", enabled: false },
    { api_id: "paid/b", enabled: false },
    { api_id: "free/checked-1", enabled: true },
    { api_id: "paid/c", enabled: true },
    { api_id: "free/checked-2", enabled: true }
  ]
  expect(pinCheckedFreeModels(rows, (id) => id.startsWith("free/")).map((row) => row.api_id)).toEqual([
    "free/checked-1",
    "free/checked-2",
    "paid/a",
    "free/unchecked",
    "paid/b",
    "paid/c"
  ])
})
