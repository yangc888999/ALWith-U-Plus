import { describe, expect, test } from "vitest"

import {
  blankPrice,
  canonicalVendor,
  costOf,
  customModelName,
  customModelVendor,
  DEFAULT_PRICES,
  DEFAULT_USD_TO_CNY,
  DEFAULT_UTC_OFFSET,
  DEFAULT_VENDOR_SOURCES,
  findPrice,
  guessVendor,
  isPeak,
  matchesModel,
  mergeVendorAliases,
  migratePriceState,
  modelMatchKey,
  modelPriceKey,
  parseOpenRouterPrices,
  parseNonWorkdays,
  parseVendorPrices,
  parseWindows,
  displayModelName
} from "../price-store"

const deepseek = DEFAULT_PRICES.find((price) => price.model === "deepseek-flash")!
const gpt = DEFAULT_PRICES.find((price) => price.model === "gpt-6.1-sol")!

function bucket(date: string, hour: number, model: string, input: number) {
  return { date, hour, model, input, cached: 0, output: 0 }
}

describe("peak windows", () => {
  test("parses comma separated HH:MM ranges", () => {
    expect(parseWindows("09:00-12:00,14:00-18:00")).toEqual([
      [540, 720],
      [840, 1080]
    ])
    expect(parseWindows("")).toEqual([])
    expect(parseWindows("nonsense")).toEqual([])
  })

  test("weekday 09:00 Beijing is peak, lunch break is not", () => {
    // 2026-11-03 is a Tuesday. UTC 01:00 → 09:00 Beijing.
    expect(isPeak("2026-11-03", 1, deepseek, 8)).toBe(true)
    // UTC 05:00 → 13:00 Beijing, between the two windows.
    expect(isPeak("2026-11-03", 5, deepseek, 8)).toBe(false)
    // UTC 06:00 → 14:00 Beijing.
    expect(isPeak("2026-11-03", 6, deepseek, 8)).toBe(true)
  })

  test("weekends are always off-peak", () => {
    // 2026-11-07 is a Saturday.
    expect(isPeak("2026-11-07", 1, deepseek, 8)).toBe(false)
  })
})

describe("non-workday calendar", () => {
  test("expands single dates and closed ranges", () => {
    const days = parseNonWorkdays("2026-10-01~2026-10-03, 2026-10-05")
    expect([...days]).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05"])
  })

  test("statutory holidays are off-peak all day even inside a weekday peak window", () => {
    const holiday = { ...deepseek, nonWorkdays: "2026-10-01~2026-10-07" }
    // 2026-10-01 09:00 Beijing (Thursday): normally peak, holiday makes it off-peak.
    expect(isPeak("2026-10-01", 1, holiday, 8)).toBe(false)
    // The next Thursday is back to the normal weekday peak window.
    expect(isPeak("2026-10-08", 1, holiday, 8)).toBe(true)
  })
})

describe("built-in snapshot", () => {
  test("merges peak/off-peak rows and keeps native currencies", () => {
    expect(new Set(DEFAULT_PRICES.map((price) => price.vendor)).size).toBe(10)
    const v4 = DEFAULT_PRICES.find((price) => price.model === "deepseek-v4-pro")!
    expect(v4.currency).toBe("CNY")
    expect(v4.offPeak).not.toBeNull()
    expect(DEFAULT_PRICES.filter((price) => price.model === "MiniMax-M3")).toHaveLength(1)
    expect(DEFAULT_PRICES.find((price) => price.model === "gpt-6.1-sol")!.currency).toBe("USD")
    expect(DEFAULT_PRICES.find((price) => price.model === "gpt-6.2-sol")).toMatchObject({
      input: 2,
      cached: 0.1,
      output: 10
    })
    expect(DEFAULT_PRICES.find((price) => price.model === "gpt-6.2-astra")).toMatchObject({
      input: 8,
      cached: 0.4,
      output: 40
    })
  })

  test("the OpenRouter group carries real routed prices, not zero placeholders", () => {
    const group = DEFAULT_PRICES.filter((price) => price.vendor === "OpenRouter")
    expect(group).toHaveLength(6)
    for (const price of group) {
      expect(price.model).toContain("/")
      expect(price.currency).toBe("USD")
      // A zero quote would be counted as an unpriced model by costOf, silently dropping spend.
      expect(price.input).toBeGreaterThan(0)
      expect(price.output).toBeGreaterThan(0)
      expect(price.note).not.toBe("")
    }
    // The 更新 button must be able to refresh all six rows from the official catalog.
    expect(DEFAULT_VENDOR_SOURCES.OpenRouter.openrouter).toContain(",")
    expect(DEFAULT_VENDOR_SOURCES.OpenRouter.url).toContain("openrouter.ai")
  })
})

