import type { ChannelEvent } from "../../src/contracts/events.ts";
import type { ChannelInput } from "../../src/contracts/agent.ts";
import type { Message } from "../../src/contracts/loop.ts";
import type { PersistentSession } from "../../src/contracts/session.ts";

/** Text of the newest input in a request, without its attribution prefix. */
export function lastInput(messages: readonly Message[]): string {
  const content = messages.findLast(message => message.role === "user")?.content ?? "";
  return content.startsWith("Participant: ") ? content.slice(content.indexOf("\n\n") + 2) : content.slice(content.indexOf("\n") + 1);
}

/** Collect events until `count` turns have ended. */
export function turnsEnd(session: Pick<PersistentSession, "subscribe">, count = 1) {
  const events: ChannelEvent[] = [];
  let resolve!: (events: ChannelEvent[]) => void;
  const done = new Promise<ChannelEvent[]>(r => { resolve = r; });
  const stop = session.subscribe(event => {
    events.push(event);
    if (events.filter(e => e.event.type === "turn_ended").length === count) { stop(); resolve(events); }
  });
  return { events, done };
}

/** Test-only correlation: send, then follow the turn that took the item. */
export async function ask(session: PersistentSession, input: ChannelInput): Promise<string> {
  let turnId: string | undefined, answer = "", itemId = "";
  return new Promise<string>((resolve, reject) => {
    const stop = session.subscribe(({ event }) => {
      if ((event.type === "turn_started" || event.type === "turn_took") && event.items.includes(itemId)) turnId = event.turnId;
      if (turnId === undefined || !("turnId" in event) || event.turnId !== turnId) return;
      if (event.type === "message_completed") answer = (event.parts ?? []).map(part => part.text).join("");
      if (event.type === "turn_ended") { stop(); event.outcome === "completed" ? resolve(answer) : reject(new Error(event.error ?? event.outcome)); }
    });
    const accepted = session.agent.send(input);
    if (!accepted.accepted) { stop(); reject(new Error(accepted.error)); return; }
    itemId = accepted.itemId;
  });
}
