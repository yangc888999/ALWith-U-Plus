import antigravity from "../../src/features/antigravity/catalog.json"

/** Stage-time fixes for the pinned adapter bundle; fail closed if its implementation changes. */
export function patchAdapter(source: string): string {
  const replace = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error("Adapter patch anchor changed or duplicated")
    source = source.replace(before, after)
  }
  const providerRouting = "    this.providerCatalog = new ProviderRouting(Object.fromEntries(Object.entries(this.config).filter((entry) => entry[1] !== undefined)), this.modelProvider);"
  replace(
    providerRouting,
    `${providerRouting}
    if (process.env.ALWITH_U_ANTIGRAVITY_ROUTE === "1" && process.env.ALWITH_U_ROUTER_BASE) {
      const catalog = ${JSON.stringify(antigravity)};
      this.providerCatalog.set({
        providerId: "openai", apiType: "openai", baseUrl: process.env.ALWITH_U_ROUTER_BASE,
        _meta: {
          codex: { id: catalog.id, name: catalog.name, runtimeId: "alwith", mode: "catalog", bearerToken: process.env.ALWITH_U_ROUTER_TOKEN },
          alwith: { models: catalog.models }
        }
      });
      const entries = this.providerCatalog.gateway(catalog.id).catalogEntries;
      for (const model of catalog.models) {
        entries.set(model.id, {
          displayName: model.label, description: catalog.name,
          efforts: catalog.efforts.map((effort) => ({ reasoningEffort: effort, description: effort })),
          defaultEffort: catalog.defaultEffort, inputModalities: ["text", "image"]
        });
      }
    }`
  )
  // A remote marketplace catalog (openai-curated-remote) is ~13.7k plugins and ~37 MB of JSON in a
  // single ACP frame. That frame cannot cross codex → adapter → Runtime → IPC without stalling or
  // dropping the connection, which surfaced as "the engine exits as soon as the OpenAI marketplace
  // is connected". Serve a compact index instead: dropped by default, and when the page asks for it
  // (`includeRemote`), trimmed to the fields the list and search actually read (2026-11-18).
  replace(
    '    const target = CATALOG_METHODS[method];\n    if (!target)\n      throw RequestError.methodNotFound(method);\n    const response = await this.codex.request(target, method === "_codex/account_read" ? { refreshToken: false } : params);',
    `    const target = CATALOG_METHODS[method];
    if (!target)
      throw RequestError.methodNotFound(method);
    let response = await this.codex.request(target, method === "_codex/account_read" ? { refreshToken: false } : params);
    if (method === "_codex/plugin_list" && response !== null && typeof response === "object" && Array.isArray(response.marketplaces)) {
      const includeRemote = params !== null && typeof params === "object" && params.includeRemote === true;
      const compact = (plugin) => ({
        id: plugin.id,
        remotePluginId: plugin.remotePluginId ?? null,
        name: plugin.name,
        installed: plugin.installed === true,
        enabled: plugin.enabled === true,
        installPolicy: plugin.installPolicy,
        availability: plugin.availability,
        interface: plugin.interface === null || plugin.interface === undefined
          ? null
          : {
              displayName: plugin.interface.displayName ?? null,
              shortDescription: plugin.interface.shortDescription ?? null,
              developerName: plugin.interface.developerName ?? null
            }
      });
      const kept = [];
      let skipped = 0;
      let skippedName = null;
      for (const marketplace of response.marketplaces) {
        if (marketplace.path === null) {
          if (!includeRemote) {
            skipped += 1;
            skippedName = skippedName ?? marketplace.name;
            continue;
          }
          kept.push({ ...marketplace, plugins: (marketplace.plugins ?? []).map(compact) });
          continue;
        }
        kept.push(marketplace);
      }
      response = { ...response, marketplaces: kept };
      if (skipped > 0) {
        response.marketplaceLoadErrors = [
          ...(response.marketplaceLoadErrors ?? []),
          { marketplacePath: skippedName ?? "remote", message: "ONLINE_MARKETPLACE_UNLOADED" }
        ];
      }
    }`
  )
  replace(
    '!this.providerCatalog?.hasGateway?.(provider)',
    '!this.codexAcpClient.providerCatalog.hasGateway(provider) && !this.codexAcpClient.providerCatalog.hasRuntime(provider)'
  )
  replace(
    'model_providers: { ...existing, [gateway.runtimeId ?? gateway.id]: entry }',
    'model_providers: { ...existing, [gateway.runtimeId ?? gateway.id]: entry, [gateway.id]: this.routesThroughPeer(gateway) ? { name: gateway.name, base_url: gateway.baseUrl, wire_api: entry.wire_api } : entry }'
  )
  replace(
    '      if (this.providerCatalog.hasGateway(thread.modelProvider)) {\n        return {\n          gatewayId: thread.modelProvider,',
    '      if (this.providerCatalog.hasGateway(thread.modelProvider)) {\n        return {\n          model: this.providerCatalog.upstreamModel(this.providerCatalog.selectionId(thread.model, this.providerCatalog.gatewayForRoutedSlug(thread.model) === thread.modelProvider ? this.providerCatalog.runtimeIdForGateway(thread.modelProvider) : thread.modelProvider)),\n          gatewayId: thread.modelProvider,'
  )
  replace(
    '      state.appServerStartupArgs = [...base, "-c", `model_provider=${JSON.stringify(provider)}`];',
    `      // Old threads retain their logical provider id. Define a process-only alias to the
      // existing local router, never a vendor endpoint or bearer token in startup arguments.
      const catalog = this.codexAcpClient.providerCatalog;
      const gateway = catalog.gateway(provider);
      if (gateway && catalog.routesThroughPeer(gateway)) {
        const endpoint = new URL(gateway.baseUrl);
        if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
          throw new Error("Legacy provider resume requires the local router");
        base.push("-c", \`model_providers.\${provider}=\${toToml({ name: gateway.name, base_url: gateway.baseUrl, wire_api: "responses" })}\`);
      }
      const previousArgs = state.appServerStartupArgs;
      const previousProvider = state.modelProvider;
      state.appServerStartupArgs = [...base, "-c", \`model_provider=\${JSON.stringify(provider)}\`];`
  )
  replace('      const previousArgs = state.appServerStartupArgs;\n      const replacement = await this.restartCodexClient();', '      const replacement = await this.restartCodexClient();')
  replace('        state.appServerStartupArgs = previousArgs;\n        this.recovery.completeReplacement(replacement);', '        state.appServerStartupArgs = previousArgs;\n        state.modelProvider = previousProvider;\n        this.recovery.completeReplacement(replacement);')
  replace(
    '        if (replacement !== null && replacement !== this)\n          return await replacement.resumeThread(params, allowReadOnly, false);',
    `        if (replacement !== null && replacement !== this) {
          const catalog = replacement.providerCatalog;
          const gateway = catalog.gateway(resolution.provider);
          if (gateway && catalog.routesThroughPeer(gateway)) {
            // Resume overrides must use the same provider as the old rollout, with a model
            // qualified for the shared router. Never infer another vendor from a bare slug.
            const { thread } = await replacement.codexClient.threadRead({ threadId: params.threadId });
            const selection = catalog.selectionId(thread.model, catalog.gatewayForRoutedSlug(thread.model) === gateway.id ? gateway.runtimeId : gateway.id);
            const model = catalog.upstreamModel(selection);
            if (!catalog.isGatewayModel(selection)) throw new Error("Legacy session model is unavailable");
            params = { ...params, modelProvider: resolution.provider, model,
              config: { ...params.config, ...catalog.threadConfig(gateway.id),
                model_providers: { ...params.config?.model_providers,
                  ...catalog.threadConfig(gateway.id).model_providers } } };
          }
          return await replacement.resumeThread(params, allowReadOnly, false);
        }`
  )
  replace(
    `    const gatewayOf = (id) => {
      const gatewayId =
        catalog.gatewayIdFor(id) ??
        catalog.gatewayForModelSlug(typeof id === "string" && id.startsWith("gateway:") ? safeUpstreamModel(id) : id) ??
        catalog.gatewayForRoutedSlug(typeof id === "string" ? id : "");
      return gatewayId === null ? null : (catalog.runtimeIdForGateway(gatewayId) ?? gatewayId);
    };
    const target = gatewayOf(model);
    // Gateways that share a runtime id are indistinguishable to Codex, so the model can change
    // without touching the thread. The session's real provider is the authority: a thread written
    // before the router existed still carries its own vendor name and cannot be moved.
    const current = session.authProvider ?? gatewayOf(ModelId.fromString(session.currentModelId).model);`,
    `    // Keep logical identity separate from Codex's shared runtime provider. A different
    // gateway still needs resume overrides (including its thread config) on the same thread.
    const gatewayOf = (id) =>
      catalog.gatewayIdFor(id) ??
      catalog.gatewayForModelSlug(typeof id === "string" && id.startsWith("gateway:") ? safeUpstreamModel(id) : id) ??
      catalog.gatewayForRoutedSlug(typeof id === "string" ? id : "");
    const runtimeOf = (gatewayId) => gatewayId === null ? null : (catalog.runtimeIdForGateway(gatewayId) ?? gatewayId);
    const targetGateway = gatewayOf(model);
    const currentGateway = gatewayOf(ModelId.fromString(session.currentModelId).model);
    const target = runtimeOf(targetGateway);
    // The recorded provider remains authoritative for legacy vendor-pinned threads.
    const current = session.authProvider ?? runtimeOf(currentGateway);`
  )
  replace(
    `    // \`null\` means "no gateway" (a plain model). Two nulls used to compare equal and skip the
    // rebind entirely, which left the thread on its old gateway while the picker already showed
    // the new plain model -- the request then hit that gateway and was rejected as an unsupported
    // model name. Only matching non-null gateways genuinely need no work.
    if (!force && target === current && target !== null)
      return;`,
    `    // Only the same logical gateway on the expected runtime is a no-op. In particular,
    // native alwith -> enterprise and shared-runtime gateway switches must apply target config.
    if (!force && targetGateway !== null && targetGateway === currentGateway && target === current)
      return;`
  )
  replace(
    `          throw RequestError.invalidRequest(undefined, "Session closed during provider selection");
        }
        const authProvider = metadata.modelProvider ?? null;`,
    `          throw RequestError.invalidRequest(undefined, "Session closed during provider selection");
        }
        if (target !== null && metadata.modelProvider !== target)
          throw new Error("Session provider did not match the selected runtime after resume retries");
        const authProvider = metadata.modelProvider ?? null;`
  )
  // Codex's built-in tool registry only knows the current shell tool names. A tool call
  // replayed from an older rollout (or echoed by a model) named `exec` reaches the engine as
  // an unknown tool, and `unified_exec` answers `unsupported call: exec` -- the turn dies
  // before the command ever runs. Normalize on the way out, at the single place tool-call
  // names are produced, and keep the guardian label and session `SOURCES` literals untouched
  // because those `exec` strings are metadata, not tool names.
  replace(
    "function commandToolName(source) {",
    `function normalizeCommandToolName(raw) {
  return raw === "exec" ? "exec_command" : raw;
}
function commandToolName(source) {`
  )
  replace(
    'function functionToolName(name, namespace) {\n  return `${namespace ?? ""}${name}`;\n}',
    'function functionToolName(name, namespace) {\n  const full = `${namespace ?? ""}${name}`;\n  return normalizeCommandToolName(full);\n}'
  )
  // The compatibility proxy relays upstream frames byte-for-byte, so a legacy `exec` name can
  // also arrive inside a streamed Responses frame. Only rewrite the two item types whose name
  // is a tool name; everything else (including raw binary and unrelated text) is passed through
  // unchanged, and the `"exec"` substring pre-check keeps the JSON parse off the hot path.
  replace(
    "class ResponsesProxy {",
    `function normalizeResponsesFrame(raw) {
  if (typeof raw !== "string" || !raw.includes('"exec"'))
    return raw;
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (frame === null || typeof frame !== "object" || Array.isArray(frame))
    return raw;
  const item = frame.item;
  if (item === null || typeof item !== "object" || Array.isArray(item))
    return raw;
  if (item.type !== "function_call" && item.type !== "custom_tool_call")
    return raw;
  if (item.name !== "exec")
    return raw;
  return JSON.stringify({ ...frame, item: { ...item, name: "exec_command" } });
}
function normalizeWsFrame(data) {
  if (typeof data === "string")
    return normalizeResponsesFrame(data);
  const bytes = Buffer.isBuffer(data) ? data : messageBytes(data);
  if (!bytes.includes('"exec"'))
    return data;
  const text = bytes.toString("utf8");
  const normalized = normalizeResponsesFrame(text);
  return normalized === text ? data : normalized;
}
class ResponsesProxy {`
  )
  replace(
    "      downstream.send(data, { binary }, (error) => {",
    "      downstream.send(binary ? data : normalizeWsFrame(data), { binary }, (error) => {"
  )
  return source
}