describe("costOf", () => {
  test("RMB vendors use the off-peak tier outside peak hours", () => {
    // Peak: 2 CNY per 1M input tokens.
    expect(costOf(bucket("2026-11-03", 1, "deepseek-flash", 1_000_000), DEFAULT_PRICES, 7.2, 8)).toBeCloseTo(2)
    // Off-peak (13:00 Beijing): 1 CNY per 1M input tokens.
    expect(costOf(bucket("2026-11-03", 5, "deepseek-flash", 1_000_000), DEFAULT_PRICES, 7.2, 8)).toBeCloseTo(1)
  })

  test("USD vendors are converted with the configured rate", () => {
    // gpt-6.1-sol: 2 USD per 1M input tokens → 14.4 CNY at 7.2.
    expect(costOf(bucket("2026-11-03", 5, "gpt-6.1-sol", 1_000_000), DEFAULT_PRICES, 7.2, 8)).toBeCloseTo(14.4)
    expect(costOf(bucket("2026-11-03", 5, "gpt-6.1-sol", 1_000_000), DEFAULT_PRICES, 7, 8)).toBeCloseTo(14)
  })

  test("unpriced models return null instead of zero", () => {
    expect(costOf(bucket("2026-11-03", 5, "some-local-model", 1_000_000), DEFAULT_PRICES, 7.2, 8)).toBeNull()
  })

  test("an all-zero placeholder row is unpriced, not a zero-cost model", () => {
    // A freshly added row or the OpenRouter group must not inflate the matched-model count.
    const placeholder = { ...gpt, model: "moonshotai/kimi-k3", input: 0, cached: 0, output: 0, offPeak: null }
    expect(costOf(bucket("2026-11-03", 5, "kimi-k3", 1_000_000), [placeholder], 7.2, 8)).toBeNull()
    // Filling any one price makes it a real (cheap) model again. The bucket only carries input.
    expect(costOf(bucket("2026-11-03", 5, "kimi-k3", 1_000_000), [{ ...placeholder, input: 1 }], 7.2, 8)).toBeGreaterThan(0)
  })

  test("an explicitly free model costs zero instead of counting as unpriced", () => {
    // Free is a price, not a missing one: an empty row would otherwise be reported as 未定价 and
    // inflate that list forever.
    const free = { ...blankPrice("OpenRouter"), model: "vendor/free-model", free: true }
    expect(costOf(bucket("2026-11-03", 5, "free-model", 1_000_000), [free], 7.2, 8)).toBe(0)
    expect(costOf(bucket("2026-11-03", 5, "free-model", 1_000_000), [{ ...free, free: false }], 7.2, 8)).toBeNull()
  })

  test("a configured vendor/model also matches the bare name", () => {
    expect(matchesModel({ ...gpt, model: "openai/gpt-6.1-sol" }, "gpt-6.1-sol")).toBe(true)
    expect(matchesModel({ ...gpt, model: "GPT-6.1-SOL" }, "gpt-6.1-sol")).toBe(true)
  })

  test("price aliases cover the labels and suffixes the usage ledger reports", () => {
    expect(modelPriceKey("6.2 Sol")).toBe(modelPriceKey("gpt-6.2-sol"))
    expect(modelPriceKey("6.2 Astra")).toBe(modelPriceKey("gpt-6.2-astra"))
    expect(modelPriceKey("flash")).toBe(modelPriceKey("deepseek-v4.1-flash"))
    expect(modelPriceKey("deepseek-v4.1-flash-1017")).toBe(modelPriceKey("deepseek-flash"))
    expect(modelPriceKey("deepseek-v4.1-flash-enterprise")).toBe(modelPriceKey("deepseek-v4.1-flash"))
  })

  test("findPrice never lets a zero placeholder shadow a priced row", () => {
    const priced = DEFAULT_PRICES.find((price) => price.model === "gpt-6.2-sol")!
    const placeholder = { ...blankPrice("OpenAI"), model: "6.2 Sol" }
    expect(findPrice([placeholder, priced], "gpt-6.2-sol")).toBe(priced)
  })

  test("a flat discount reduces the charged amount by the fraction off", () => {
    // gpt-6.1-sol: 2 USD/M input → 14.4 CNY at 7.2; a 20% discount brings it to 11.52.
    const discounted = { ...gpt, discount: 0.2 }
    expect(costOf(bucket("2026-11-03", 5, "gpt-6.1-sol", 1_000_000), [discounted], 7.2, 8)).toBeCloseTo(11.52)
    // No discount keeps the full list price.
    expect(costOf(bucket("2026-11-03", 5, "gpt-6.1-sol", 1_000_000), [gpt], 7.2, 8)).toBeCloseTo(14.4)
  })

  test("a discount applies on top of the off-peak tier, not just the standard one", () => {
    // DeepSeek flash off-peak (13:00 Beijing): 1 CNY/M input. A 50% discount halves it to 0.5.
    const offPeakDiscount = { ...deepseek, discount: 0.5 }
    expect(costOf(bucket("2026-11-03", 5, "deepseek-flash", 1_000_000), [offPeakDiscount], 7.2, 8)).toBeCloseTo(0.5)
    // And in peak hours the standard 2 CNY/M tier is halved to 1.
    expect(costOf(bucket("2026-11-03", 1, "deepseek-flash", 1_000_000), [offPeakDiscount], 7.2, 8)).toBeCloseTo(1)
  })

  test("a discount outside 0–1 is ignored so a stray value cannot negate or inflate cost", () => {
    const bogus = { ...gpt, discount: 5 }
    expect(costOf(bucket("2026-11-03", 5, "gpt-6.1-sol", 1_000_000), [bogus], 7.2, 8)).toBeCloseTo(14.4)
  })
})

