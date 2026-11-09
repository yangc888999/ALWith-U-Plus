import { expect, test } from "vitest"

import { describeError, installErrorTextFormatter } from "@/lib/error-text"
import { initI18n } from "@/lib/i18n"

async function chinese(): Promise<void> {
  await initI18n("zh-CN")
  installErrorTextFormatter()
}

test("a router error body is said in Chinese instead of printed as JSON", async () => {
  await chinese()

  const body = '{"error":{"message":"router: model gpt-6-luna names no gateway"}}'

  expect(describeError(new Error(body))).toBe(
    "模型 gpt-6-luna 找不到对应的厂商，这条会话没能切过去。请在模型列表里重新选一次。"
  )
})

test("a missing vendor keeps the vendor's name", async () => {
  await chinese()

  const message = describeError('{"error":{"message":"router: gateway hakimi is not configured"}}')

  expect(message).toContain("hakimi")
  expect(message).not.toContain("router:")
})

test("an unknown failure keeps its sentence, loses the transport prefix and leads in Chinese", async () => {
  await chinese()

  // The engine's own words are what make a bug report actionable, so they stay — behind a
  // localized line, so no screen reads as English-only.
  expect(describeError(new Error("acpRequest: something odd happened"))).toBe("操作没有完成：something odd happened")
  expect(describeError('{"detail":"Input must be a list"}')).toBe("操作没有完成：Input must be a list")
})

test("a rejected overlapping handoff names the remedy instead of raw English", async () => {
  await chinese()

  expect(describeError(new Error("A chat operation is already in progress"))).toBe(
    "另一个窗口操作还在进行，请稍后再试"
  )
})

test("a Drive deadline is not reported as a model timeout", async () => {
  await chinese()

  const message = describeError(new Error("Error: Drive request timed out: archiveStatus after 45000ms"))

  expect(message).toContain("后台服务")
  expect(message).not.toBe("请求超时，请重试。")
})

test("a model catalog refresh timeout is a background failure too", async () => {
  await chinese()

  expect(describeError(new Error("failed to refresh available models: request timed out"))).toContain(
    "后台服务"
  )
})

test("a real model timeout still keeps the retry hint", async () => {
  await chinese()

  expect(describeError(new Error("operation timed out"))).toBe("请求超时，请重试。")
})

test("the chat package formats turn errors through the same table", async () => {
  await chinese()

  const formatter = (globalThis as { __alwithFormatError?: (message: string) => string }).__alwithFormatError

  expect(formatter?.('{"error":{"message":"router: model gpt-6 names no gateway"}}')).toContain("gpt-6")
  expect(formatter?.("plain text")).toBe("操作没有完成：plain text")
})

test("a provider that rejects the model-list key keeps only what the reader can act on", async () => {
  await chinese()

  const rejected = describeError(
    new Error("The provider returned HTTP 401: Incorrect API key provided: sk-abc. You can find your API key at …")
  )
  expect(rejected).toContain("API Key 被拒绝")
  expect(rejected).not.toContain("Incorrect API key")
  expect(rejected).not.toContain("platform.openai.com")

  expect(describeError(new Error("The provider returned HTTP 429: rate limited"))).toContain("请求太频繁")
  expect(describeError(new Error("The provider returned HTTP 503: upstream down"))).toContain("HTTP 503")
  expect(describeError(new Error("The provider returned HTTP 418: teapot"))).toContain("HTTP 418")
})

test("Drive and abort failures are localized instead of leaking English", async () => {
  await chinese()

  const drive = describeError(new Error("Attach to a compatible Drive service before sending requests"))
  expect(drive).toContain("Drive")
  expect(drive).not.toContain("Attach to a compatible")
  expect(describeError(new Error("The operation was aborted."))).toBe("操作已取消。")
  // Tauri's HTTP plugin says this instead of throwing a DOMException. It reached sign-in verbatim
  // after `AbortSignal.timeout(30_000)` gave up on an unreachable account service (2026-11-08).
  expect(describeError(new Error("request canceled"))).toContain("账号服务")
  expect(describeError(new Error("Chat window did not respond"))).toBe("聊天浮窗没有响应，请重试。")
})

test("the runtime's model catalog rejection keeps the id and drops the wall of alternatives", async () => {
  await chinese()

  const message = describeError(
    new Error(
      'model offers gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gateway:hakimi:claude-sonnet-5-5; "gpt-6.1-terra" is not one of them'
    )
  )
  expect(message).toContain("gpt-6.1-terra")
  expect(message).not.toContain("gpt-6-astra")
  expect(message).not.toContain("is not one of them")
})

