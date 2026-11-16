import type { SessionOptions, HarnessSession } from "./contracts/session.ts";
import type { Agent } from "./contracts/agent.ts";
import type { EventSink } from "./contracts/events.ts";
import { createSharedContextStore } from "./state/storage/shared-context.ts";
import { buildContext } from "./capabilities/context/build.ts";
import { createChannelScheduler } from "./kernel/channels.ts";
import { runTurn } from "./kernel/loop.ts";

/** Assemble execution without starting listeners, reading input or requiring keys. */
export function createSession(options: SessionOptions): HarnessSession {
  const store = options.store ?? createSharedContextStore();
  const listeners = new Set<EventSink>();
  const emit: EventSink = event => {
    for (const listener of listeners) {
      try { listener(structuredClone(event)); } catch { /* A consumer cannot fail agent execution. */ }
    }
  };
  let agent: Agent;
  const run: Parameters<typeof createChannelScheduler>[1] = (input, mailbox) => {
    const services = options.configureTurn(input, notice => agent.notify(notice));
    let message = 0;
    return runTurn({
      drainNotices: mailbox.drain, finish: mailbox.finish,
      build: () => buildContext(store.snapshot(), options.systemPrompt, input),
      append(message) { store.append({ channelId: input.channelId, turnId: input.turnId,
        from: message.role === "tool" ? "tool" : "agent", message }); },
      emit(event) {
        emit({ channel: input.channelId, event: { ...event, turnId: String(input.turnId),
          ...(event.type === "message_completed" ? { messageId: `${input.turnId}:message:${++message}` } : {}) } });
      },
    }, services.model, services.tools, services.executeTool);
  };
  agent = createChannelScheduler(store, options.wrapTurn?.(run) ?? run, emit);
  return { agent, store, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
export type { HarnessSession, SessionOptions } from "./contracts/session.ts";
