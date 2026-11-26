import { toast } from "sonner"
import { beforeEach, describe, expect, test, vi } from "vitest"

import type {
  PluginDetail,
  PluginMarketplaceEntry,
  PluginReadResponse,
  PluginSummary,
  SkillMetadata
} from "@nyssance/codex-acp-v2/client"
import { must } from "@/lib/__tests__/must"
import i18n from "@/lib/i18n"

import { createPluginsStore, installParams, type PluginsApi } from "../store"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))

function plugin(id: string, installed: boolean): PluginSummary {
  return {
    id,
    remotePluginId: id,
    version: "1.0.0",
    localVersion: null,
    name: id,
    source: { type: "remote" },
    installed,
    installedAt: null,
    enabled: installed,
    installPolicy: "AVAILABLE",
    availability: "AVAILABLE",
    authPolicy: "ON_USE",
    shareContext: null,
    installPolicySource: null,
    mustShowInstallationInterstitial: false,
    disabledReason: null,
    eligiblePlanTypes: [],
    interface: null,
    keywords: []
  }
}

/** What the adapter sends for an online marketplace entry: only list-card fields survive. */
function compactPlugin(id: string): PluginSummary {
  return {
    id,
    remotePluginId: id,
    name: id,
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    availability: "AVAILABLE",
    interface: { displayName: "Remote compact", shortDescription: "Small payload", developerName: "OpenAI" }
  } as unknown as PluginSummary
}

function skill(path: string, enabled: boolean): SkillMetadata {
  return { name: path, description: "", path, scope: "user", enabled, pluginId: null }
}

function fakeApi(): PluginsApi & { calls: string[]; installed: Set<string> } {
  const installed = new Set<string>(["alpha"])
  const calls: string[] = []
  const catalog: PluginMarketplaceEntry = {
    name: "official",
    path: null,
    interface: null,
    plugins: [plugin("alpha", true), plugin("beta", false)]
  }
  return {
    calls,
    installed,
    listSkills(cwds) {
      return Promise.try(() => {
        calls.push(`skills:${(cwds ?? []).join(",")}`)
        return {
          data: [
            { cwd: "/a", skills: [skill("/home/s1", true), skill("/a/.codex/s2", false)], errors: [] },
            { cwd: "/b", skills: [skill("/home/s1", true)], errors: [{ path: "/b/bad", message: "broken" }] }
          ]
        }
      })
    },
    setSkillEnabled(params) {
      return Promise.try(() => {
        calls.push(`skill:${params.path}:${params.enabled}`)
        return { effectiveEnabled: params.enabled }
      })
    },
    listPlugins() {
      return Promise.resolve({ marketplaces: [catalog], marketplaceLoadErrors: [], featuredPluginIds: [] })
    },
    installedPlugins() {
      return Promise.try(() => {
        return {
          marketplaces: [
            { ...catalog, plugins: catalog.plugins.map((p) => ({ ...p, installed: installed.has(p.id) })) }
          ],
          marketplaceLoadErrors: []
        }
      })
    },
    installPlugin(params) {
      return Promise.try(() => {
        calls.push(`install:${params.pluginName}:${params.remoteMarketplaceName ?? params.marketplacePath}`)
        installed.add(params.pluginName)
        return { authPolicy: "ON_USE", appsNeedingAuth: [] }
      })
    },
    setPluginEnabled(pluginId, enabled) {
      return Promise.try(() => {
        calls.push(`enabled:${pluginId}:${enabled}`)
        const target = catalog.plugins.find((plugin) => plugin.id === pluginId)
        if (!target) throw new Error("Missing fake plugin")
        target.enabled = enabled
        return { enabled }
      })
    },
    uninstallPlugin(pluginId) {
      return Promise.try(() => {
        calls.push(`uninstall:${pluginId}`)
        installed.delete(pluginId)
      })
    },
    readPlugin() {
      return Promise.try(() => {
        throw new Error("readPlugin is not exercised by this fake")
      })
    },
    addMarketplace(params) {
      return Promise.try(() => {
        calls.push(`add:${params.source}`)
        return { marketplaceName: "x", alreadyAdded: false, installedRoot: "/marketplaces/x" }
      })
    },
    removeMarketplace(name) {
      return Promise.try(() => {
        calls.push(`remove:${name}`)
      })
    },
    upgradeMarketplaces() {
      return Promise.try(() => {
        calls.push("upgrade")
        return { errors: [], selectedMarketplaces: [], upgradedRoots: [] }
      })
    }
  }
}