test("a vendor naming the models it serves does not get blamed on the transcript", async () => {
  await chinese()

  // DeepSeek answered this when a native id was sent to its endpoint. It used to match the
  // `invalid_request` half of the replay rule, so the reader was told their chat history was
  // broken and to start over — about a model that endpoint simply does not have.
  const message = describeError(
    new Error(
      '{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed gpt-6.1-terra. (request_id: 72b0ce48)","type":"invalid_request_error"}}'
    )
  )
  expect(message).toContain("gpt-6.1-terra")
  expect(message).toContain("deepseek-flash")
  expect(message).not.toContain("重放")
  expect(message).not.toContain("新建一条会话")
})

test("a bare invalid_request is not read as an unreplayable history", async () => {
  await chinese()

  // Every gateway words its 400s `invalid_request_error`; only the Responses API's own two
  // sentences mean the transcript itself was refused.
  const generic = describeError(new Error('{"type":"invalid_request_error","message":"bad field"}'))
  expect(generic).not.toContain("重放")

  const replay = describeError(
    new Error("Invalid 'input[3].content': array too long. Expected an array with maximum length 0")
  )
  expect(replay).toContain("重放")
})

test("a rejected reasoning level names the level and points at the setting", async () => {
  await chinese()

  // Qwen / OpenAI-shaped body: the vendor quotes the offending value and lists its own ladder.
  const qwen = describeError(
    new Error(
      `{"request_id":"r1","error":{"type":"InvalidParameter","message":"Invalid 'reasoning.effort': meduim. Supported values are: ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')."}}`
    )
  )
  expect(qwen).toContain("meduim")
  expect(qwen).toContain("默认 Effort")
  expect(qwen).not.toContain("Supported values")

  // DeepSeek answers with a serde variant error rather than a parameter complaint.
  const deepseek = describeError(
    new Error(
      "Failed to deserialize the JSON body into the target type: reasoning.effort: unknown variant `meduim`, expected one of `none`, `minimal` at line 1 column 140 (request_id: 1db2)"
    )
  )
  expect(deepseek).toContain("meduim")
  expect(deepseek).toContain("默认 Effort")
  expect(deepseek).not.toContain("unknown variant")
})

test("the engine's capacity and sign-in sentences are said in Chinese", async () => {
  await chinese()

  const capacity = describeError(new Error("Selected model is at capacity. Please try a different model."))
  expect(capacity).toContain("换一个模型")
  expect(capacity).not.toMatch(/at capacity|different model/i)

  const auth = describeError(new Error("Authentication required"))
  expect(auth).toContain("重新登录")
  expect(auth).not.toMatch(/Authentication required/i)

  const refresh = describeError(
    new Error("auth: Failed to refresh token: Your access token could not be refreshed. Please log out and sign in again.")
  )
  expect(refresh).toContain("重新登录")
  expect(refresh).not.toMatch(/could not be refreshed/i)

  const body = describeError(
    new Error(
      '{"error":{"message":"Could not find the appropriate key in your authentication token. Please try signing in again.","code":"invalid_jwt"}}'
    )
  )
  expect(body).toContain("登录凭证")
  expect(body).not.toMatch(/invalid_jwt|appropriate key/i)

  expect(describeError(new Error("Quota exceeded. Check your plan and billing details."))).toContain("额度")
  expect(describeError(new Error('Runtime request failed (-32603): Internal error'))).toContain("对话服务")
})

test("settings store rejections stay distinguishable from sign-in failures", async () => {
  await chinese()

  const unknown = describeError(new Error("Unknown or private settings key"))
  expect(unknown).toContain("设置项")
  expect(unknown).not.toMatch(/Unknown or private/i)

  const invalid = describeError(new Error("Invalid setting: appearance.fourColumnsDefault"))
  expect(invalid).toContain("appearance.fourColumnsDefault")
  expect(invalid).toContain("不合法")
})

test("the same failures keep their English wording when the UI is in English", async () => {
  await initI18n("en")

  expect(describeError(new Error("Selected model is at capacity. Please try a different model."))).toBe(
    "This model is at capacity right now. Pick another model in the selector below and send again."
  )
  expect(describeError(new Error("Authentication required"))).toBe(
    "Your ChatGPT sign-in has expired. Sign in again from the account menu, then continue."
  )
})

