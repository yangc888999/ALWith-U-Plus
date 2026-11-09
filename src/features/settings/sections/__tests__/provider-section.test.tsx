import { act, fireEvent, render, within } from "@testing-library/react"
import { useState } from "react"
import { beforeAll, beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"
import { ALL_PROVIDERS, type ProviderSnapshot } from "@/lib/providers"
import type { SettingsAccount } from "@/lib/settings-bridge"

import { CodexAccountSummary } from "../codex-provider-section"
import { CustomProviderEditor, ProviderRow, ProviderTabs, retryOnRevisionConflict } from "../provider-section"

beforeAll(async () => {
  await initI18n("en")
})

beforeEach(() => {
  // The native panel now remembers the model-list token; each test starts without one.
  localStorage.clear()
})
const provider = ALL_PROVIDERS.find((item) => item.id === "qwen")
if (!provider) throw new Error("Qwen provider fixture missing")
const openrouter = ALL_PROVIDERS.find((item) => item.id === "openrouter")
if (!openrouter) throw new Error("OpenRouter provider fixture missing")
function snapshot(revision: number, region = "intl"): ProviderSnapshot {
  return {
    revision,
    appliedRevision: revision,
    status: "applied",
    error: null,
    customProviders: [],
    builtInModels: {}, managedProviders: [],
    providers: { qwen: { configured: true, disabled: false, region, base_url: null } }
  }
}

const saveModels = vi.fn(() => Promise.try(() => []))

test("an untouched row follows loaded regions and submits the revision it displayed", async () => {
  const save = vi.fn(() => Promise.try(() => snapshot(3)))
  const view = render(
    <ProviderRow
      provider={provider}
      saved={{ configured: true, disabled: false, region: "cn", base_url: null }}
      revision={1}
      busy={false}
      models={[]}
      onSave={save}
      onSaveModels={saveModels}
    />
  )
  view.rerender(
    <ProviderRow
      provider={provider}
      saved={{ configured: true, disabled: false, region: "intl", base_url: null }}
      revision={2}
      busy={false}
      models={[]}
      onSave={save}
      onSaveModels={saveModels}
    />
  )
  await act(() => {
    return Promise.try(() => {
      view.getByLabelText("API key").focus()
      fireEvent.input(view.getByLabelText("API key"), { target: { value: "new-key" } })
      fireEvent.keyUp(view.getByLabelText("API key"), { key: "a" })
    })
  })
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Save connection" }))
    })
  })
  expect(save.mock.calls[0]).toEqual([2, { apiKey: "new-key", region: "intl" }])
  expect((view.getByLabelText("API key") as HTMLInputElement).value).toBe("")
  await act(() => {
    return Promise.try(() => {
      view.getByLabelText("API key").focus()
      fireEvent.input(view.getByLabelText("API key"), { target: { value: "after-ack" } })
      fireEvent.keyUp(view.getByLabelText("API key"), { key: "a" })
    })
  })
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Save connection" }))
    })
  })
  expect(save.mock.calls[1]).toEqual([3, { apiKey: "after-ack", region: "intl" }])
})

test("a dirty row keeps its loaded revision across another window's save and retains a rejected draft", async () => {
  const save = vi.fn(() => Promise.resolve(null))
  const view = render(
    <ProviderRow
      provider={provider}
      saved={{ configured: true, disabled: false, region: "cn", base_url: null }}
      revision={1}
      busy={false}
      models={[]}
      onSave={save}
      onSaveModels={saveModels}
    />
  )
  await act(() => {
    return Promise.try(() => {
      view.getByLabelText("API key").focus()
      fireEvent.input(view.getByLabelText("API key"), { target: { value: "draft-key" } })
      fireEvent.keyUp(view.getByLabelText("API key"), { key: "a" })
    })
  })
  view.rerender(
    <ProviderRow
      provider={provider}
      saved={{ configured: true, disabled: false, region: "intl", base_url: null }}
      revision={2}
      busy={false}
      models={[]}
      onSave={save}
      onSaveModels={saveModels}
    />
  )
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Save connection" }))
    })
  })
  expect(save.mock.calls[0]).toEqual([1, { apiKey: "draft-key", region: "cn" }])
  expect((view.getByLabelText("API key") as HTMLInputElement).value).toBe("draft-key")
  await act(() => {
    return Promise.try(() => {
      // A built-in provider is closed via the enable switch, not a one-way Close button: the
      // card stays put with nothing calling it.
      fireEvent.click(view.getByRole("switch", { name: "Enable this provider" }))
    })
  })
  // Closing only flags the credential as disabled so the key survives for a later re-enable.
  expect(save.mock.calls[1]).toEqual([1, { disabled: true }])
})

