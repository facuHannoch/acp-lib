import type { Agent, ChannelInput } from "../../contracts/agent.ts";

/** Experimental local HTTP interface; caller identity is self-reported. */
export function serveLocal(agent: Agent, socketPath: string) {
  return Bun.serve({
    unix: socketPath,
    async fetch(request, server) {
      server.timeout(request, 0);
      if (new URL(request.url).pathname !== "/messages") return new Response("Not found", { status: 404 });
      if (request.method !== "POST") return new Response("Use POST", { status: 405 });
      let input: ChannelInput;
      try {
        const body = await request.json() as ChannelInput | null;
        if (!body || ![body.channelId, body.participantId, body.text].every(
          (value) => typeof value === "string" && value.trim().length > 0,
        )) throw new Error("Expected channelId, participantId and text as nonempty strings");
        input = { channelId: body.channelId, participantId: body.participantId, text: body.text };
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
      try { return Response.json({ answer: await agent.send(input) }); }
      catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
    },
  });
}

/** Deliver one turn to a separately running local agent. */
export async function sendLocal(socketPath: string, input: ChannelInput): Promise<string> {
  const response = await fetch("http://localhost/messages", {
    unix: socketPath, method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json() as { answer?: string; error?: string };
  if (!response.ok || typeof result.answer !== "string") {
    throw new Error(result.error ?? `Agent HTTP ${response.status}`);
  }
  return result.answer;
}