describe("parseVendorPrices", () => {
  const deepseekHtml = [
    '<tr><td colspan="3" style="text-align:center">模型</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro</td></tr>',
    '<tr><td rowspan="2">百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.02元</td><td>0.15元</td></tr>',
    '<tr><td>高峰时段</td><td>0.04元</td><td>0.30元</td></tr>',
    '<tr><td rowspan="2">百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>4.5元</td></tr>',
    '<tr><td>高峰时段</td><td>2元</td><td>9.0元</td></tr>',
    '<tr><td rowspan="2">百万tokens输出</td><td>空闲时段</td><td>4元</td><td>13.5元</td></tr>',
    '<tr><td>高峰时段</td><td>8元</td><td>27.0元</td></tr>'
  ].join("")

  test("DeepSeek regex pulls the two peak-price rows", () => {
    expect(parseVendorPrices(deepseekHtml, DEFAULT_VENDOR_SOURCES.DeepSeek.regex)).toEqual([
      { model: "deepseek-flash", input: 2, cached: 0.04, output: 8 },
      { model: "deepseek-v4-pro", input: 9, cached: 0.3, output: 27 }
    ])
  })

  test("GLM docs regex extracts the three tracked rows and skips the -Legal variant", () => {
    // The live table: 模型名称 | 上下文 | 输入 | 输出 | 缓存存储 | 缓存命中. The `-Legal` row
    // shares the GLM-5.3-FlashX prices, so anchoring on `<td>1M</td>` right after the name is
    // what keeps it out of the result.
    const html =
      '<tr><td>GLM-5.3</td><td data-numeric="true">1M</td><td data-numeric="true">8</td><td data-numeric="true">28</td><td>限时免费</td><td data-numeric="true">2</td><td>文本</td></tr>' +
      '<tr><td>GLM-5.3-Flash</td><td data-numeric="true">1M</td><td data-numeric="true">0.8</td><td data-numeric="true">2.8</td><td>限时免费</td><td data-numeric="true">0.23</td><td>图片、视频、文件、文本</td></tr>' +
      '<tr><td>GLM-5.3-FlashX</td><td data-numeric="true">1M</td><td data-numeric="true">2</td><td data-numeric="true">7</td><td>限时免费</td><td data-numeric="true">0.57</td><td>图片、视频、文件、文本</td></tr>' +
      '<tr><td>GLM-5.3-FlashX-Legal</td><td data-numeric="true">1M</td><td data-numeric="true">2</td><td data-numeric="true">7</td><td>限时免费</td><td data-numeric="true">0.57</td><td></td></tr>'
    expect(parseVendorPrices(html, DEFAULT_VENDOR_SOURCES["智谱 GLM"].regex)).toEqual([
      { model: "GLM-5.3", input: 8, cached: 2, output: 28 },
      { model: "GLM-5.3-Flash", input: 0.8, cached: 0.23, output: 2.8 },
      { model: "GLM-5.3-FlashX", input: 2, cached: 0.57, output: 7 }
    ])
  })

  test("OpenAI rows regex extracts the embedded row array", () => {
    // The live page embeds `[0,"model"],[0,in],[0,cache],[0,write],[0,out]`, HTML-escaped.
    const html =
      '<script>{"rows":[1,[[1,[[0,&quot;gpt-6-astra&quot;],[0,10],[0,1],[0,12.5],[0,50]]],[1,[[0,&quot;gpt-6.1-sol&quot;],[0,2],[0,0.1],[0,2.5],[0,10]]]]]}</script>'
    expect(parseVendorPrices(html, DEFAULT_VENDOR_SOURCES.OpenAI.regex)).toEqual([
      { model: "gpt-6-astra", input: 10, cached: 1, output: 50 },
      { model: "gpt-6.1-sol", input: 2, cached: 0.1, output: 10 }
    ])
  })

  test("MiniMax tiered M3 row matches through the badge and <del> list prices, deduped", () => {
    // M3's rows put `<br/>≤ 512k 输入 tokens <span>永久五折</span>` inside the name cell and a
    // `<del>list</del>` before each number; the >512k tier repeats the model id, so the fold in
    // `push` keeps only the first (base tier) row.
    const html =
      '<tr><td><strong>MiniMax-M3</strong><br/>≤ 512k 输入 tokens <span class="mint-tag">永久五折</span></td><td data-numeric="true"><del>4.20</del> 2.10</td><td data-numeric="true"><del>16.80</del> 8.40</td><td data-numeric="true"><del>0.84</del> 0.42</td></tr>' +
      '<tr><td><strong>MiniMax-M3</strong><br/>&gt; 512k 输入 tokens* <span class="mint-tag">永久五折</span></td><td data-numeric="true"><del>8.40</del> 4.20</td><td data-numeric="true"><del>33.60</del> 16.80</td><td data-numeric="true"><del>1.68</del> 0.84</td></tr>'
    expect(parseVendorPrices(html, DEFAULT_VENDOR_SOURCES.MiniMax.regex)).toEqual([
      { model: "MiniMax-M3", input: 2.1, cached: 0.42, output: 8.4 }
    ])
  })

  test("empty result throws so a bad regex can never wipe a vendor", () => {
    expect(() => parseVendorPrices("<p>nothing here</p>", DEFAULT_VENDOR_SOURCES.OpenAI.regex)).toThrow(
      /matched no models/
    )
  })

  test("Kimi rows regex extracts model + three ¥/MTok prices", () => {
    const html =
      "rows:[[_jsx(_components.a,{href:`/guide/kimi-k3-1-pro-quickstart`,children:`kimi-k3.1-pro`}),`¥13.00 / MTok`,`¥68.00 / MTok`,`¥1.30 / MTok`,`¥13.00 / MTok`,`¥26.00 / MTok`]]"
    expect(parseVendorPrices(html, DEFAULT_VENDOR_SOURCES.Kimi.regex)).toEqual([
      { model: "kimi-k3.1-pro", input: 13, cached: 1.3, output: 68 }
    ])
  })

  test("Qwen billing regex extracts input/output and leaves cached unset", () => {
    const html =
      '<p>qwen3.8-max</p></td><td><p>0&lt;Token≤1M</p></td><td><p>12<span class="help-letter-space"></span>元</p></td><td><p>36<span class="help-letter-space"></span>元</p></td>'
    expect(parseVendorPrices(html, DEFAULT_VENDOR_SOURCES["千问 Qwen"].regex)).toEqual([
      { model: "qwen3.8-max", input: 12, output: 36 }
    ])
  })

  test("MiniMax table regex extracts input/output/cache", () => {
    const html =
      '<tr><td><strong>MiniMax-M3.1-Flash</strong></td><td data-numeric="true">1.00</td><td data-numeric="true">4.00</td><td data-numeric="true">0.10</td></tr>'
    expect(parseVendorPrices(html, DEFAULT_VENDOR_SOURCES.MiniMax.regex)).toEqual([
      { model: "MiniMax-M3.1-Flash", input: 1, cached: 0.1, output: 4 }
    ])
  })

  test("invalid regex throws", () => {
    expect(() => parseVendorPrices("anything", "(")).toThrow(/invalid regex/)
  })
})

