export function startModelProbe() {
  const seen = new Map<string, string[]>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses"))
        return new Response(null, { status: 404 })
      const payload = await request.json() as { model: string; input: unknown }
      const marker = [...JSON.stringify(payload.input).matchAll(/Reply with exactly (ROUTE_[a-f0-9]+)/g)].at(-1)?.[1]
      if (!marker) return new Response("Expected model probe prompt", { status: 400 })
      seen.set(marker, [...(seen.get(marker) ?? []), payload.model])
      const item = { type: "message", id: `msg_${marker}`, role: "assistant", content: [] }
      const content = { type: "output_text", text: marker, annotations: [] }
      const answer = { ...item, status: "completed", content: [content] }
      const response = { id: `resp_${marker}`, object: "response", model: payload.model, output: [] }
      const events = [
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
    assertModel(marker: string, expected: string) {
      const models = seen.get(marker)
      if (!models?.length || models.some((model) => model !== expected))
        throw new Error(`Expected upstream model ${expected}, received ${JSON.stringify(models ?? [])}`)
    },
    close: () => server.stop(true)
  }
}
