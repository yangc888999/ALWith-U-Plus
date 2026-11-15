// QA 独立边界探针（③ 聊天输入框侧）—— v1.0.3 发布关卡。只新增测试代码，不改任何源码。
//
// 覆盖两处「自动（内置默认）」/ 全关边界：
//   * 首启草稿里 `api_id: ""` 的「跟随引擎内置默认」哨兵必须保留（它不是模型清单）；
//   * 用户明确把「供应商与可用模型」全关后，③ 不得把会话推荐子集（Astra/Sol）放回。
//
// 后者与 model-options-boundary.qa.test.ts 的 QA-B2 是同一场景的 ③ 视角：③ 正确为空时，
// ①②④ 若仍列出引擎目录模型，就证明「四处共用同一出口」的铁律被破坏。

import { expect, test, vi } from "vitest"

import type { CustomModel } from "@/lib/providers"

const saved = vi.hoisted(() => ({ rows: null as CustomModel[] | null }))
vi.mock("@/lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers")>()
  return { ...actual, nativeModelOverrides: () => saved.rows }
})

const { presentModelCatalog } = await import("../model-catalog")

type Groups = Parameters<typeof presentModelCatalog>[0]

/** 草稿期会话目录：只有「跟随引擎内置默认」占位行，不是模型清单。 */
const AUTO_SENTINEL: Groups = [{ id: "chatgpt", name: "ChatGPT", models: [{ api_id: "", label: "ChatGPT" }] }]

/** live session 的「推荐模型集」预设子集，只有 Astra / Sol。 */
const SESSION_SUBSET: Groups = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    models: [
      { api_id: "gpt-6-astra", label: "Astra" },
      { api_id: "gpt-6.1-sol", label: "Sol" }
    ]
  }
]

test('QA-B7 首启草稿：自动（内置默认）哨兵 api_id:"" 保留，不产生第二套清单', () => {
  saved.rows = null
  const groups = presentModelCatalog(AUTO_SENTINEL, null)
  expect(groups.map((group) => group.id)).toEqual(["chatgpt"])
  expect(groups[0].models.map((model) => model.api_id)).toEqual([""])
})

test("QA-B8 用户明确全关：③ 不把会话推荐子集放回，候选为空", () => {
  saved.rows = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"].map(
    (id) => ({ api_id: id, label: id, enabled: false }) as CustomModel
  )
  const groups = presentModelCatalog(SESSION_SUBSET, null)
  expect(groups).toEqual([])
})