test("a successful save advances the base without erasing text typed while it was in flight", async () => {
  let finish!: (value: ProviderSnapshot) => void
  const save = vi.fn(
    () =>
      new Promise<ProviderSnapshot>((resolve) => {
        finish = resolve
      })
  )
  const view = render(
    <ProviderRow
      provider={provider}
      saved={null}
      revision={1}
      busy={false}
      models={[]}
      onSave={save}
      onSaveModels={saveModels}
    />
  )
  await act(() => {
    return Promise.try(() => {
      view.getByLabelText("API key").focus()
      fireEvent.input(view.getByLabelText("API key"), { target: { value: "submitted-key" } })
      fireEvent.keyUp(view.getByLabelText("API key"), { key: "a" })
    })
  })
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Save connection" }))
    })
  })
  await act(() => {
    return Promise.try(() => {
      view.getByLabelText("API key").focus()
      fireEvent.input(view.getByLabelText("API key"), { target: { value: "next-draft" } })
      fireEvent.keyUp(view.getByLabelText("API key"), { key: "a" })
    })
  })
  await act(() => {
    return Promise.try(() => {
      finish(snapshot(2, "cn"))
    })
  })
  expect((view.getByLabelText("API key") as HTMLInputElement).value).toBe("next-draft")
  view.rerender(
    <ProviderRow
      provider={provider}
      saved={{ configured: true, disabled: false, region: "cn", base_url: null }}
      revision={2}
      busy={false}
      models={[]}
      onSave={save}
      onSaveModels={saveModels}
    />
  )
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Save connection" }))
    })
  })
  expect(save.mock.calls[1]).toEqual([2, { apiKey: "next-draft", region: "cn" }])
  await act(() => {
    return Promise.try(() => {
      finish(snapshot(3, "cn"))
    })
  })
})

test("a built-in provider saves a page-configured API base URL", async () => {
  const save = vi.fn(() => Promise.try(() => snapshot(2)))
  const view = render(
    <ProviderRow
      provider={provider}
      saved={{ configured: true, disabled: false, region: "intl", base_url: null }}
      revision={1}
      busy={false}
      models={[]}
      onSave={save}
      onSaveModels={saveModels}
    />
  )
  const toggle = view.getByRole("button", { name: "API base URL" })
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  expect(view.queryByRole("textbox", { name: "API base URL" })).toBeNull()
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute("aria-expanded", "true")
  await act(() => {
    return Promise.try(() => {
      const input = view.getByLabelText("API base URL")
      input.focus()
      fireEvent.input(input, {
        target: { value: "https://gateway.example.test/v1" }
      })
      fireEvent.keyUp(input, { key: "a" })
    })
  })
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Save connection" }))
    })
  })
  expect(save.mock.calls[0]).toEqual([1, { region: "intl", baseUrl: "https://gateway.example.test/v1" }])
})

test("provider tabs show configuration state and switch the single active panel", async () => {
  const custom = {
    id: "custom_private",
    name: "Private gateway",
    baseUrl: "https://gateway.example.test/v1",
    models: [{ label: "Model A", api_id: "model-a" }]
  }
  function Harness() {
    const [active, setActive] = useState("hakimi")
    return (
      <>
        <ProviderTabs
          activeId={active}
          keys={{ hakimi: { configured: true, disabled: false, region: null, base_url: null } }}
          customProviders={[custom]}
          onSelect={setActive}
          onAdd={() => setActive("new")}
        />
        <output>{active}</output>
      </>
    )
  }
  const view = render(<Harness />)
  expect(view.getByRole("button", { name: "哈基米" }).getAttribute("aria-pressed")).toBe("true")
  expect(view.getByTestId("hakimi-status").getAttribute("data-configured")).toBe("true")
  // Every catalog provider is offered; only a saved key marks its tab configured.
  expect(view.getByTestId("qwen-status").getAttribute("data-configured")).toBe("false")

  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Private gateway" }))
    })
  })
  expect(view.getByText("custom_private")).toBeTruthy()
})

