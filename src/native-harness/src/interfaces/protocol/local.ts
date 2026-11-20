import type { ChannelInput } from "../../contracts/agent.ts";
import type { ChannelOutputs } from "../../contracts/output.ts";
import type { PersistentSession } from "../../contracts/session.ts";
import { outputStream } from "./output.ts";

type LocalSession = Pick<PersistentSession, "agent" | "subscribe">;
/** Lifecycle operations for the process owner's local socket only. */
export type LocalControl = Pick<PersistentSession, "status" | "suspend" | "resume">;

/** Private to the local adapters: hold an HTTP request until the turn that
 * took its input ends. Acceptance only names the item; `turn_started` or
 * `turn_took` names the turn, and that turn's events carry the reply. Inputs
 * that share a turn all resolve with its last completed message. This is not
 * a public wait-for-reply API. */
function followReplies(subscribe: LocalSession["subscribe"]) {
  const waiters = new Map<string, { resolve(answer: string): void; reject(error: Error): void }>();
  const turns = new Map<string, { items: string[]; answer: string }>();
  subscribe(({ event }) => {
    if (event.type === "turn_started" || event.type === "turn_took") {
      const mine = event.items.filter(id => waiters.has(id));
      if (!mine.length) return;
      const turn = turns.get(event.turnId) ?? { items: [], answer: "" };
      turn.items.push(...mine); turns.set(event.turnId, turn);
    } else if (event.type === "message_completed") {
      const turn = turns.get(event.turnId);
      if (turn) turn.answer = (event.parts ?? []).map(part => part.text).join("");
    } else if (event.type === "turn_ended" || event.type === "turn_suspended") {
      const turn = turns.get(event.turnId);
      if (!turn) return;
      turns.delete(event.turnId);
      for (const id of turn.items) {
        const waiter = waiters.get(id); waiters.delete(id);
        // A checkpointed turn answers only after resume, possibly in another
        // process: release the request now instead of holding it open.
        if (event.type !== "turn_ended") waiter?.reject(new Error("The session was suspended before this turn finished; its reply follows after resume"));
        else if (event.outcome === "completed") waiter?.resolve(turn.answer);
        else waiter?.reject(new Error(event.error ?? `Turn ${event.outcome}`));
      }
    }
  });
  // Register in the same tick as acceptance: the take is always a later task.
  return (itemId: string) => new Promise<string>((resolve, reject) => { waiters.set(itemId, { resolve, reject }); });
}

/** Shared channel HTTP operations for local terminal and browser adapters. */
export function createChannelHandler(session: LocalSession, outputs?: ChannelOutputs, control?: LocalControl) {
  const reply = followReplies(session.subscribe);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (control && url.pathname === "/session") {
      if (request.method === "GET") return Response.json(control.status());
      if (request.method !== "POST") return new Response("Use GET or POST", { status: 405 });
      const action = url.searchParams.get("action");
      if (action !== "suspend" && action !== "resume") return Response.json({ error: "action must be suspend or resume" }, { status: 400 });
      // Suspend answers when the session is suspended, after running tools finish.
      const outcome = action === "suspend" ? await control.suspend() : control.resume();
      return outcome.ok ? Response.json(outcome.status) : Response.json({ error: outcome.error.message, code: outcome.error.code }, { status: 409 });
    }
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
    const accepted = session.agent.send(input);
    if (!accepted.accepted) return Response.json({ error: accepted.error }, { status: accepted.code === "invalid_input" ? 400 : 503 });
    try { return Response.json({ answer: await reply(accepted.itemId) }); }
    catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  };
}

/** Experimental local HTTP interface; caller identity is self-reported. */
export function serveLocal(session: LocalSession, socketPath: string, outputs?: ChannelOutputs, control?: LocalControl) {
  const handle = createChannelHandler(session, outputs, control);
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

/** Read or change the lifecycle of a separately running local agent. */
export async function controlLocal(socketPath: string, action: "status" | "suspend" | "resume"): Promise<unknown> {
  const response = await fetch(`http://localhost/session${action === "status" ? "" : `?action=${action}`}`, {
    unix: socketPath, method: action === "status" ? "GET" : "POST",
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Agent HTTP ${response.status}`);
  return result;
}