describe("plugins store", () => {
  test("refresh merges skills across cwds by path and indexes installed plugins", async () => {
    const api = fakeApi()
    const store = createPluginsStore(api)
    await store.getState().refresh(["/a", "/b"])
    const state = store.getState()
    expect(state.loading).toBe(false)
    expect(state.skills.map((s) => s.path)).toEqual(["/home/s1", "/a/.codex/s2"])
    expect(state.skillErrors).toEqual([{ path: "/b/bad", message: "broken" }])
    expect(state.installed.map((entry) => entry.plugin.id)).toEqual(["alpha"])
    expect(api.calls[0]).toBe("skills:/a,/b")
  })

  test("refresh completes the compact fields used by the online marketplace", async () => {
    const api = fakeApi()
    const remote = compactPlugin("remote-compact")
    api.listPlugins = vi.fn(async () => ({
      marketplaces: [{ name: "online", path: null, interface: null, plugins: [remote] }],
      marketplaceLoadErrors: [],
      featuredPluginIds: [remote.id]
    }))
    const store = createPluginsStore(api)

    await store.getState().refresh([], { slices: ["marketplace"], includeRemote: true })

    const normalized = store.getState().marketplaces[0]!.plugins[0]!
    expect(normalized.keywords).toEqual([])
    expect(normalized.source).toEqual({ type: "remote" })
    expect(normalized.interface).toMatchObject({
      displayName: "Remote compact",
      capabilities: [],
      screenshots: [],
      screenshotUrls: []
    })
  })

  test("readPlugin fills a compact summary and missing detail collections", async () => {
    const api = fakeApi()
    const remote = compactPlugin("remote-compact")
    api.readPlugin = vi.fn(
      async () =>
        ({
          plugin: {
            summary: remote,
            description: "Remote description",
            skills: undefined,
            hooks: undefined,
            apps: undefined,
            mcpServers: undefined,
            scheduledTasks: undefined
          }
        }) as unknown as PluginReadResponse
    )
    const store = createPluginsStore(api)

    const detail = await store.getState().readPlugin({
      plugin: remote,
      marketplace: { name: "online", path: null, interface: null, plugins: [remote] }
    })

    expect(detail.summary.keywords).toEqual([])
    expect(detail.summary.interface?.screenshots).toEqual([])
    expect(detail.skills).toEqual([])
    expect(detail.hooks).toEqual([])
    expect(detail.apps).toEqual([])
    expect(detail.mcpServers).toEqual([])
    expect(detail.scheduledTasks).toBeNull()
  })

  test("install targets the marketplace by path or remote name and refreshes", async () => {
    const api = fakeApi()
    const store = createPluginsStore(api)
    await store.getState().refresh([])
    const remote = store.getState().marketplaces[0]
    await store.getState().install({ plugin: plugin("beta", false), marketplace: remote })
    expect(api.calls).toContain("install:beta:official")
    expect(store.getState().installed.find((entry) => entry.plugin.id === "beta")?.plugin.installed).toBe(true)
    expect(store.getState().busyIds).toEqual({})
    expect(
      installParams({ plugin: plugin("z", false), marketplace: { ...remote, path: "/m/marketplace.json" } })
    ).toEqual({
      installAttemptId: expect.any(String) as string,
      marketplacePath: "/m/marketplace.json",
      pluginName: "z"
    })
  })

  test("uninstall drops the plugin from installed", async () => {
    const api = fakeApi()
    const store = createPluginsStore(api)
    await store.getState().refresh([])
    await store.getState().uninstall(plugin("alpha", true))
    expect(api.calls).toContain("uninstall:alpha")
    expect(store.getState().installed.find((entry) => entry.plugin.id === "alpha")).toBeUndefined()
  })

  test("remote uninstall uses the backend ID while tracking loading by the catalog ID", async () => {
    const api = fakeApi()
    const store = createPluginsStore(api)
    await store.getState().refresh()
    const target = { ...plugin("alpha", true), remotePluginId: "plugin_supabase" }
    api.uninstallPlugin = vi.fn((id) => {
      return Promise.try(() => {
        expect(id).toBe("plugin_supabase")
        expect(store.getState().busyIds).toEqual({ alpha: "uninstalling" })
        expect(store.getState().upgrading).toBe(false)
        api.installed.delete("alpha")
      })
    })
    await store.getState().uninstall(target)
    expect(store.getState().installed).toEqual([])
    expect(store.getState().busyIds).toEqual({})
    expect(toast.success).toHaveBeenCalledOnce()
  })

  test("local uninstall keeps its catalog ID even when remote metadata is present", async () => {
    const api = fakeApi()
    const store = createPluginsStore(api)
    await store.getState().refresh()
    await store.getState().uninstall({
      ...plugin("alpha", true),
      source: { type: "local", path: "/plugins/alpha" },
      remotePluginId: "plugin_alpha"
    })
    expect(api.calls).toContain("uninstall:alpha")
    expect(store.getState().installed).toEqual([])
  })

  test("uninstall does not report success when the refreshed catalog still contains the plugin", async () => {
    const api = fakeApi()
    api.uninstallPlugin = vi.fn().mockResolvedValue(undefined)
    const store = createPluginsStore(api)
    await store.getState().refresh()
    await store.getState().uninstall(plugin("alpha", true))
    expect(store.getState().installed).toHaveLength(1)
    expect(store.getState().busyIds).toEqual({})
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledOnce()
  })

  test("remote uninstall refuses a missing backend ID instead of falling through to local uninstall", async () => {
    const api = fakeApi()
    const store = createPluginsStore(api)
    await store.getState().refresh()
    await store.getState().uninstall({ ...plugin("alpha", true), remotePluginId: null })
    expect(api.calls.filter((call) => call.startsWith("uninstall:"))).toEqual([])
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledOnce()
  })

  test("skill toggle is optimistic and settles on Codex's effective state", async () => {
    const api = fakeApi()
    const store = createPluginsStore(api)
    await store.getState().refresh([])
    const target = must(
      store.getState().skills.find((s) => s.path === "/a/.codex/s2"),
      "the s2 skill"
    )
    await store.getState().setSkillEnabled(target, true)
    expect(api.calls).toContain("skill:/a/.codex/s2:true")
    expect(store.getState().skills.find((s) => s.path === "/a/.codex/s2")?.enabled).toBe(true)
  })
})

