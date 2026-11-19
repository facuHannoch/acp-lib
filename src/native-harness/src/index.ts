import type { PersistentSession, PersistentSessionOptions } from "./contracts/session.ts";
import type { SessionAgent, TurnExecutor } from "./contracts/agent.ts";
import type { EventSink, SessionEventSink } from "./contracts/events.ts";
import type { SessionStorage } from "./contracts/storage.ts";
import { createMemoryStorageAdapter } from "./state/storage/memory.ts";
import { buildContext } from "./capabilities/context/build.ts";
import { createChannelScheduler } from "./kernel/channels.ts";
import { runTurn } from "./kernel/loop.ts";

function fanout<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    publish(value: T) {
      for (const listener of listeners) {
        try { listener(structuredClone(value)); } catch { /* A consumer cannot fail agent execution. */ }
      }
    },
    subscribe(listener: (value: T) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** Assemble execution over storage without starting listeners, reading input,
 * requiring keys or running anything: call `start` (or `resume`) to execute.
 * Without `storage` the session lives in memory and ends with the process. */
export function createSession(options: Omit<PersistentSessionOptions, "storage"> & { storage?: SessionStorage }): PersistentSession {
  let storage = options.storage;
  if (!storage) {
    const opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "memory", compatibilityKey: "" } });
    if (!opened.ok) throw new Error(opened.error.message);
    storage = opened.value;
  }
  const store = storage;
  const events = fanout<Parameters<EventSink>[0]>(), lifecycle = fanout<Parameters<SessionEventSink>[0]>(), changes = fanout<void>();
  const read = () => { const view = store.snapshot(); if (!view.ok) throw new Error(view.error.message); return view.value; };
  // Every published event follows a commit, so it is also the moment the
  // timeline projection may have changed.
  const emit: EventSink = event => { changes.publish(); events.publish(event); };
  let agent: SessionAgent;
  const run: TurnExecutor = (turn, port) => {
    const services = options.configureTurn(turn, notice => agent.notify({ ...notice, fromChannelId: turn.channelId, sourceTurnId: turn.turnId }));
    let recorded: { seq: number; revision: number } | undefined;
    return runTurn({
      signal: port.signal, drainNotices: port.take, finish: port.finish, checkpoint: port.checkpoint, confirm: port.confirm,
      build() { const view = read(); return buildContext(view.timeline, options.systemPrompt, turn, view.turns); },
      append(message) {
        if (message.role !== "assistant" && message.role !== "tool") throw new Error("Only assistant and tool messages are recorded by a turn");
        const entry = store.appendMessage(turn.turnId, message);
        // Storage refuses a turn that stop or failure already ended; unwinding
        // here keeps a late answer or tool result from advancing it.
        if (!entry.ok) throw new Error(`${entry.error.code}: ${entry.error.message}`);
        recorded = { seq: entry.value.seq, revision: entry.revision };
        changes.publish();
      },
      emit(event) {
        // Completed messages and results were committed by the append just
        // before; a tool start or failure reports no commit of its own.
        const committed = event.type === "message_completed" || (event.type === "tool_call" && event.status === "completed");
        emit({ channel: turn.channelId, ...(committed && recorded ? { revision: recorded.revision } : {}),
          event: { ...event, turnId: String(turn.turnId),
            ...(event.type === "message_completed" && recorded ? { messageId: String(recorded.seq) } : {}) } });
      },
    }, services.model, services.tools, services.executeTool);
  };
  const scheduler = createChannelScheduler(store, options.wrapTurn?.(run) ?? run, emit, lifecycle.publish);
  agent = scheduler.agent;
  return {
    agent, channels: scheduler.channels,
    store: { snapshot: () => read().timeline, subscribe: listener => changes.subscribe(listener) },
    snapshot: read, status: scheduler.status, start: scheduler.start,
    suspend: scheduler.suspend, resume: scheduler.resume, stop: scheduler.stop,
    subscribe: events.subscribe, subscribeSession: lifecycle.subscribe,
  };
}
export type { PersistentSession, PersistentSessionOptions } from "./contracts/session.ts";
