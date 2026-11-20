import type { PersistentSession, PersistentSessionOptions } from "./contracts/session.ts";
import type { SessionAgent, TurnExecutor } from "./contracts/agent.ts";
import type { EventSink, SessionEventSink } from "./contracts/events.ts";
import type { SessionStorage } from "./contracts/storage.ts";
import { createMemoryStorageAdapter } from "./state/storage/memory.ts";
import { buildContext } from "./capabilities/context/build.ts";
import { createChannelScheduler } from "./kernel/channels.ts";
import { runTurn } from "./kernel/loop.ts";
import { ModelCallError, runModelCall } from "./capabilities/model/runner.ts";
import { getModelAttempt } from "./capabilities/model/attempt.ts";
import { createApprovalService, dispatchWithPolicy } from "./governance/permissions/gate.ts";
import { toolDecision } from "./governance/policy/resolve.ts";
import type { Message } from "./contracts/loop.ts";

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
    const opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "memory", compatibilityKey: "" }, config: options.config });
    if (!opened.ok) throw new Error(opened.error.message);
    storage = opened.value;
  }
  const store = storage;
  const owner = store.ownerConfig();
  if (!owner.ok) throw new Error(`Cannot read storage owner config (${owner.error.code}): ${owner.error.message}`);
  // Compare by value, ignoring insertion order. Never retain the assertion object:
  // the gate uses only the defensive snapshot returned by the owner.
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  if (options.config !== undefined && (owner.value === undefined || canonical(options.config) !== canonical(owner.value)))
    throw new Error("Session config does not match the storage owner config");
  if (owner.value !== undefined && options.systemPrompt !== owner.value.system)
    throw new Error("Session system prompt does not match the storage owner config");
  const events = fanout<Parameters<EventSink>[0]>(), lifecycle = fanout<Parameters<SessionEventSink>[0]>(), changes = fanout<void>();
  const read = () => { const view = store.snapshot(); if (!view.ok) throw new Error(view.error.message); return view.value; };
  // Every published event follows a commit, so it is also the moment the
  // timeline projection may have changed.
  const emit: EventSink = event => { changes.publish(); events.publish(event); };
  const config = owner.value ?? { version: 1 as const, system: options.systemPrompt, model: { protocol: "scripted" as const, script: "legacy" },
    defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow" as const, tools: {} } } };
  const approvals = createApprovalService(request => emit({ channel: request.channel, event: { type: "approval_requested", ...request } }), options.approvalTimeoutMs);
  let agent: SessionAgent;
  const run: TurnExecutor = (turn, port) => {
    const services = options.configureTurn(turn, notice => agent.notify({ ...notice, fromChannelId: turn.channelId, sourceTurnId: turn.turnId }));
    let recorded: { seq: number; revision: number } | undefined;
    const append = (message: Message) => {
      if (message.role !== "assistant" && message.role !== "tool") throw new Error("Only assistant and tool messages are recorded by a turn");
      const entry = store.appendMessage(turn.turnId, message);
      if (!entry.ok) throw new Error(`${entry.error.code}: ${entry.error.message}`);
      recorded = { seq: entry.value.seq, revision: entry.revision };
      changes.publish();
    };
    return runTurn({
      signal: port.signal, drainNotices: port.take, finish: port.finish, checkpoint: port.checkpoint, confirm: port.confirm,
      build() { const view = read(); return buildContext(view.timeline, options.systemPrompt, turn, view.turns); },
      append,
      dispatchTool(call, execute) {
        return dispatchWithPolicy({ channel: turn.channelId, turnId: turn.turnId, call,
          signal: port.signal, suspension: port.suspensionSignal, execute, approvals, beforeDispatch: options.beforeToolDispatch,
          decide: () => toolDecision(config, read().items.filter(item => item.turnId === turn.turnId).flatMap(item => item.policy ? [item.policy.resolved, ...item.policy.inherited] : ["__legacy_allow"]), call.name),
          recordSkip: content => append({ role: "tool", callId: call.id, content }),
          mark: () => { const result = store.markToolDispatched(turn.turnId, call.id); if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); },
          started: () => emit({ channel: turn.channelId, event: { type: "tool_call", turnId: String(turn.turnId), id: call.id, name: call.name, status: "started", input: call.arguments } }) });
      },
      emit(event) {
        // Completed messages and results were committed by the append just
        // before; a tool start or failure reports no commit of its own.
        const committed = event.type === "message_completed" || (event.type === "tool_call" && event.status === "completed");
        emit({ channel: turn.channelId, ...(committed && recorded ? { revision: recorded.revision } : {}),
          event: { ...event, turnId: String(turn.turnId),
            ...(event.type === "message_completed" && recorded ? { messageId: String(recorded.seq) } : {}) } });
      },
    }, async (messages, tools, signal) => {
      const view = read();
      const itemIds = view.items.filter(item => item.turnId === turn.turnId).map(item => item.itemId);
      const binding = getModelAttempt(services.model);
      let draftId: string | undefined;
      try {
      const result = await runModelCall({ turnId: String(turn.turnId), itemIds, request: { messages, tools },
        scripted: binding.scripted, store, attempt: binding.create, signal,
        delta: ({ messageId, text }) => { draftId = messageId; emit({ channel: turn.channelId,
          event: { type: "text_delta", turnId: String(turn.turnId), messageId, text } }); },
        incomplete: ({ messageId, reason }) => emit({ channel: turn.channelId,
          event: { type: "text_incomplete", turnId: String(turn.turnId), messageId, reason } }),
        receipt: (milestone, items, revision) => emit({ channel: turn.channelId, revision,
          event: { type: "items_receipt", turnId: String(turn.turnId), items, milestone } }),
      });
      recorded = { seq: result.entry.seq, revision: result.revision }; changes.publish();
      if (result.response.content) emit({ channel: turn.channelId, revision: result.revision,
        event: { type: "message_completed", turnId: String(turn.turnId), messageId: result.messageId,
          parts: [{ type: "text", text: result.response.content }] } });
      return result.response;
      } catch (error) {
        // A storage failure can occur after a draft was published but before the
        // runner can write a normal terminal outcome. The draft must still end.
        if (draftId && !(error instanceof ModelCallError)) emit({ channel: turn.channelId,
          event: { type: "text_incomplete", turnId: String(turn.turnId), messageId: draftId, reason: "failed" } });
        throw error;
      }
    }, services.tools, services.executeTool);
  };
  const scheduler = createChannelScheduler(store, options.wrapTurn?.(run) ?? run, emit, lifecycle.publish);
  agent = scheduler.agent;
  return {
    agent, channels: scheduler.channels, approvals,
    store: { snapshot: () => read().timeline, subscribe: listener => changes.subscribe(listener) },
    snapshot: read, status: scheduler.status, start: scheduler.start,
    suspend: scheduler.suspend, resume: scheduler.resume, stop: scheduler.stop,
    subscribe: events.subscribe, subscribeSession: lifecycle.subscribe,
  };
}
export type { PersistentSession, PersistentSessionOptions } from "./contracts/session.ts";
