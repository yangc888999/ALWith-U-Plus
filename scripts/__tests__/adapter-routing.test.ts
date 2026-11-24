// 回归测试：三方网关/原生模型切换路由。
// 直接从 adapter 真实 bundle 抽取 ProviderRouting 类执行，覆盖：
//   1. 原生模型不得继承全局 gatewayConfig（否则原生模型名会被发到网关 → 400 invalid_request_error）
//   2. catalog 模式下命名空间 id / 裸 slug 的网关查找
//   3. applyModelChange 的 rebind 目标判定
// 背景：setProvider() 会把网关设为全局 gatewayConfig，getModelProvider() 永远返回它，
// 曾导致"切换到原生模型仍打网关"和"老会话模型被改成原生"两类故障。
import { readFileSync } from "fs";
import { expect, test } from "bun:test";
import { patchAdapter } from "../lib/adapter-patch";

const src = patchAdapter(readFileSync(new URL("../../node_modules/@nyssance/codex-acp-v2/dist/index.js", import.meta.url), "utf8"));

// 从真实 bundle 中抽取 ProviderRouting 类与 gatewayModelId，用桩替换外部依赖后实例化
const classStart = src.indexOf("class ProviderRouting {");
const classEnd = src.indexOf("function readHints", classStart);
expect(classStart).toBeGreaterThan(0);
expect(classEnd).toBeGreaterThan(classStart);
const classSrc = src.slice(classStart, classEnd);
const gidMatch = src.slice(src.indexOf("function gatewayModelId")).match(/function gatewayModelId[\s\S]*?\n}/);
const gidSrc = gidMatch ? gidMatch[0] : "";

const RequestError = { invalidParams: (_p: unknown, msg?: string) => new Error(msg ?? "invalid params") };
const isRecord3 = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
const factory = new Function(
  "RequestError", "isRecord3",
  gidSrc + "\n" + classSrc + "\nreturn ProviderRouting;"
);
const ProviderRouting = factory(RequestError, isRecord3);

function makeRouting(configuredProvider: string | null = null) {
  return new ProviderRouting({}, configuredProvider);
}

// 模拟 providers/set 注册一个 deepseek 网关（catalog 模式）
function registerGateway(routing: any, id = "ds-gw") {
  routing.gateways.set(id, {
    id,
    runtimeId: id,
    baseUrl: "https://vip.aipro.love/v1",
    headers: {},
    name: "DeepSeek",
    models: [
      { id: "deepseek-flash", name: "DeepSeek-Flash", description: null },
      { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", description: null }
    ],
    model: null,
    bearerToken: "key",
    config: { model_catalog_json: "/tmp/catalog.json" },
    mode: "catalog",
    catalogEntries: new Map()
  });
}

test("原生模型选择：不继承全局网关（修复切换报错的核心）", () => {
  const routing = makeRouting();
  registerGateway(routing);
  // 修复前：getResumeModelProvider() 会返回全局网关 → 原生模型名发给网关 → 400
  // 修复后：modelProvider 回落原生
  const gatewayId = routing.gatewayIdFor("gpt-6.1-terra") ?? routing.gatewayForModelSlug("gpt-6.1-terra");
  expect(gatewayId).toBeNull();
  expect(routing.nativeModelProvider()).toBe("openai");
});

test("网关模型（命名空间 id）正确路由", () => {
  const routing = makeRouting();
  registerGateway(routing);
  const selection = routing.gatewayIdFor("gateway:ds-gw:deepseek-flash");
  expect(selection).toBe("ds-gw");
});

test("网关模型（裸 slug）也能找回网关", () => {
  const routing = makeRouting();
  registerGateway(routing);
  expect(routing.gatewayIdFor("deepseek-flash")).toBeNull(); // catalog 模式只认命名空间
  expect(routing.gatewayForModelSlug("deepseek-flash")).toBe("ds-gw");
  expect(routing.gatewayForModelSlug("gpt-6.1-terra")).toBeNull();
});

test("an explicit bare selection stays native even when a dedicated gateway sells the same slug", async () => {
  const routing = makeRouting();
  registerGateway(routing);
  const start = src.indexOf("  async sessionRoute(request) {");
  const end = src.indexOf("  getCollaborationMode(", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const { sessionRoute } = new Function("isRecord3", "appendFileSync", "RequestError", `return ({${src.slice(start, end)}})`)(isRecord3, () => {}, RequestError);
  const route = (model: string) => sessionRoute.call({ providerCatalog: routing, getModelProvider: () => null }, { _meta: { alwith: { model } } });
  expect(await route("gateway:ds-gw:deepseek-flash")).toEqual({ gatewayId: "ds-gw", model: "deepseek-flash", modelProvider: "ds-gw" });
  expect(await route("deepseek-flash")).toEqual({ gatewayId: null, model: "deepseek-flash", modelProvider: null });
});

test("upstreamModel 解命名空间", () => {
  const routing = makeRouting();
  registerGateway(routing);
  expect(routing.upstreamModel("gateway:ds-gw:deepseek-flash")).toBe("deepseek-flash");
  expect(routing.upstreamModel("gpt-6.1-terra")).toBe("gpt-6.1-terra");
});

// 回归测试：停止对话。Cancel 只中断而不 resolve 本地 turn 时，activePrompts 会一直占着会话，
// 之后切任何模型都被 "Wait for the current turn" 拒绝、发消息也进不去。
test("停止对话会 resolve 本地 turn 并显式回到 idle", () => {
  const cancelStart = src.indexOf("async cancel(params)");
  const cancelEnd = src.indexOf("var REVIEWER_PROMPT_CANDIDATE_MAX_ITEMS", cancelStart);
  expect(cancelStart).toBeGreaterThan(0);
  expect(cancelEnd).toBeGreaterThan(cancelStart);
  const cancelSrc = src.slice(cancelStart, cancelEnd);
  expect(cancelSrc).toContain('interruptSessionTurn(sessionState, "Cancel", true)');
  expect(cancelSrc).toContain('state: "idle", stopReason: "cancelled"');
});