beforeEach(() => vi.resetAllMocks())

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("remote app aliases use the service ID for install and read; local sources keep the name", async () => {
  const target = { ...plugin("app-alias", false), remotePluginId: "plugin_asdk_app_actual" }
  const marketplace: PluginMarketplaceEntry = {
    name: "openai-curated-remote",
    path: null,
    interface: null,
    plugins: [target]
  }
  expect(installParams({ plugin: target, marketplace })).toMatchObject({
    pluginName: target.remotePluginId,
    remoteMarketplaceName: marketplace.name
  })
  const detail: PluginDetail = {
    marketplaceName: marketplace.name,
    marketplacePath: null,
    summary: target,
    shareUrl: null,
    description: null,
    skills: [],
    hooks: [],
    apps: [],
    mcpServers: [],
    scheduledTasks: null
  }
  const api = fakeApi()
  api.readPlugin = vi.fn(() => Promise.resolve({ plugin: detail }))
  const store = createPluginsStore(api)
  expect(await store.getState().readPlugin({ plugin: target, marketplace })).toEqual(detail)
  expect(api.readPlugin).toHaveBeenCalledWith({
    pluginName: target.remotePluginId,
    remoteMarketplaceName: marketplace.name
  })
  expect(
    installParams({ plugin: target, marketplace: { ...marketplace, path: "/local/marketplace.json" } })
  ).toMatchObject({ pluginName: target.name, marketplacePath: "/local/marketplace.json" })
})

