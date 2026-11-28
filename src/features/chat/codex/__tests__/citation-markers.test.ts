import { expect, test } from "vitest"

import { CitationStreamFilter, withoutCitationMarkers } from "@/lib/citation-markers"

const marker = (refs: string): string =>
  `\uE200cite${refs
    .split(",")
    .map((ref) => `\uE202${ref}`)
    .join("")}\uE201`

test("internal citation markers are removed without touching the answer", () => {
  const text = `已实测成功。${marker("turn0search0,turn0search2")}\n\n- 样例图：daily.png`

  expect(withoutCitationMarkers(text)).toBe("已实测成功。\n\n- 样例图：daily.png")
})

test("a citation marker that is still streaming is hidden until it closes", () => {
  expect(withoutCitationMarkers(`答复${marker("turn0search0").slice(0, -1)}`)).toBe("答复")
})

test("ordinary prose that mentions cite or a reference id is left alone", () => {
  expect(withoutCitationMarkers("Please cite the source; turn0search0 is only a tool id.")).toBe(
    "Please cite the source; turn0search0 is only a tool id."
  )
})

test("other private-use markers are not treated as citations", () => {
  const other = "\uE200visualize\uE202chart\uE201"
  expect(withoutCitationMarkers(other)).toBe(other)
})

test("a citation marker split across streamed chunks leaves no tail", () => {
  const filter = new CitationStreamFilter()
  expect(filter.push("answer \uE200ci")).toBe("answer ")
  expect(filter.push("te\uE202turn0sea")).toBe("")
  expect(filter.push("rch0\uE201 done")).toBe(" done")
  filter.flush()
})

test("a streamed non-citation marker is preserved when the prefix resolves", () => {
  const filter = new CitationStreamFilter()
  expect(filter.push("text \uE200")).toBe("text ")
  expect(filter.push("visualize\uE202chart\uE201")).toBe("\uE200visualize\uE202chart\uE201")
  filter.flush()
})
