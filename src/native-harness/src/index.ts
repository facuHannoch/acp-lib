import { messagePosition } from "./util/message-position.ts";
import { executeNotice, notifyChannelDefinition } from "./capabilities/tools/scenario.ts";
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
import type { Message, ToolDefinition } from "./contracts/loop.ts";
import type { ControlResult, ToolControls } from "./contracts/session.ts";
import type { FunctionExecutor, ToolAvailability, TurnPhase } from "./contracts/tools.ts";
import { READ_TOOL_RESULT, createToolCatalog, readToolResultDefinition } from "./capabilities/tools/catalog.ts";
import { CallbackLost, TOOL_LIMITS, readResult, runFunction } from "./capabilities/tools/functions.ts";
import { findInvocation, invocationId, turnInvocations } from "./capabilities/tools/invocations.ts";
import { schemaProblem } from "./util/schema.ts";

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
  const identity = store.readSession();
  if (!identity.ok) throw new Error(identity.error.message);
  const position = (channel: string, seq: string) => messagePosition(identity.value.sessionId, channel, Number(seq));
  const emit: EventSink = value => {
    const { channel, event } = value;
    if ((event.type === "turn_started" || event.type === "turn_took") && event.messages)
      value = { ...value, event: { ...event, messages: event.messages.map(message => ({ ...message, position: position(channel, message.position) })) } };
    changes.publish();
    events.publish(value);
  };
  const config = owner.value ?? { version: 1 as const, system: options.systemPrompt, model: { protocol: "scripted" as const, script: "legacy" },
    defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow" as const, tools: {} } } };
  // ---- Tools, decision 0021. The catalog's definitions come from the open;
  // the revoked set mirrors storage; the executor belongs to the connection.
  const revoked = options.catalog ? store.readRevokedTools() : undefined;
  if (revoked && !revoked.ok) throw new Error(revoked.error.message);
  const catalog = options.catalog ? createToolCatalog(options.catalog, revoked?.value ?? []) : undefined;
  const limits = { ...TOOL_LIMITS, ...options.toolLimits };
  let executor: FunctionExecutor | undefined;
  /** What each running turn is doing now. Process state, cleared when the turn's run ends. */
  const phases = new Map<number, TurnPhase>();
  const phase = (turnId: number, kind: TurnPhase["kind"], id?: string) => phases.set(turnId, { kind, since: new Date().toISOString(), ...(id === undefined ? {} : { id }) });
  const approvals = createApprovalService(request => {
    phase(Number(request.turnId), "approval", request.requestId);
    emit({ channel: request.channel, event: { type: "approval_requested", ...request } });
  }, options.approvalTimeoutMs, (request, reason) => emit({ channel: request.channel, event: { type: "approval_closed", turnId: request.turnId, requestId: request.requestId, reason } }));
  let agent: SessionAgent;
  const run: TurnExecutor = (turn, port) => {
    const services = options.configureTurn(turn, notice => agent.notify({ ...notice, fromChannelId: turn.channelId, sourceTurnId: turn.turnId }));
    // Policy is read from the items this turn has taken, at the moment of use.
    const decide = (tool: string) => toolDecision(config, read().items.filter(item => item.turnId === turn.turnId).flatMap(item => item.policy ? [item.policy.resolved, ...item.policy.inherited] : ["__legacy_allow"]), tool);
    /** The names offered by this turn's latest inference: what a call must match. */
    let offered = new Set<string>();
    /** One snapshot per inference: built-ins and available catalog entries the
     * turn's policy does not deny, the stable group first. The model call runner
     * freezes it, so a retry of the request offers the same list. */
    const offer = (): { tools: ToolDefinition[]; fixedToolCount?: number } => {
      const allowed = <T extends ToolDefinition>(tools: readonly T[]) => tools.filter(tool => decide(tool.name) !== "deny");
      const definition = ({ name, description, parameters }: ToolDefinition): ToolDefinition => ({ name, description, parameters });
      const builtins = allowed([...services.tools.filter(tool => tool.name !== "notify_channel"), notifyChannelDefinition]);
      if (!catalog) { offered = new Set(builtins.map(tool => tool.name)); return { tools: [...builtins] }; }
      const available = catalog.offered();
      const fixed = [...builtins, ...allowed(available.fixed).map(definition), ...allowed([readToolResultDefinition])];
      const tools = [...fixed, ...allowed(available.changeable).map(definition)];
      offered = new Set(tools.map(tool => tool.name));
      return { tools, fixedToolCount: fixed.length };
    };
    /** The latest commit of this turn; `failedResult` names the call whose
     * paired result recorded a typed failure (its event reports that commit). */
    let recorded: { seq: number; revision: number; failedResult?: string } | undefined;
    const append = (message: Message) => {
      if (message.role !== "assistant" && message.role !== "tool") throw new Error("Only assistant and tool messages are recorded by a turn");
      const entry = store.appendMessage(turn.turnId, message);
      if (!entry.ok) throw new Error(`${entry.error.code}: ${entry.error.message}`);
      recorded = { seq: entry.value.seq, revision: entry.revision,
        ...(message.role === "tool" && message.outcome?.status === "failed" ? { failedResult: message.callId } : {}) };
      changes.publish();
    };
    return runTurn({
      signal: port.signal, drainNotices: port.take, finish: port.finish, checkpoint: port.checkpoint, confirm: port.confirm,
      build() { const view = read(); return buildContext(view.timeline, options.systemPrompt, turn, view.turns); },
      append,
      dispatchTool(call, execute) {
        const registration = catalog?.get(call.name), reader = !!catalog && call.name === READ_TOOL_RESULT;
        const id = invocationId(turn.turnId, call.id);
        return dispatchWithPolicy({ channel: turn.channelId, turnId: turn.turnId, call,
          signal: port.signal, suspension: port.suspensionSignal, approvals, beforeDispatch: options.beforeToolDispatch,
          decide: () => decide(call.name),
          // Catalog tools and the reader must have been offered by this request,
          // still be available, and carry arguments their definition accepts.
          ...(registration || reader ? { refuse: () => {
            if (!offered.has(call.name)) return { code: "tool_unavailable", detail: "it was not offered for this request" };
            if (!registration) return undefined;
            const why = catalog!.unavailable(call.name);
            if (why) return { code: "tool_unavailable", detail: why.replace("_", " ") };
            const problem = schemaProblem(registration.parameters, JSON.parse(call.arguments));
            return problem ? { code: "invalid_arguments", detail: problem } : undefined;
          } } : {}),
          execute: registration ? (_call, signal) => {
            // Dispatch evidence is committed. From here the effect is the host's.
            if (!executor) throw new CallbackLost("No connection serves this tool's handler");
            return runFunction({ executor, registration, limits, signal: signal ?? port.signal, defaultDeadlineMs: catalog!.defaultDeadlineMs,
              request: { invocationId: id, sessionId: read().session.sessionId, channel: turn.channelId, turnId: String(turn.turnId),
                tool: call.name, handler: registration.handler, arguments: JSON.parse(call.arguments) } });
          } : reader ? (_call, signal) => readResult({ executor, view: read(), channel: turn.channelId, arguments: call.arguments, limits, signal: signal ?? port.signal })
            : call.name === "notify_channel" ? async () => {
              try { return JSON.stringify(executeNotice(JSON.parse(call.arguments), (channelId, text) =>
                agent.notify({ channelId, text, fromChannelId: turn.channelId, sourceTurnId: turn.turnId }))); }
              catch (error) { return JSON.stringify({ ok: false, error: String(error) }); }
            } : execute,
          recordSkip: (content, code) => {
            append({ role: "tool", callId: call.id, content, outcome: { status: "skipped", code } });
            // Built-in tools keep their event stream as it was: a skip is silent.
            if (registration || reader) emit({ channel: turn.channelId, ...(recorded ? { revision: recorded.revision } : {}),
              event: { type: "tool_call", turnId: String(turn.turnId), id: call.id, name: call.name, status: "skipped", output: content, invocationId: id } });
          },
          mark: () => {
            const result = store.markToolDispatched(turn.turnId, call.id); if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
            phase(turn.turnId, "tool", id);
          },
          started: () => emit({ channel: turn.channelId, event: { type: "tool_call", turnId: String(turn.turnId), id: call.id, name: call.name, status: "started", input: call.arguments, invocationId: id } }) });
      },
      emit(event) {
        // Completed messages and results were committed by the append just
        // before; a tool start or failure reports no commit of its own.
        const committed = event.type === "message_completed" || (event.type === "tool_call" && (event.status === "completed" || event.status === "interrupted" || (event.status === "failed" && recorded?.failedResult === event.id)));
        emit({ channel: turn.channelId, ...(committed && recorded ? { revision: recorded.revision } : {}),
          event: { ...event, turnId: String(turn.turnId),
            ...(event.type === "tool_call" ? { invocationId: invocationId(turn.turnId, event.id) } : {}),
            ...(event.type === "message_completed" && recorded ? { messageId: String(recorded.seq) } : {}) } });
      },
    }, async (messages, _tools, signal) => {
      const { tools, fixedToolCount } = offer();
      phase(turn.turnId, "model");
      const view = read();
      const taken = view.items.filter(item => item.turnId === turn.turnId);
      const itemIds = taken.map(item => item.itemId);
      const previousResponse = view.timeline.findLast(entry => entry.turnId === turn.turnId && entry.message.role === "assistant")?.seq ?? 0;
      const takenItemIds = taken.filter(item => (item.entrySeq ?? 0) > previousResponse)
        .sort((a, b) => a.entrySeq! - b.entrySeq!).map(item => item.itemId);
      const binding = getModelAttempt(services.model);
      let draftId: string | undefined;
      try {
      const result = await runModelCall({ turnId: String(turn.turnId), itemIds, request: { messages, tools, takenItemIds, ...(fixedToolCount === undefined ? {} : { fixedToolCount }) },
        started: callId => phase(turn.turnId, "model", callId),
        scripted: binding.scripted, store, attempt: binding.create, signal, settings: binding.settings,
        delta: ({ messageId, text }) => { draftId = messageId; emit({ channel: turn.channelId,
          event: { type: "text_delta", turnId: String(turn.turnId), messageId, text } }); },
        incomplete: ({ messageId, reason }) => emit({ channel: turn.channelId,
          event: { type: "text_incomplete", turnId: String(turn.turnId), messageId, reason } }),
        receipt: (milestone, items, revision) => emit({ channel: turn.channelId, revision,
          event: { type: "items_receipt", turnId: String(turn.turnId), items, milestone } }),
      });
      recorded = { seq: result.entry.seq, revision: result.revision }; changes.publish();
      if (result.response.content) emit({ channel: turn.channelId, revision: result.revision,
        event: { type: "message_completed", turnId: String(turn.turnId), messageId: result.messageId, position: position(turn.channelId, String(result.entry.seq)),
          parts: [{ type: "text", text: result.response.content }] } });
      return result.response;
      } catch (error) {
        // A storage failure can occur after a draft was published but before the
        // runner can write a normal terminal outcome. The draft must still end.
        if (error instanceof ModelCallError && error.message === "script_exhausted") throw error.message;
        if (draftId && !(error instanceof ModelCallError)) emit({ channel: turn.channelId,
          event: { type: "text_incomplete", turnId: String(turn.turnId), messageId: draftId, reason: "failed" } });
        throw error;
      }
    }, services.tools, services.executeTool).finally(() => { phases.delete(turn.turnId); });
  };
  const scheduler = createChannelScheduler(store, options.wrapTurn?.(run) ?? run, emit, lifecycle.publish);
  agent = scheduler.agent;
  /** Status with each running turn's phase, which only this process knows. */
  const status = () => {
    const current = scheduler.status();
    for (const channel of current.channels) {
      const now = channel.activeTurn?.status === "running" ? phases.get(channel.activeTurn.turnId) : undefined;
      if (now) channel.activeTurn = { ...channel.activeTurn!, phase: { ...now } };
    }
    return current;
  };
  const tools = catalog && toolControls();
  function toolControls(): ToolControls {
    const book = catalog!;
    const waiting = () => new Set(approvals.waiting().map(request => invocationId(request.turnId, request.toolCallId)));
    /** A tool that just became unavailable cannot be approved any more. */
    const closeUnavailable = () => { for (const entry of book.entries) if (book.unavailable(entry.name)) approvals.closeTool(entry.name); };
    const change = (name: string, group: "revocable" | "runtime", act: () => number): ControlResult<ToolAvailability> => {
      const entry = book.get(name);
      if (!entry) return { ok: false, error: { code: "not_found", message: `Unknown tool: ${String(name)}` } };
      if (entry.group !== group) return { ok: false, error: { code: "invalid_state", message: `Tool ${name} is ${entry.group}; this operation needs a ${group} tool` } };
      let revision: number;
      try { revision = act(); } catch (error) { return { ok: false, error: { code: "storage_failure", message: String(error) } }; }
      closeUnavailable();
      return { ok: true, value: book.availability(entry), revision };
    };
    const persist = (name: string, revoked: boolean) => {
      const result = store.setToolRevoked(name, revoked);
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      book.setRevoked(result.value);
      return result.revision;
    };
    return {
      list: () => [...book.entries.map(entry => book.availability(entry)), { name: READ_TOOL_RESULT, group: "builtin", available: true }],
      serve(handlers, next) { book.serve(handlers); executor = next; closeUnavailable(); },
      revoke: name => change(name, "revocable", () => persist(name, true)),
      restore: name => change(name, "revocable", () => persist(name, false)),
      enable: name => change(name, "runtime", () => { book.setEnabled(name, true); return read().revision; }),
      remove: name => change(name, "runtime", () => { book.setEnabled(name, false); return read().revision; }),
      invocation: id => findInvocation(read(), id, waiting()),
      invocations: turnId => turnInvocations(read(), turnId, waiting()),
    };
  }
  return {
    ...(tools ? { tools } : {}),
    agent, channels: scheduler.channels, approvals, operatorReads: store, turnPhase: id => phases.get(id),
    store: { snapshot: () => read().timeline, subscribe: listener => changes.subscribe(listener) },
    snapshot: read, status, start: scheduler.start,
    suspend: scheduler.suspend, resume: scheduler.resume, stop: scheduler.stop,
    subscribe: events.subscribe, subscribeSession: lifecycle.subscribe,
  };
}
export type { PersistentSession, PersistentSessionOptions } from "./contracts/session.ts";