describe("parseOpenRouterPrices", () => {
  test("filters by prefix, scales per-token to per-1M, skips variants and other vendors", () => {
    const json = JSON.stringify({
      data: [
        {
          id: "anthropic/claude-opus-5.5",
          pricing: { prompt: "0.000004", completion: "0.00002", input_cache_read: "0.0000004" }
        },
        { id: "anthropic/claude-opus-5.5:batch", pricing: { prompt: "0.000002", completion: "0.00001" } },
        { id: "openai/gpt-6.1-sol", pricing: { prompt: "0.000002", completion: "0.00001" } }
      ]
    })
    expect(parseOpenRouterPrices(json, "anthropic")).toEqual([
      { model: "claude-opus-5.5", input: 4, cached: 0.4, output: 20 }
    ])
  })

  test("a non-JSON body throws instead of silently wiping a vendor", () => {
    expect(() => parseOpenRouterPrices("<html>nope</html>", "anthropic")).toThrow(/not JSON/)
  })

  test("a prefix with no models throws", () => {
    const json = JSON.stringify({ data: [{ id: "openai/gpt-6.1-sol", pricing: { prompt: "1", completion: "2" } }] })
    expect(() => parseOpenRouterPrices(json, "anthropic")).toThrow(/no anthropic models/)
  })

  test("a comma-separated prefix list keeps full ids and covers several vendors", () => {
    const json = JSON.stringify({
      data: [
        { id: "moonshotai/kimi-k3", pricing: { prompt: "0.000002", completion: "0.00001" } },
        { id: "x-ai/grok-4.6", pricing: { prompt: "0.000001", completion: "0.000005" } },
        { id: "x-ai/grok-4.6:free", pricing: { prompt: "0", completion: "0" } },
        { id: "openai/gpt-6.1-sol", pricing: { prompt: "0.000002", completion: "0.00001" } }
      ]
    })
    expect(parseOpenRouterPrices(json, "moonshotai, x-ai")).toEqual([
      { model: "moonshotai/kimi-k3", input: 2, output: 10 },
      { model: "x-ai/grok-4.6", input: 1, output: 5 }
    ])
  })
})

