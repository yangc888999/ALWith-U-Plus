/** Stage-time fixes for the pinned adapter bundle; fail closed if its implementation changes. */
export function patchAdapter(source: string): string {
  const replace = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error("Adapter patch anchor changed or duplicated")
    source = source.replace(before, after)
  }
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
  return source
}
