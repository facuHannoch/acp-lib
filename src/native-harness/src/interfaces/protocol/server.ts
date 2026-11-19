import type { ProtocolEndpoint, RpcRequest, RpcResponse, RpcNotification, RpcSessionNotification, ProtocolConfig, Description, Subscription, DurableErrorCode } from "../../contracts/protocol.ts";
import type { PersistentSession } from "../../contracts/session.ts";
import { FrameLimit, loadView, pageMessages, wireStatus } from "./load.ts";

class Fault extends Error {
  constructor(readonly tag: string, message: string, readonly rpc = -32602) { super(message); }
}
/** Thrown by a session factory to report a typed storage or lifecycle refusal. */
export class SessionOpenError extends Error {
  constructor(readonly code: DurableErrorCode, message: string) { super(message); }
}
export interface SessionRequest { mode: "create" | "open"; sessionId: string; config: ProtocolConfig }
/** `close` releases storage ownership; the endpoint calls it when it is disposed
 * or when a load cannot be answered. */
export interface OpenedSession { session: PersistentSession; close(): void }

const bad = (message: string): never => { throw new Fault("invalid_params", message); };
function obj(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("Expected an object");
  return value as Record<string, any>;
}
function keys(value: Record<string, unknown>, names: string[]) {
  for (const name of Object.keys(value)) if (!names.includes(name)) bad(`Unsupported field: ${name}`);
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) bad("Expected a nonempty string");
  return value as string;
}
function count(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000) bad("Expected a limit between 1 and 1000");
  return value as number;
}
function config(raw: unknown) {
  try {
    const value = obj(raw); keys(value, ["version", "system", "model"]);
    if (value.version !== 1 || typeof value.system !== "string") bad("Expected version 1 and a system string");
    const model = obj(value.model); keys(model, ["protocol", "script"]);
    if (model.protocol !== "scripted") bad("Only scripted model configuration is supported by this subset");
    text(model.script);
  } catch (error) { throw new Fault("invalid_config", String(error)); }
}

/** Capabilities describe this server instance: durable acceptance and load are
 * advertised only when its sessions are opened from durable storage. */
export function describe(durable: boolean): Description {
  return {
    configOptions: [], commands: [], policies: [],
    capabilities: { experimental: true, acceptance: durable ? "durable" : "memory", persistence: durable,
      methods: ["initialize", "session/create", ...(durable ? ["session/load"] : []), "session/messages", "session/status", "channel/push", "session/idle"],
      events: ["turn_started", "turn_took", "items_receipt", "tool_call", "message_completed", "turn_ended"] },
  };
}