describe("model id matching", () => {
  test("dots and dashes fold together, so the ledger id and the saved row agree", () => {
    // Vendors quote `claude-opus-5.5` while the table says `claude-opus-5-5`; pricing must use the
    // same fold as the vendor updater, or a used model reads as unpriced.
    expect(matchesModel({ ...gpt, model: "claude-opus-5-5" }, "claude-opus-5.5")).toBe(true)
    expect(matchesModel({ ...gpt, model: "GPT-6.1-SOL" }, "gpt-6-1-sol")).toBe(true)
    // A vendor-qualified row still matches the bare ledger id after folding.
    expect(matchesModel({ ...gpt, model: "openai/gpt-6.1-sol" }, "gpt-6-1-sol")).toBe(true)
    // Different models never collide.
    expect(matchesModel({ ...gpt, model: "gpt-6.1-sol" }, "gpt-6.1-terra")).toBe(false)
    expect(matchesModel({ ...gpt, model: "" }, "gpt-6.1-sol")).toBe(false)
  })

  test("a blank inserted row keeps the built-in shape and stays unpriced until numbers are typed", () => {
    const row = blankPrice("DeepSeek")
    expect(row).toMatchObject({
      vendor: "DeepSeek",
      model: "",
      label: "",
      free: false,
      currency: "CNY",
      input: 0,
      cached: 0,
      output: 0,
      offPeak: null,
      peakWindows: "",
      weekdaysOnly: false,
      note: ""
    })
    const inserted = { ...row, model: "deepseek-V4.1-flash" }
    // All-zero prices are not a price: the model stays in the unpriced list.
    expect(costOf(bucket("2026-11-13", 3, "deepseek-V4.1-flash", 1000), [inserted], 7.2, 8)).toBeNull()
    // The id matches regardless of the dot/dash spelling the transcript used.
    expect(matchesModel(inserted, "deepseek-v4-1-flash")).toBe(true)
    expect(costOf(bucket("2026-11-13", 3, "deepseek-V4.1-flash", 1_000_000), [{ ...inserted, input: 2 }], 7.2, 8)).toBe(2)
  })

  test("a renamed row still matches on its id", () => {
    // The display name is cosmetic: renaming a row must not detach it from the ledger id.
    const renamed = { ...gpt, model: "gpt-6.1-sol", label: "我的主力模型" }
    expect(matchesModel(renamed, "gpt-6.1-sol")).toBe(true)
    expect(costOf(bucket("2026-11-03", 5, "gpt-6.1-sol", 1_000_000), [renamed], 7, 8)).toBeCloseTo(14)
  })

  test("an unpriced model is grouped under the vendor its id implies", () => {
    expect(guessVendor("deepseek-V4.1-flash")).toBe("DeepSeek")
    // The guess must land in the curated table's own group — "Anthropic" next to "Claude" (or
    // "Qwen" next to "千问 Qwen") would split one vendor into two cards, one without a source.
    expect(guessVendor("claude-opus-5.5")).toBe("Claude")
    expect(guessVendor("qwen4-max-preview")).toBe("千问 Qwen")
    expect(guessVendor("GLM-5.3")).toBe("智谱 GLM")
    expect(guessVendor("some-unknown-model")).toBe("其他")
  })

  test("custom gateway ids use the Finture vendor and bare model name", () => {
    const id = "custom-637573746f6d5f616c776974685f656e74657270726973655f61363936363261613965643062613732663735656635313166383663366132643965636438616561613634356565373636333230613832303734396461333439/deepseek-V4.1-flash"
    expect(customModelName(id)).toBe("deepseek-V4.1-flash")
    expect(customModelVendor(id)).toBe("Finture")
    expect(displayModelName(id)).toBe("deepseek-V4.1-flash")
    expect(guessVendor(id)).toBe("Finture")
    expect(modelMatchKey(id)).toBe(modelMatchKey("deepseek-V4.1-flash"))
  })

  test("provider-catalog names fold onto the price table's vendor groups", () => {
    expect(canonicalVendor("Qwen")).toBe("千问 Qwen")
    expect(canonicalVendor("Anthropic")).toBe("Claude")
    expect(canonicalVendor("GLM")).toBe("智谱 GLM")
    // A custom provider keeps its own name — only known aliases fold.
    expect(canonicalVendor("某网关")).toBe("某网关")
    expect(canonicalVendor("千问 Qwen")).toBe("千问 Qwen")
  })
})

