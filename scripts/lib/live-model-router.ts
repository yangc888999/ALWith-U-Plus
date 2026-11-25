export function startModelProbe() {
  type WireTurn = { model: string; reasoning?: { effort?: string }; service_tier?: string; delegation: boolean }
  const seen = new Map<string, WireTurn[]>()
  const held = new Map<string, Promise<void>>()
  const failures = new Map<string, { code: string; message: string }>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/responses/compact")) {
        return Response.json({ output: [{ type: "compaction", encrypted_content: "local-test-summary" }] })
      }
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses"))
        return new Response(null, { status: 404 })
      const payload = await request.json() as Omit<WireTurn, "delegation"> & { input: { type?: string; tools?: unknown[] }[]; tools?: unknown[] }
      const marker = [...JSON.stringify(payload.input).matchAll(/Reply with exactly (ROUTE_[a-f0-9]+)/g)].at(-1)?.[1]
      if (!marker) return new Response("Expected model probe prompt", { status: 400 })
      const definitions = payload.tools ?? payload.input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools ?? [])
      const delegation = /"name":"(?:[\w.]+[.:]+)?spawn_agent"/.test(JSON.stringify(definitions))
      seen.set(marker, [...(seen.get(marker) ?? []), { model: payload.model, reasoning: payload.reasoning, service_tier: payload.service_tier, delegation }])
      if (held.has(marker)) await held.get(marker)
      const item = { type: "message", id: `msg_${marker}`, role: "assistant", content: [] }
      const content = { type: "output_text", text: marker, annotations: [] }
      const answer = { ...item, status: "completed", content: [content] }
      const response = { id: `resp_${marker}`, object: "response", model: payload.model, output: [] }
      const failure = failures.get(marker)
      const events = failure ? [
        { type: "response.created", response: { ...response, status: "in_progress" } },
        { type: "response.failed", response: { ...response, status: "failed", error: failure } }
      ] : [
        { type: "response.created", response: { ...response, status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
        { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { ...content, text: "" } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: marker },
        { type: "response.output_item.done", output_index: 0, item: answer },
        { type: "response.completed", response: { ...response, status: "completed", output: [answer] } }
      ]
      return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" }
      })
    }
  })
  return {
    url: new URL("v1", server.url).href,
    fail: (marker: string, code: string, message: string) => failures.set(marker, { code, message }),
    hold(marker: string) {
      const gate = Promise.withResolvers<void>()
      held.set(marker, gate.promise)
      return () => { held.delete(marker); gate.resolve() }
    },
    received: (marker: string) => seen.has(marker),
    assertModel(marker: string, expected: string, effort?: string, fast?: boolean, ultra = false) {
      const turns = seen.get(marker)
      if (!turns?.length || turns.some((turn) => turn.model !== expected ||
        (effort !== undefined && turn.reasoning?.effort !== effort) || (ultra && !turn.delegation) ||
        (fast !== undefined && (turn.service_tier === "priority" || turn.service_tier === "fast") !== fast)))
        throw new Error(`Expected ${expected} effort=${effort} fast=${fast}, received ${JSON.stringify(turns ?? [])}`)
      console.log("wire:", JSON.stringify(turns.at(-1)))
    },
    close: () => server.stop(true)
  }
}
