import type { Agent, ChannelInput } from "../../contracts/agent.ts";
import type { ChannelOutputs } from "../../contracts/output.ts";
import { outputStream } from "./output.ts";

/** Shared channel HTTP operations for local terminal and browser adapters. */
export function createChannelHandler(agent: Agent, outputs?: ChannelOutputs) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/events" && outputs) {
      if (request.method !== "GET") return new Response("Use GET", { status: 405 });
      const channelId = url.searchParams.get("channelId");
      if (!channelId?.trim()) return new Response("channelId is required", { status: 400 });
      return outputStream(outputs, channelId);
    }
    if (url.pathname !== "/messages") return new Response("Not found", { status: 404 });
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
  };
}

/** Experimental local HTTP interface; caller identity is self-reported. */
export function serveLocal(agent: Agent, socketPath: string, outputs?: ChannelOutputs) {
  const handle = createChannelHandler(agent, outputs);
  return Bun.serve({
    unix: socketPath,
    fetch(request, server) { server.timeout(request, 0); return handle(request); },
  });
}

/** Deliver one turn to a separately running local agent. */
export async function sendLocal(socketPath: string, input: ChannelInput, signal?: AbortSignal): Promise<string> {
  const response = await fetch("http://localhost/messages", {
    unix: socketPath, method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  const result = await response.json() as { answer?: string; error?: string };
  if (!response.ok || typeof result.answer !== "string") {
    throw new Error(result.error ?? `Agent HTTP ${response.status}`);
  }
  return result.answer;
}