describe("mergeVendorAliases", () => {
  test("a duplicate Qwen card folds into 千问 Qwen and keeps the priced row", () => {
    const prices = [
      { ...blankPrice("千问 Qwen"), model: "qwen3.8-max", input: 12, cached: 1.5, output: 36, currency: "CNY" as const },
      // The auto-add path used to mint this second card from the provider catalog's "Qwen" name.
      { ...blankPrice("Qwen"), model: "qwen4-max-preview", input: 0, cached: 0, output: 0 },
      // Same folded id under both spellings: the priced row survives, the empty one drops.
      { ...blankPrice("Qwen"), model: "qwen3.8-max", input: 0, cached: 0, output: 0 }
    ]
    const merged = mergeVendorAliases(prices, DEFAULT_VENDOR_SOURCES)
    expect(merged.prices).toHaveLength(2)
    expect(merged.prices.every((price) => price.vendor === "千问 Qwen")).toBe(true)
    const max = merged.prices.find((price) => price.model === "qwen3.8-max")!
    expect(max.input).toBe(12)
    // The merged card keeps the canonical price source (the aliyun billing page).
    expect(merged.sources["千问 Qwen"].url).toContain("aliyun")
    expect(merged.sources.Qwen).toBeUndefined()
    // Idempotent: a second pass changes nothing.
    const again = mergeVendorAliases(merged.prices, merged.sources)
    expect(again.prices).toEqual(merged.prices)
  })

  test("a custom vendor with its own source is not folded away", () => {
    const prices = [{ ...blankPrice("某网关"), model: "gateway-model", input: 1, cached: 0, output: 1 }]
    const sources = { ...DEFAULT_VENDOR_SOURCES, 某网关: { url: "https://example.com/prices", regex: "", currency: "USD" as const } }
    const merged = mergeVendorAliases(prices, sources)
    expect(merged.prices[0].vendor).toBe("某网关")
    expect(merged.sources["某网关"].url).toBe("https://example.com/prices")
  })
})