const customProvider = {
  id: "custom_private",
  name: "Private gateway",
  baseUrl: "https://gateway.example.test/v1",
  models: [{ label: "Model A", api_id: "model-a" }]
}

async function enterText(input: HTMLElement, value: string): Promise<void> {
  await act(() => {
    return Promise.try(() => {
      input.focus()
      fireEvent.input(input, { target: { value } })
      fireEvent.keyUp(input, { key: "a" })
    })
  })
}

test("custom model previews reflect edits and keep the JSON draft when reopened", async () => {
  const save = vi.fn(() => Promise.resolve(true))
  const saved = vi.fn(() => {})
  const view = render(
    <CustomProviderEditor provider={customProvider} revision={7} busy={false} onSave={save} onSaved={saved} />
  )
  expect(view.getByText("Model A")).toBeTruthy()
  expect(view.queryByLabelText("Models (JSON)")).toBeNull()
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Edit JSON" }))))
  const draft = '[{"label":"Model B","api_id":"model-b","contextWindow":32000}]'
  await enterText(view.getByLabelText("Models (JSON)"), draft)
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Preview models" }))))
  expect(view.getByText("Model B")).toBeTruthy()
  expect(view.getByText("model-b")).toBeTruthy()
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Edit JSON" }))))
  expect((view.getByLabelText("Models (JSON)") as HTMLTextAreaElement).value).toBe(draft)
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Save connection" }))))
  expect(save.mock.calls).toEqual([[7, { ...customProvider, models: JSON.parse(draft) as unknown }]])
  expect(saved.mock.calls).toEqual([[customProvider.id]])
})

test("invalid model JSON stays editable and cannot be saved or hidden by preview", async () => {
  const save = vi.fn(() => Promise.resolve(true))
  const view = render(
    <CustomProviderEditor provider={customProvider} revision={1} busy={false} onSave={save} onSaved={() => {}} />
  )
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Edit JSON" }))))
  await enterText(view.getByLabelText("Models (JSON)"), "[]")
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Preview models" }))))
  expect(view.getByLabelText("Models (JSON)").getAttribute("aria-invalid")).toBe("true")
  expect(view.getByRole("alert").textContent).toBe("Add at least one model")
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Save connection" }))))
  expect(save).not.toHaveBeenCalled()
  expect((view.getByLabelText("Models (JSON)") as HTMLTextAreaElement).value).toBe("[]")
})

test("a new custom provider starts with the model editor open and masks its API key", async () => {
  const view = render(
    <CustomProviderEditor
      provider={null}
      revision={1}
      busy={false}
      onSave={() => Promise.resolve(true)}
      onSaved={() => {}}
    />
  )
  expect(view.getByLabelText("Models (JSON)")).toBeTruthy()
  expect(view.getByRole("button", { name: "Save connection" }).hasAttribute("disabled")).toBe(true)
  await enterText(view.getByLabelText("API key"), "draft-key")
  expect(view.getByLabelText("API key").getAttribute("type")).toBe("password")
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Show key" }))))
  expect(view.getByLabelText("API key").getAttribute("type")).toBe("text")
  expect((view.getByLabelText("API key") as HTMLInputElement).value).toBe("draft-key")
})