test.each(["install", "uninstall", "upgrade"] as const)(
  "%s waits for the refreshed snapshot and clears its own busy state before success",
  async (action) => {
    const api = fakeApi()
    const store = createPluginsStore(api)
    await store.getState().refresh()
    const refresh = deferred<Awaited<ReturnType<PluginsApi["listPlugins"]>>>()
    const snapshot = await api.listPlugins()
    api.listPlugins = vi.fn(() => refresh.promise)
    vi.mocked(toast.success).mockImplementation(() => {
      expect(store.getState().busyIds).toEqual({})
      expect(store.getState().upgrading).toBe(false)
      expect(store.getState().loading).toBe(false)
      return "toast"
    })
    const operation =
      action === "install"
        ? store.getState().install({ plugin: plugin("beta", false), marketplace: snapshot.marketplaces[0] })
        : action === "uninstall"
          ? store.getState().uninstall(plugin("alpha", true))
          : store.getState().upgradeAll()
    await vi.waitFor(() => expect(api.listPlugins).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    expect(store.getState().upgrading).toBe(action === "upgrade")
    expect(store.getState().loading).toBe(false)
    if (action !== "upgrade") expect(Object.keys(store.getState().busyIds)).toHaveLength(1)
    refresh.resolve(snapshot)
    await operation
    expect(toast.success).toHaveBeenCalledOnce()
  }
)

test("plugin toggles settle on the refreshed state and failures roll back without a second write", async () => {
  const api = fakeApi()
  const store = createPluginsStore(api)
  await store.getState().refresh()
  store.getState().installed[0].plugin.remotePluginId = "plugin_supabase"
  const toggle = vi.spyOn(api, "setPluginEnabled")
  await store.getState().setPluginEnabled(store.getState().installed[0].plugin, false)
  expect(store.getState().installed[0].plugin.enabled).toBe(false)
  expect(toggle).toHaveBeenCalledWith("alpha", false, "plugin_supabase")
  store.getState().installed[0].plugin.remotePluginId = "plugin_supabase"
  const request = deferred<{ enabled: boolean }>()
  api.setPluginEnabled = vi.fn(() => request.promise)
  const target = store.getState().installed[0].plugin
  const operation = store.getState().setPluginEnabled(target, true)
  expect(store.getState().installed[0].plugin.enabled).toBe(true)
  await store.getState().setPluginEnabled(target, false)
  expect(api.setPluginEnabled).toHaveBeenCalledOnce()
  request.resolve({ enabled: true })
  await operation
  api.setPluginEnabled = vi.fn().mockRejectedValue(new Error("read-only"))
  await store.getState().setPluginEnabled(store.getState().installed[0].plugin, true)
  expect(store.getState().installed[0].plugin.enabled).toBe(false)
  expect(store.getState().busyIds).toEqual({})
  expect(toast.error).toHaveBeenCalled()
})

test.each([true, false])(
  "plugin toggle to %s announces success only after refresh and loading end",
  async (enabled) => {
    const api = fakeApi()
    const store = createPluginsStore(api)
    await store.getState().refresh()
    const target = store.getState().installed[0].plugin
    const refresh = deferred<Awaited<ReturnType<PluginsApi["listPlugins"]>>>()
    const snapshot = await api.listPlugins()
    api.listPlugins = vi.fn(() => refresh.promise)
    vi.mocked(toast.success).mockImplementation(() => {
      expect(store.getState().busyIds).toEqual({})
      expect(store.getState().installed[0].plugin.enabled).toBe(enabled)
      return "toast"
    })
    const operation = store.getState().setPluginEnabled(target, enabled)
    await vi.waitFor(() => expect(api.listPlugins).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    refresh.resolve(snapshot)
    await operation
    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      i18n.t(enabled ? "plugins.toast.enabled" : "plugins.toast.disabled", { pluginName: "alpha" })
    )
  }
)

test("plugin toggle with mismatched readback reports failure and preserves the actual state", async () => {
  const api = fakeApi()
  api.setPluginEnabled = vi.fn().mockResolvedValue({ enabled: false })
  const store = createPluginsStore(api)
  await store.getState().refresh()
  await store.getState().setPluginEnabled(store.getState().installed[0].plugin, false)
  expect(store.getState().installed[0].plugin.enabled).toBe(true)
  expect(store.getState().busyIds).toEqual({})
  expect(toast.success).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledOnce()
})

test("refresh coalesces notifications and does not expose an obsolete scope", async () => {
  const api = fakeApi()
  const first = deferred<Awaited<ReturnType<PluginsApi["listPlugins"]>>>()
  const snapshot = await api.listPlugins()
  api.listPlugins = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(snapshot)
  const store = createPluginsStore(api)
  const a = store.getState().refresh(["/a"])
  const b = store.getState().refresh(["/b"], { background: true, forceRefetch: true })
  const notification = store.getState().refresh(undefined, { background: true })
  expect(notification).toBe(b)
  expect(a).toBe(b)
  first.resolve({ ...snapshot, marketplaces: [] })
  await b
  expect(api.listPlugins).toHaveBeenCalledTimes(2)
  expect(api.listPlugins).toHaveBeenLastCalledWith({ cwds: ["/b"], forceRefetch: true })
  expect(store.getState().cwds).toEqual(["/b"])
  expect(store.getState().marketplaces).toEqual(snapshot.marketplaces)
})

test("a failed post-mutation refresh clears loading and does not announce success", async () => {
  const api = fakeApi()
  const store = createPluginsStore(api)
  await store.getState().refresh()
  api.listPlugins = vi.fn().mockRejectedValue(new Error("offline"))
  await store.getState().upgradeAll()
  expect(store.getState().upgrading).toBe(false)
  expect(store.getState().loading).toBe(false)
  expect(store.getState().error).toBe("offline")
  expect(toast.success).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalled()
})

test("skill toggles serialize per path and failures restore the prior state", async () => {
  const api = fakeApi()
  const store = createPluginsStore(api)
  await store.getState().refresh()
  const target = store.getState().skills[0]
  const pending = deferred<{ effectiveEnabled: boolean }>()
  api.setSkillEnabled = vi.fn(() => pending.promise)
  const request = store.getState().setSkillEnabled(target, !target.enabled)
  expect(store.getState().busySkills[target.path]).toBe(true)
  await store.getState().setSkillEnabled(target, target.enabled)
  expect(api.setSkillEnabled).toHaveBeenCalledOnce()
  pending.resolve({ effectiveEnabled: target.enabled })
  await request
  expect(store.getState().skills.find((item) => item.path === target.path)?.enabled).toBe(target.enabled)
  expect(store.getState().busySkills).toEqual({})
  expect(toast.success).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledOnce()
  api.setSkillEnabled = vi.fn().mockRejectedValue(new Error("read only"))
  await store.getState().setSkillEnabled(target, !target.enabled)
  expect(store.getState().skills.find((item) => item.path === target.path)?.enabled).toBe(target.enabled)
  expect(store.getState().busySkills).toEqual({})
})

test("skills retain all repository memberships while the installed summary deduplicates paths", async () => {
  const api = fakeApi()
  const shared = { ...skill("/repo/.agents/skills/shared/SKILL.md", true), scope: "repo" as const }
  const user = skill("/home/.agents/skills/personal/SKILL.md", false)
  api.listSkills = vi.fn().mockResolvedValue({
    data: [
      { cwd: "/repo/a", skills: [user, shared], errors: [] },
      { cwd: "/repo/b", skills: [user, shared], errors: [] }
    ]
  })
  const store = createPluginsStore(api)
  await store.getState().refresh(["/repo/a", "/repo/b"])
  expect(store.getState().skills).toHaveLength(2)
  expect(store.getState().skillProjects).toEqual({ "/repo/a": [shared.path], "/repo/b": [shared.path] })
  api.listSkills = vi.fn().mockResolvedValue({ data: [{ cwd: "/other", skills: [user], errors: [] }] })
  await store.getState().refresh(["/other"])
  expect(store.getState().skillProjects).toEqual({})
  expect(store.getState().skills).toEqual([user])
})

test("a failed refresh reports the error and never rebuilds the connection", async () => {
  const api = fakeApi()
  const store = createPluginsStore(api)
  api.listPlugins = vi.fn().mockRejectedValue(new Error("acpRequest: agent codex exited"))
  await store.getState().refresh(["/a"])
  expect(store.getState().error).toBe("acpRequest: agent codex exited")
  expect(store.getState().loading).toBe(false)
  // loadedScopes stay unset: the page's effect keys off them, and a failure must not look loaded.
  expect(store.getState().loadedScopes).toEqual({ skills: null, marketplace: null, installed: null })
  // A second refresh (the reader's Retry) asks again; still no connection surgery from the store.
  api.listPlugins = vi.fn().mockRejectedValue(new Error("acpRequest: agent codex exited"))
  await store.getState().refresh(["/a"])
  expect(store.getState().error).toBe("acpRequest: agent codex exited")
})

test("a sliced refresh touches one catalog and leaves the other scopes unset", async () => {
  const fake = fakeApi()
  const installedPlugins = vi.fn(fake.installedPlugins)
  const listSkills = vi.fn(fake.listSkills)
  const listPlugins = vi.fn(fake.listPlugins)
  const api = { ...fake, installedPlugins, listSkills, listPlugins }
  const store = createPluginsStore(api)
  await store.getState().refresh(["/a"], { slices: ["installed"] })
  expect(installedPlugins).toHaveBeenCalledTimes(1)
  expect(listSkills).not.toHaveBeenCalled()
  expect(listPlugins).not.toHaveBeenCalled()
  expect(store.getState().loadedScopes).toEqual({ skills: null, marketplace: null, installed: '["/a"]' })
  // A second slice fills in on its own; the installed scan is not repeated.
  await store.getState().refresh(["/a"], { slices: ["skills"] })
  expect(listSkills).toHaveBeenCalledTimes(1)
  expect(installedPlugins).toHaveBeenCalledTimes(1)
  expect(store.getState().loadedScopes).toEqual({ skills: '["/a"]', marketplace: null, installed: '["/a"]' })
})