describe("migratePriceState", () => {
  test("a persisted vendor-source map from the upstream app is replaced wholesale", () => {
    // The upstream app shares this bundle id, so its localStorage can arrive with the old
    // platform.openai.com URL and a flat model-list regex — exactly the state that produced the
    // "自动更新不对" report (gpt-6.1-sol updated to 0 / 2 / 0). v5 must ignore the stored map.
    const stale = {
      prices: DEFAULT_PRICES,
      usdToCny: 7.1,
      utcOffset: 8,
      vendorSources: {
        OpenAI: {
          url: "https://platform.openai.com/docs/pricing",
          currency: "USD",
          regex: "(?<model>gpt-6-astra|gpt-6.1-sol)[\\s\\S]{0,600}?(?<input>\\d+(?:\\.\\d+)?)"
        }
      },
      updatedAt: null
    }
    const migrated = migratePriceState(stale)
    expect(migrated.vendorSources.OpenAI.url).toBe(DEFAULT_VENDOR_SOURCES.OpenAI.url)
    expect(migrated.vendorSources.OpenAI.regex).toBe(DEFAULT_VENDOR_SOURCES.OpenAI.regex)
    // User settings and the curated numbers survive — only the source map resets.
    expect(migrated.usdToCny).toBe(7.1)
    expect(migrated.prices).toEqual(stale.prices)
  })

  test("v6 folds an persisted alias vendor card into its canonical group", () => {
    const stale = {
      prices: [
        ...DEFAULT_PRICES,
        { ...blankPrice("Qwen"), model: "qwen4-max-preview", input: 0, cached: 0, output: 0 }
      ],
      usdToCny: 7.2,
      utcOffset: 8,
      vendorSources: { Qwen: { url: "", regex: "", currency: "CNY" } },
      updatedAt: null
    }
    const migrated = migratePriceState(stale)
    const preview = migrated.prices.find((price) => price.model === "qwen4-max-preview")
    expect(preview?.vendor).toBe("千问 Qwen")
    expect(migrated.vendorSources.Qwen).toBeUndefined()
    expect(migrated.vendorSources["千问 Qwen"].url).toContain("aliyun")
  })

  test("v7 normalizes persisted custom gateway rows into Finture", () => {
    const customId = "custom-example/deepseek-V4.1-flash"
    const migrated = migratePriceState({
      prices: [{ ...blankPrice("DeepSeek"), model: customId, input: 1, cached: 0, output: 2 }],
      vendorSources: {},
      updatedAt: null
    })
    const row = migrated.prices.find((price) => price.model === "deepseek-V4.1-flash")
    expect(row?.vendor).toBe("Finture")
    expect(row?.input).toBe(1)
    expect(migrated.prices.some((price) => price.model === customId)).toBe(false)
  })

  test("v8 fills placeholder rows from the curated prices and maps aliases", () => {
    const migrated = migratePriceState({
      prices: [
        { ...blankPrice("OpenAI"), model: "gpt-6.2-sol" },
        { ...blankPrice("OpenAI"), model: "gpt-6.2-astra" },
        { ...blankPrice("千问 Qwen"), model: "deepseek-v4.1-flash-1017" },
        { ...blankPrice("其他"), model: "flash" }
      ],
      vendorSources: {},
      updatedAt: null
    })
    const sol = migrated.prices.find((price) => price.model === "gpt-6.2-sol")!
    const astra = migrated.prices.find((price) => price.model === "gpt-6.2-astra")!
    const deepseekFlash = migrated.prices.find((price) => price.model === "deepseek-v4.1-flash-1017")!
    const bareFlash = migrated.prices.find((price) => price.model === "flash")!
    expect(sol).toMatchObject({ input: 2, cached: 0.1, output: 10, currency: "USD" })
    expect(astra).toMatchObject({ input: 8, cached: 0.4, output: 40, currency: "USD" })
    expect(deepseekFlash).toMatchObject({ input: 2, cached: 0.04, output: 8, currency: "CNY" })
    expect(bareFlash).toMatchObject({ input: 2, cached: 0.04, output: 8, currency: "CNY", vendor: "DeepSeek" })
    expect(bareFlash.label).toBe("DeepSeek V4.1 Flash")
  })

  test("v9 fills the holiday calendar on an already-priced DeepSeek row", () => {
    const migrated = migratePriceState({
      prices: [{ ...deepseek, nonWorkdays: "" }],
      vendorSources: {},
      updatedAt: null
    })
    const row = migrated.prices.find((price) => price.model === "deepseek-flash")
    expect(row?.nonWorkdays).toContain("2026-10-01~2026-10-07")
  })

  test("a fresh (versionless) state still gets the full default source map", () => {
    const migrated = migratePriceState(undefined)
    expect(migrated.vendorSources).toEqual(DEFAULT_VENDOR_SOURCES)
    // v6 folds aliases, which rebuilds the array — the content is what must survive.
    expect(migrated.prices).toEqual(DEFAULT_PRICES)
    expect(migrated.usdToCny).toBe(DEFAULT_USD_TO_CNY)
    expect(migrated.utcOffset).toBe(DEFAULT_UTC_OFFSET)
    expect(migrated.updatedAt).toBeNull()
  })
})