test("syncing models offers them one at a time; + adds a model to the list and - removes it", async () => {
  const discover = vi.fn(() =>
    Promise.resolve([
      {
        label: "Claude Opus 5.5",
        api_id: "claude-opus-5-5",
        contextWindow: 1_000_000,
        reasoningLevels: ["low", "medium", "high", "max"],
        defaultReasoningLevel: "medium"
      },
      { label: "Gemini 3.8 Flash", api_id: "gemini-3.8-flash" }
    ])
  )
  const view = render(
    <CustomProviderEditor
      provider={null}
      revision={1}
      busy={false}
      onSave={() => Promise.resolve(true)}
      onSaved={() => {}}
      onDiscover={discover}
    />
  )
  await enterText(view.getByLabelText("API base URL"), "https://gateway.example.test/v1")
  await enterText(view.getByLabelText("API key"), "draft-key")
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Update model list" }))))

  expect(discover).toHaveBeenCalledWith({
    baseUrl: "https://gateway.example.test/v1",
    apiKey: "draft-key"
  })
  // The fetch only reports what the endpoint offers; nothing was merged into the list yet.
  expect(view.getByRole("status").textContent).toBe("Found 2 models on the endpoint.")
  // Discovered models group by family, collapsed; open both to reach their rows.
  await act(() => Promise.try(() => fireEvent.click(view.getByText("Claude"))))
  await act(() => Promise.try(() => fireEvent.click(view.getByText("Gemini"))))
  expect(view.getByText("Claude Opus 5.5")).toBeTruthy()
  expect(view.getByText("Gemini 3.8 Flash")).toBeTruthy()
  expect(view.getAllByRole("button", { name: "Add to model list" })).toHaveLength(2)
  expect(view.queryByRole("button", { name: "Remove from model list" })).toBeNull()

  // + adds exactly the picked model, with the endpoint's metadata.
  await act(() =>
    Promise.try(() => fireEvent.click(view.getAllByRole("button", { name: "Add to model list" })[0]))
  )
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Edit JSON" }))))
  expect(JSON.parse((view.getByLabelText("Models (JSON)") as HTMLTextAreaElement).value)).toEqual([
    {
      label: "My Model",
      api_id: "model-id",
      contextWindow: 200000,
      reasoningLevels: ["low", "medium", "high"],
      defaultReasoningLevel: "medium"
    },
    {
      label: "Claude Opus 5.5",
      api_id: "claude-opus-5-5",
      contextWindow: 1_000_000,
      reasoningLevels: ["low", "medium", "high", "max"],
      defaultReasoningLevel: "medium"
    }
  ])
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Preview models" }))))
  // The added Claude row offers - in the preview and in the fetched list (My Model offers -
  // there as well); the other fetched model still offers +.
  expect(view.getAllByRole("button", { name: "Remove from model list" })).toHaveLength(3)
  expect(view.getAllByRole("button", { name: "Add to model list" })).toHaveLength(1)

  // - removes it again, leaving the list as it was.
  await act(() =>
    Promise.try(() => fireEvent.click(view.getAllByRole("button", { name: "Remove from model list" })[1]))
  )
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Edit JSON" }))))
  expect(JSON.parse((view.getByLabelText("Models (JSON)") as HTMLTextAreaElement).value)).toEqual([
    {
      label: "My Model",
      api_id: "model-id",
      contextWindow: 200000,
      reasoningLevels: ["low", "medium", "high"],
      defaultReasoningLevel: "medium"
    }
  ])
})

test("syncing an existing provider reuses its saved key and surfaces failures", async () => {
  const discover = vi.fn(() => Promise.reject(new Error("HTTP 401")))
  const view = render(
    <CustomProviderEditor
      provider={customProvider}
      revision={1}
      busy={false}
      onSave={() => Promise.resolve(true)}
      onSaved={() => {}}
      onDiscover={discover}
    />
  )
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Edit JSON" }))))
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Update model list" }))))
  expect(discover).toHaveBeenCalledWith({
    baseUrl: customProvider.baseUrl,
    providerId: customProvider.id
  })
  expect(view.getByRole("alert").textContent).toBe("Could not update the model list: HTTP 401")
  expect(JSON.parse((view.getByLabelText("Models (JSON)") as HTMLTextAreaElement).value)).toEqual(customProvider.models)
})