test("a missing internal router is not reported as a vendor the reader deleted", async () => {
  await chinese()

  // The exact 2026-11-07 failure: codex exits 1 because config.toml names the router without
  // defining it. "Restore that provider" would send the reader looking for a setting that has
  // never existed — `alwith` is the app's own loopback router.
  const message = describeError(
    new Error("acpRequest: Codex process has exited with code 1: Error: Model provider `alwith` not found")
  )
  expect(message).not.toContain("恢复该厂商的配置")
  expect(message).toContain("内置路由")
  // Point at a log that actually exists. `adapter-codex.log` never did — the app writes
  // adapter-route.log / adapter-provider.log (verified on the other Mac, 2026-11-08).
  expect(message).toContain("adapter-provider.log")
  expect(message).not.toContain("adapter-codex.log")

  // A real vendor keeps the actionable sentence.
  expect(describeError(new Error("This chat uses model provider “hakimi”, which is no longer configured"))).toContain(
    "hakimi"
  )
})

test("engine file-edit and Drive failures never reach the reader in English", async () => {
  await chinese()

  // The two the reader reported on 2026-11-08 while opening a conversation inside a cloud-synced
  // project folder. Both come from the engine's file checks and used to pass through verbatim,
  // because `describeError` falls back to the raw message when no rule matches.
  const cases: [raw: string, hint: string][] = [
    ["File changed while opening; reopen it", "重新打开"],
    ["This file is read-only or being collaboratively edited", "只读"],
    // Drive's own sentences, which `label()` does not cover because they are thrown, not rendered.
    ["The selected Drive entry no longer exists", "云盘"],
    ["Drive shortcut loop detected", "快捷方式"],
    ["Drive link is unavailable locally and has no web destination", "云盘链接"],
    ["Drive credentials are unavailable", "凭据"],
    ["This path does not belong to an indexed Drive project", "云盘项目"],
    // Protocol assertions collapse into one honest line rather than a dozen English names.
    ["Invalid Drive snapshot", "云盘"],
    ["Pinned documents belong to the main window", "云盘"],
  ]
  for (const [raw, hint] of cases) {
    const message = describeError(new Error(raw))
    expect(message, raw).not.toBe(raw)
    expect(message, raw).toContain(hint)
  }
})

test("the router message is localized whatever quoting the engine uses", async () => {  await chinese()

  // codex-cli 0.167.0 prints single quotes; older builds used backticks; a future one may use
  // double quotes. Matching only backticks let the raw English line reach the window on
  // 2026-11-08, which is the exact text the reader saw in the corner.
  for (const quoted of ["`alwith`", "'alwith'", '"alwith"', "“alwith”"]) {
    const message = describeError(
      new Error(`acpRequest: Codex process has exited with code 1: Error: Model provider ${quoted} not found`)
    )
    expect(message).toContain("内置路由")
    expect(message).not.toContain("Model provider")
  }
})

test("an unparseable config.toml is explained instead of flashing the raw English", async () => {
  await chinese()

  // The other Mac's adapter-provider.log, 2026-11-07: duplicate `model_provider` keys after a
  // [projects.*] table make Codex refuse the file at line 60. The native host repairs it on the
  // next launch, so the reader needs that remedy, not an English stack fragment.
  const message = describeError(
    new Error(
      "failed to load workspace requirements: invalid configuration at /Users/shouhouyangguang/.codex/config.toml:60:1"
    )
  )
  expect(message).not.toContain("failed to load workspace requirements")
  expect(message).toContain("config.toml")
  expect(message).toContain("adapter-provider.log")
  expect(message).not.toContain("adapter-codex.log")

  // Second real shape, measured against codex-cli 0.167.0 with a duplicate key on purpose:
  //   Error loading config.toml:
  //   /tmp/x/config.toml:2:1: duplicate key
  // The first shape comes from the adapter, this one from the engine's own loader. Both must
  // land on the same explanation, and neither may print the raw English block.
  const duplicate = describeError(
    new Error("Error loading config.toml:\n/tmp/x/config.toml:2:1: duplicate key\n  |\n2 | model_provider = \"alwith\"")
  )
  expect(duplicate).not.toContain("duplicate key")
  expect(duplicate).toContain("config.toml")
  expect(duplicate).toContain("adapter-provider.log")
})

test("a model the engine refuses is named instead of printing the raw sentence", async () => {
  await chinese()

  const message = describeError(new Error("Unsupported model: 'gpt-6.1-terra'"))
  expect(message).toContain("gpt-6.1-terra")
  expect(message).not.toContain("Unsupported model")
})
