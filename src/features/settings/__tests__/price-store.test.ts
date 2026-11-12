import { describe, expect, test } from "vitest"

import {
  costOf,
  DEFAULT_PRICES,
  DEFAULT_VENDOR_SOURCES,
  isPeak,
  matchesModel,
  parseOpenRouterPrices,
  parseVendorPrices,
  parseWindows
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

describe("built-in snapshot", () => {
  test("merges peak/off-peak rows and keeps native currencies", () => {
    expect(new Set(DEFAULT_PRICES.map((price) => price.vendor)).size).toBe(10)
    const v4 = DEFAULT_PRICES.find((price) => price.model === "deepseek-v4-pro")!
    expect(v4.currency).toBe("CNY")
    expect(v4.offPeak).not.toBeNull()
    expect(DEFAULT_PRICES.filter((price) => price.model === "MiniMax-M3")).toHaveLength(1)
    expect(DEFAULT_PRICES.find((price) => price.model === "gpt-6.1-sol")!.currency).toBe("USD")
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

  test("a configured vendor/model also matches the bare name", () => {
    expect(matchesModel({ ...gpt, model: "openai/gpt-6.1-sol" }, "gpt-6.1-sol")).toBe(true)
    expect(matchesModel({ ...gpt, model: "GPT-6.1-SOL" }, "gpt-6.1-sol")).toBe(true)
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

  test("flat regex extracts one USD row", () => {
    const html = '<tr><td>mimo-v2.6-pro</td><td>$3.00</td><td>$0.025</td><td>$6.00</td></tr>'
    expect(parseVendorPrices(html, DEFAULT_VENDOR_SOURCES["小米 MiMo"].regex)).toEqual([
      { model: "mimo-v2.6-pro", input: 3, cached: 0.025, output: 6 }
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

  test("deduplicates repeated ids", () => {
    const html =
      '<tr><td>mimo-v2.6-pro</td><td>$3</td><td>$0.025</td><td>$6</td></tr>' +
      '<tr><td>mimo-v2.6-pro</td><td>$99</td><td>$99</td><td>$99</td></tr>'
    expect(parseVendorPrices(html, DEFAULT_VENDOR_SOURCES["小米 MiMo"].regex)).toEqual([
      { model: "mimo-v2.6-pro", input: 3, cached: 0.025, output: 6 }
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