test("Codex loading resolves to real usage without presenting a signed-out action", async () => {
  const signOut = vi.fn(() => {})
  const view = render(<CodexAccountSummary account={undefined} disabled={false} onSignOut={signOut} />)
  expect(view.getByLabelText("ChatGPT").getAttribute("aria-busy")).toBe("true")
  expect(view.queryByRole("button")).toBeNull()
  const account: SettingsAccount = {
    account: { account: { type: "chatgpt", email: "test@example.test", planType: "pro" }, requiresOpenaiAuth: true },
    rateLimits: {
      limitId: null,
      limitName: null,
      credits: null,
      spendControlReached: null,
      planType: "pro",
      primary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: null },
      secondary: null
    }
  }
  view.rerender(<CodexAccountSummary account={account} disabled={false} onSignOut={signOut} />)
  expect(view.getByLabelText("ChatGPT").getAttribute("aria-busy")).toBe("false")
  expect(view.getByText("test@example.test · Pro")).toBeTruthy()
  expect(view.getAllByRole("progressbar")).toHaveLength(1)
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("73")
  expect(view.getByText("73% remaining")).toBeTruthy()
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button"))))
  expect(signOut).toHaveBeenCalledTimes(1)
  view.rerender(<CodexAccountSummary account={null} disabled={false} onSignOut={signOut} />)
  expect(view.getByText("Unable to read account status")).toBeTruthy()
  expect(view.queryByText("Not signed in")).toBeNull()
  expect(view.queryByRole("progressbar")).toBeNull()
  expect(view.queryByRole("button")).toBeNull()
  view.rerender(
    <CodexAccountSummary
      account={{ account: { account: null, requiresOpenaiAuth: true }, rateLimits: null }}
      disabled={false}
      onSignOut={signOut}
    />
  )
  expect(view.getByText("Not signed in")).toBeTruthy()
  expect(view.queryByText("Unable to read account status")).toBeNull()
})

const catalogModels = [
  {
    label: "Qwen Max",
    api_id: "qwen-max",
    contextWindow: 32768,
    reasoningLevels: ["low", "high"],
    defaultReasoningLevel: "low"
  },
  { label: "Qwen Plus", api_id: "qwen-plus" }
]

test("built-in models render as editable rows and save the edited catalog", async () => {
  const save = vi.fn((_revision: number, _models: unknown[]) => Promise.try(() => catalogModels))
  const view = render(
    <ProviderRow
      provider={provider}
      saved={{ configured: true, disabled: false, region: "intl", base_url: null }}
      revision={1}
      busy={false}
      models={catalogModels}
      onSave={vi.fn()}
      onSaveModels={save}
    />
  )
  // Rows render collapsed (name + switch + actions); the editable fields open on demand.
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByText("Qwen Max"))
      fireEvent.click(view.getByText("Qwen Plus"))
    })
  })
  expect(view.getAllByLabelText(/^Display name/).length).toBe(2)
  expect((view.getByLabelText("Display name 1") as HTMLInputElement).value).toBe("Qwen Max")
  expect((view.getByLabelText("Model ID 2") as HTMLInputElement).value).toBe("qwen-plus")
  expect((view.getByLabelText("Context window 1") as HTMLInputElement).value).toBe("32768")

  await act(() => {
    return Promise.try(() => {
      fireEvent.input(view.getByLabelText("Display name 1"), { target: { value: "Qwen Max Turbo" } })
      fireEvent.input(view.getByLabelText("Model ID 2"), { target: { value: "qwen-plus-v2" } })
    })
  })
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getAllByRole("button", { name: "Save models" })[0])
    })
  })
  expect(save).toHaveBeenCalledTimes(1)
  const submitted = save.mock.calls[0]?.[1] as { label: string; api_id: string }[]
  expect(submitted[0]?.label).toBe("Qwen Max Turbo")
  expect(submitted[1]?.api_id).toBe("qwen-plus-v2")
})

test("duplicate model ids are rejected before anything is saved", async () => {
  const save = vi.fn(() => Promise.try(() => catalogModels))
  const view = render(
    <ProviderRow
      provider={provider}
      saved={{ configured: true, disabled: false, region: "intl", base_url: null }}
      revision={1}
      busy={false}
      models={catalogModels}
      onSave={vi.fn()}
      onSaveModels={save}
    />
  )
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByText("Qwen Plus"))
    })
  })
  await act(() => {
    return Promise.try(() => {
      fireEvent.input(view.getByLabelText("Model ID 2"), { target: { value: "qwen-max" } })
    })
  })
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getAllByRole("button", { name: "Save models" })[0])
    })
  })
  expect(save).not.toHaveBeenCalled()
  expect(view.getByRole("alert").textContent).toContain("Duplicate model ID")
})