export function createProtocolServer(open: (request: SessionRequest) => Promise<OpenedSession>, options: { durable?: boolean } = {}): ProtocolEndpoint & { dispose(): void } {
  const description = describe(!!options.durable);
  let initialized = false;
  let opening = false;
  let current: OpenedSession | undefined;
  let subscription: Subscription = { text: "final", tools: "full" };
  const listeners = new Set<(notification: RpcNotification) => void>();
  const sessionListeners = new Set<(notification: RpcSessionNotification) => void>();
  // While a load response is on its way out, later notifications wait behind it.
  let held: (() => void)[] | undefined;
  const publish = (deliver: () => void) => { if (held) held.push(deliver); else deliver(); };

  async function attach(request: SessionRequest): Promise<OpenedSession> {
    if (current || opening) throw new Fault("already_exists", "One session per endpoint");
    opening = true;
    let opened: OpenedSession;
    try { opened = await open(request); }
    catch (error) { throw error instanceof SessionOpenError ? new Fault(error.code, error.message) : new Fault("invalid_config", String(error)); }
    finally { opening = false; }
    opened.session.subscribe(value => {
      const event = structuredClone(value);
      if (event.event.type === "tool_call") {
        if (subscription.tools === "none") return;
        if (subscription.tools === "summary") { delete event.event.input; delete event.event.output; }
      }
      const message: RpcNotification = { jsonrpc: "2.0", method: "channel/event", params: event };
      publish(() => { for (const listener of listeners) { try { listener(structuredClone(message)); } catch { /* Isolate clients. */ } } });
    });
    opened.session.subscribeSession(event => {
      const message: RpcSessionNotification = { jsonrpc: "2.0", method: "session/event", params: event };
      publish(() => { for (const listener of sessionListeners) { try { listener(structuredClone(message)); } catch { /* Isolate clients. */ } } });
    });
    return opened;
  }

  /** Read one snapshot, then keep every later notification behind the response.
   * The response is handed to the transport in a microtask after this request
   * resolves; a timer runs after all of those, so releasing held notifications
   * (and, for a first load, starting execution) there places them after it. */
  function load(opened: OpenedSession, limit: number, start: boolean) {
    const view = opened.session.snapshot();
    const result = loadView(opened.session.status(), view, limit);
    held ??= [];
    setTimeout(() => {
      const waiting = held ?? []; held = undefined;
      for (const deliver of waiting) deliver();
      if (start) opened.session.start();
    }, 0);
    return result;
  }

  async function dispatch(method: string, raw: unknown): Promise<unknown> {
    if (!description.capabilities.methods.includes(method)) throw new Fault("method_not_found", `Unsupported method: ${method}`, -32601);
    const p = obj(raw);
    if (method === "initialize") {
      keys(p, ["protocolVersion", "host", "callbacks", "subscription"]);
      if (p.protocolVersion !== 1) throw new Fault("version_mismatch", "Only experimental protocol version 1 is supported");
      if (initialized) throw new Fault("already_exists", "Already initialized");
      const host = obj(p.host); keys(host, ["name", "version"]); text(host.name); text(host.version);
      if (!Array.isArray(p.callbacks) || p.callbacks.length) bad("Host callbacks are not supported yet");
      const sub = obj(p.subscription); keys(sub, ["text", "tools"]);
      if (sub.text !== "final" || !["none", "summary", "full"].includes(sub.tools)) bad("Only final text and none/summary/full tools are supported");
      subscription = { text: "final", tools: sub.tools };
      initialized = true;
      return { protocolVersion: 1, harness: { version: "0.0.0" }, description };
    }
    if (!initialized) throw new Fault("not_ready", "Initialize first");
    if (method === "session/create") {
      keys(p, ["sessionId", "config", "participants", "channels"]);
      const sessionId = text(p.sessionId);
      if (current || opening) throw new Fault("already_exists", "One session per endpoint");
      config(p.config);
      if (!Array.isArray(p.participants)) bad("participants must be an array");
      const ids = new Set<string>();
      for (const value of p.participants) {
        const participant = obj(value); keys(participant, ["id", "kind"]); const id = text(participant.id);
        if (ids.has(id) || !["person", "agent", "worker", "host"].includes(participant.kind)) bad("Invalid or duplicate participant");
        ids.add(id);
      }
      if (Object.keys(obj(p.channels)).length) bad("Initial channel settings are not supported; channels are created on push");
      current = await attach({ mode: "create", sessionId, config: p.config });
      current.session.start();
      return { sessionId };
    }
    if (method === "session/load") {
      keys(p, ["sessionId", "config", "messagesLimit"]);
      const sessionId = text(p.sessionId), limit = count(p.messagesLimit, 100);
      config(p.config);
      // A repeated load of the open session is a fresh view of it, nothing more.
      if (current) {
        if (current.session.snapshot().session.sessionId !== sessionId) throw new Fault("already_exists", "One session per endpoint");
        return load(current, limit, false);
      }
      const opened = await attach({ mode: "open", sessionId, config: p.config });
      try { const result = load(opened, limit, true); current = opened; return result; }
      // Nothing was started; release the session so no partial load is observable.
      catch (error) { opened.close(); throw error; }
    }
    if (!current) throw new Fault("not_ready", "Create or load a session first");
    const session = current.session;
    if (method === "session/idle") { keys(p, []); return { idle: session.agent.idle() }; }
    if (method === "session/status") { keys(p, []); return wireStatus(session.status(), session.snapshot()); }
    if (method === "session/messages") {
      keys(p, ["revision", "after", "limit"]);
      const view = session.snapshot(), after = Number(text(p.after));
      if (!Number.isSafeInteger(p.revision) || p.revision < 0 || !Number.isSafeInteger(after) || after < 0) bad("Expected a revision and a message ID");
      if (p.revision > view.revision) throw new Fault("not_found", `Session has not reached revision ${p.revision}`);
      return pageMessages(view, p.revision, after, count(p.limit, 100));
    }
    keys(p, ["channel", "item"]);
    const channel = text(p.channel), item = obj(p.item);
    keys(item, ["id", "kind", "sender", "content", "delivery", "wake"]);
    const id = text(item.id), sender = text(item.sender);
    // One delivery behavior: the two legacy fields are checked, then ignored.
    if (item.kind !== "user_message" || (item.delivery !== undefined && item.delivery !== "queue") || (item.wake !== undefined && item.wake !== true)) bad("Only waking, queued user messages are supported");
    if (!Array.isArray(item.content) || !item.content.length) bad("Expected text parts");
    const parts = item.content.map((value: unknown) => { const part = obj(value); keys(part, ["type", "text"]);
      if (part.type !== "text") bad("Only text parts are supported"); return { type: "text", text: text(part.text) }; });
    // send returns once the item is committed to the inbox (Received) or
    // refused. It never waits for inference; the outcome arrives as events.
    const result = session.agent.send({ channelId: channel, participantId: sender, itemId: id,
      text: parts.map((part: { text: string }) => part.text).join("\n") });
    if (!result.accepted) throw new Fault(result.code === "invalid_input" ? "invalid_params" : result.code, result.error);
    return { accepted: true, duplicate: result.duplicate, item: { id, channel, kind: "participant_message", sender, milestone: result.milestone,
      ...(result.turnId === undefined ? {} : { turnId: String(result.turnId) }) } };
  }
  return {
    async request(request: RpcRequest): Promise<RpcResponse> {
      const id = request && Number.isSafeInteger(request.id) ? request.id : null;
      try {
        if (!request || request.jsonrpc !== "2.0" || !Number.isSafeInteger(request.id) || typeof request.method !== "string") throw new Fault("invalid_request", "Invalid request envelope", -32600);
        const result = await dispatch(request.method, request.params);
        return { jsonrpc: "2.0", id: request.id, result };
      } catch (error) {
        const fault = error instanceof FrameLimit ? new Fault("transfer_limit", error.message) : error;
        return { jsonrpc: "2.0", id, error: { code: fault instanceof Fault ? fault.rpc : -32603,
          message: String(fault), data: { code: fault instanceof Fault ? fault.tag : "internal_error" } } };
      }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeSession(listener) { sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
    dispose() { current?.close(); current = undefined; },
  };
}
