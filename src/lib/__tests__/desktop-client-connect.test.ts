import { afterEach, expect, test, vi } from "vitest"

import { createFakeAgent } from "@/agent/__tests__/fake-agent"
import { FakeHubPort } from "@/agent/__tests__/fake-runtime-client"
import { CodexClient } from "@/agent/client"

import { DesktopCodexClient } from "../desktop-client"

const runtime = vi.hoisted(() => vi.fn())
vi.mock("../runtime", () => ({ CODEX_AGENT_ID: "codex", runtimeClient: runtime }))

afterEach(() => {
  vi.restoreAllMocks()
  runtime.mockReset()
})

function desktop() {
  const fake = createFakeAgent()
  const port = new FakeHubPort(() => fake.app)
  const open = () => Promise.resolve(port)
  runtime.mockImplementation(open)
  return new DesktopCodexClient(open, { agentId: "codex", launch: { engine: "codex" } })
}

test("a project draft joins a startup handshake without probing or restarting the runtime again", async () => {
  const client = desktop()
  const gate = Promise.withResolvers<void>()
  const handshake = vi.spyOn(CodexClient.prototype, "connect").mockReturnValue(gate.promise)
  const startup = client.connect()
  await vi.waitFor(() => expect(handshake).toHaveBeenCalledTimes(1))
  const draft = client.connect()
  gate.resolve()
  await Promise.all([startup, draft])
  expect(runtime).toHaveBeenCalledTimes(1)
  expect(handshake).toHaveBeenCalledTimes(1)
})

test("a failed startup does not prevent an explicit retry", async () => {
  const client = desktop()
  runtime.mockRejectedValueOnce(new Error("offline"))
  const handshake = vi.spyOn(CodexClient.prototype, "connect").mockResolvedValue(undefined)
  await expect(client.connect()).rejects.toThrow("offline")
  await client.connect()
  expect(runtime).toHaveBeenCalledTimes(2)
  expect(handshake).toHaveBeenCalledTimes(1)
})