test("a model can be added and removed from the table", async () => {
  const save = vi.fn(() => Promise.try(() => catalogModels))
  const view = render(
    <ProviderRow
      provider={provider}
      saved={{ configured: true, disabled: false, region: "intl", base_url: null }}
      revision={1}
      busy={false}
      models={catalogModels}
      onSave={vi.fn()}
      onSaveModels={save}
    />
  )
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Add model" }))
    })
  })
  // Collapsed rows still expose one remove button each; the added row starts empty and closed.
  const removeButtons = () => view.getAllByRole("button", { name: "Remove model" }).length
  expect(removeButtons()).toBe(3)
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getAllByRole("button", { name: "Remove model" })[2])
    })
  })
  expect(removeButtons()).toBe(2)
})

test("the OpenAI panel lists models with a pasted key", async () => {
  const openai = ALL_PROVIDERS.find((item) => item.native === true)
  if (!openai) throw new Error("native provider fixture missing")
  const discover = vi.fn(() => Promise.resolve([{ label: "GPT-6 Luna", api_id: "gpt-6-luna" }]))
  const saveModels = vi.fn(() => Promise.resolve([]))
  const view = render(
    <ProviderRow
      provider={openai}
      native
      saved={null}
      revision={1}
      busy={false}
      models={[{ label: "GPT-6.1 Sol", api_id: "gpt-6.1-sol" }]}
      onSave={vi.fn(() => Promise.resolve(null))}
      onSaveModels={saveModels}
      onDiscover={discover}
    />
  )

  // The native panel has no key of its own, so the button opens a prompt instead of fetching.
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Update model list" }))))
  expect(discover).not.toHaveBeenCalled()
  const dialog = view.getByRole("dialog")
  const field = within(dialog).getByLabelText("API key") as HTMLInputElement
  expect(field.getAttribute("type")).toBe("password")
  // Nothing to send until a key is typed.
  expect((within(dialog).getByRole("button", { name: "Fetch models" }) as HTMLButtonElement).disabled).toBe(true)

  await enterText(field, "sk-test")
  await act(() => Promise.try(() => fireEvent.click(within(dialog).getByRole("button", { name: "Fetch models" }))))

  // Exactly the call `curl https://api.openai.com/v1/models -H "Authorization: Bearer …"` makes.
  expect(discover).toHaveBeenCalledWith({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" })
  // Discovered models join the table; saving them stays a separate, explicit step.
  expect(view.getByText("GPT-6 Luna")).toBeTruthy()
  expect(saveModels).not.toHaveBeenCalled()
})

test("a rejected key reports inside the dialog, not as a toast", async () => {
  const openai = ALL_PROVIDERS.find((item) => item.native === true)
  if (!openai) throw new Error("native provider fixture missing")
  const discover = vi.fn(() =>
    Promise.reject(new Error("The provider returned HTTP 401: Incorrect API key provided: sk-wrong"))
  )
  const view = render(
    <ProviderRow
      provider={openai}
      native
      saved={null}
      revision={1}
      busy={false}
      models={[]}
      onSave={vi.fn(() => Promise.resolve(null))}
      onSaveModels={vi.fn(() => Promise.resolve([]))}
      onDiscover={discover}
    />
  )
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Update model list" }))))
  const dialog = view.getByRole("dialog")
  await enterText(within(dialog).getByLabelText("API key"), "sk-wrong")
  await act(() => Promise.try(() => fireEvent.click(within(dialog).getByRole("button", { name: "Fetch models" }))))

  // The vendor's sentence is replaced by something the reader can act on.
  const alert = within(dialog).getByRole("alert")
  expect(alert.textContent).toContain("That API key was rejected (HTTP 401)")
  expect(alert.textContent).not.toContain("Incorrect API key provided")
  // The dialog stays open with the key, so a typo can be fixed instead of retyped.
  expect((within(dialog).getByLabelText("API key") as HTMLInputElement).value).toBe("sk-wrong")
})

test("a key with non-ASCII characters never reaches the endpoint", async () => {
  const openai = ALL_PROVIDERS.find((item) => item.native === true)
  if (!openai) throw new Error("native provider fixture missing")
  const discover = vi.fn(() => Promise.resolve([]))
  const view = render(
    <ProviderRow
      provider={openai}
      native
      saved={null}
      revision={1}
      busy={false}
      models={[]}
      onSave={vi.fn(() => Promise.resolve(null))}
      onSaveModels={vi.fn(() => Promise.resolve([]))}
      onDiscover={discover}
    />
  )
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Update model list" }))))
  const dialog = view.getByRole("dialog")
  await enterText(within(dialog).getByLabelText("API key"), "sk-abc，def")

  expect(within(dialog).getByRole("alert").textContent).toContain("non-ASCII characters")
  const submit = within(dialog).getByRole("button", { name: "Fetch models" }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  await act(() => Promise.try(() => fireEvent.click(submit)))
  expect(discover).not.toHaveBeenCalled()
})

test("a failed usage read is worded differently from a plan that has no windows", () => {
  const signOut = vi.fn(() => {})
  const view = render(
    <CodexAccountSummary
      account={{
        account: { account: { type: "chatgpt", email: "test@example.test", planType: "pro" }, requiresOpenaiAuth: true },
        rateLimits: null,
        rateLimitsError: true
      }}
      disabled={false}
      onSignOut={signOut}
    />
  )
  expect(view.getByText("Usage is not readable right now; retrying automatically")).toBeTruthy()
  expect(view.queryByText("No usage data")).toBeNull()
})

test("a stale snapshot keeps its numbers and says how old they are", () => {
  const signOut = vi.fn(() => {})
  const capturedAt = new Date("2026-11-03T09:30:00").getTime()
  const view = render(
    <CodexAccountSummary
      account={{
        account: { account: { type: "chatgpt", email: "test@example.test", planType: "pro" }, requiresOpenaiAuth: true },
        rateLimits: {
          limitId: null,
          limitName: null,
          credits: null,
          spendControlReached: null,
          planType: "pro",
          primary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: null },
          secondary: null
        },
        rateLimitsCapturedAt: capturedAt,
        rateLimitsStale: true
      }}
      disabled={false}
      onSignOut={signOut}
    />
  )
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("73")
  expect(view.getByRole("status").textContent).toContain("2026/11/03 09:30")
  expect(view.queryByText("Usage is not readable right now; retrying automatically")).toBeNull()
})

test("a fresh read still says when the numbers were captured", () => {
  const capturedAt = new Date("2026-11-05T21:30:00").getTime()
  const view = render(
    <CodexAccountSummary
      account={{
        account: { account: { type: "chatgpt", email: "test@example.test", planType: "pro" }, requiresOpenaiAuth: true },
        rateLimits: {
          limitId: null,
          limitName: null,
          credits: null,
          spendControlReached: null,
          planType: "pro",
          primary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: null },
          secondary: null
        },
        rateLimitsCapturedAt: capturedAt,
        rateLimitsStale: false
      }}
      disabled={false}
      onSignOut={vi.fn(() => {})}
    />
  )
  expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("73")
  expect(view.getByRole("status").textContent).toContain("Data updated 2026/11/05 21:30")
  expect(view.queryByText("No usage data")).toBeNull()
})

test("the model table filters :free rows and bulk-deletes only the visible selection", async () => {
  const save = vi.fn((_revision: number, _models: unknown[]) => Promise.try(() => catalogModels))
  const models = [
    { label: "Free Alpha", api_id: "vendor/alpha:free" },
    { label: "Free Beta", api_id: "vendor/beta:free" },
    { label: "Paid Gamma", api_id: "vendor/gamma" }
  ]
  const view = render(
    <ProviderRow
      provider={openrouter}
      saved={{ configured: true, disabled: false, region: "intl", base_url: null }}
      revision={1}
      busy={false}
      models={models}
      onSave={vi.fn()}
      onSaveModels={save}
    />
  )
  expect(view.getByText("Showing 3 / 3")).toBeTruthy()

  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Free only" }))
    })
  })
  expect(view.queryByText("Paid Gamma")).toBeNull()
  expect(view.getByText("Free Alpha")).toBeTruthy()
  expect(view.getByText("Showing 2 / 3")).toBeTruthy()

  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Bulk select" }))
    })
  })
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Select all shown" }))
    })
  })
  expect(view.getByText("2 selected")).toBeTruthy()
  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Delete selected" }))
    })
  })
  // Clearing the filter after a bulk delete keeps the surviving rows visible.
  expect(view.queryByText("Free Alpha")).toBeNull()
  expect(view.getByText("Paid Gamma")).toBeTruthy()

  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getAllByRole("button", { name: "Save models" })[0])
    })
  })
  const submitted = save.mock.calls[0]?.[1] as { api_id: string }[]
  expect(submitted.map((row) => row.api_id)).toEqual(["vendor/gamma"])
})

test("the free-model toggle only appears on OpenRouter", () => {
  const view = render(
    <ProviderRow
      provider={provider}
      saved={{ configured: true, disabled: false, region: "intl", base_url: null }}
      revision={1}
      busy={false}
      models={[]}
      onSave={vi.fn()}
      onSaveModels={saveModels}
    />
  )
  expect(view.queryByRole("button", { name: "Free only" })).toBeNull()
  expect(view.getByRole("button", { name: "Bulk select" })).toBeTruthy()
})

test("inverted delete keeps the selected models and drops every other row", async () => {
  const save = vi.fn((_revision: number, _models: unknown[]) => Promise.try(() => catalogModels))
  const models = [
    { label: "Free Alpha", api_id: "vendor/alpha:free" },
    { label: "Free Beta", api_id: "vendor/beta:free" },
    { label: "Paid Gamma", api_id: "vendor/gamma" }
  ]
  const view = render(
    <ProviderRow
      provider={openrouter}
      saved={{ configured: true, disabled: false, region: "intl", base_url: null }}
      revision={1}
      busy={false}
      models={models}
      onSave={vi.fn()}
      onSaveModels={save}
    />
  )
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Bulk select" }))))
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Free only" }))))
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Select all shown" }))))
  expect(view.getByText("2 selected")).toBeTruthy()

  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Delete others" }))))
  // The filter is cleared so the survivors are visible rather than a blank "no matches" panel.
  expect(view.getByText("Free Alpha")).toBeTruthy()
  expect(view.getByText("Free Beta")).toBeTruthy()
  expect(view.queryByText("Paid Gamma")).toBeNull()

  await act(() => {
    return Promise.try(() => {
      fireEvent.click(view.getAllByRole("button", { name: "Save models" })[0])
    })
  })
  const submitted = save.mock.calls[0]?.[1] as { api_id: string }[]
  expect(submitted.map((row) => row.api_id)).toEqual(["vendor/alpha:free", "vendor/beta:free"])
})

test("a connection save retries once when a model toggle moved the revision", async () => {
  // One card writes twice: toggling a model saves the catalog (revision 7 → 8), then 保存连接
  // sends the revision the card loaded with. The second write must not be reported as another
  // window's edit when a refresh + retry can land it.
  const conflict = new Error("Provider settings changed in another window; reload and retry")
  const attempt = vi
    .fn<(revision: number) => Promise<{ revision: number }>>()
    .mockRejectedValueOnce(conflict)
    .mockResolvedValueOnce({ revision: 8 })
  const refresh = vi.fn(async () => ({ revision: 8 }))

  await expect(retryOnRevisionConflict(attempt, 7, refresh)).resolves.toEqual({ revision: 8 })
  expect(attempt.mock.calls).toEqual([[7], [8]])
  expect(refresh).toHaveBeenCalledTimes(1)
})

test("a conflict that leaves the revision unchanged still surfaces", async () => {
  const conflict = new Error("Provider settings changed in another window; reload and retry")
  const attempt = vi.fn().mockRejectedValue(conflict)

  await expect(retryOnRevisionConflict(attempt, 7, async () => ({ revision: 7 }))).rejects.toThrow(
    /another window/
  )
  expect(attempt).toHaveBeenCalledTimes(1)
})
