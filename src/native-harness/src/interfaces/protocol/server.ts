import type { ProtocolEndpoint, RpcRequest, RpcResponse, RpcNotification, RpcSessionNotification, ProtocolConfig, Description, Subscription, DurableErrorCode } from "../../contracts/protocol.ts";
import type { PersistentSession } from "../../contracts/session.ts";
import type { SessionArchive, StorageResult, StoredSession } from "../../contracts/storage.ts";
import type { SessionFilePayload } from "../../contracts/session-file.ts";
import { SessionFileError, validateConfig } from "../../state/storage/session-file.ts";
import { validateManagedConfig } from "../../runtime/config/managed.ts";
import { FrameLimit, loadView, pageMessages, turnStatus, wireStatus } from "./load.ts";
import { TransferFault, createTransfers, decodeArchive, encodeArchive, readArchiveFile, writeArchiveFile, TRANSFER_LIMITS } from "./transfers.ts";
import type { TransferLimits } from "../../contracts/protocol.ts";

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
export interface OpenedSession {
  session: PersistentSession; close(): void;
  /** One consistent logical copy, or `busy`. */
  exportArchive?(): StorageResult<SessionArchive>;
}
export interface ProtocolServerOptions {
  durable?: boolean;
  /** Publish a validated archive as a new session with this ID. Enables import. */
  importArchive?(payload: SessionFilePayload<SessionArchive>, sessionId: string): StorageResult<StoredSession>;
  /** Where transfer files live while a transfer is open. Enables transfers. */
  transferDirectory?: string;
  /** Smaller limits for tests; defaults are the contract's. */
  limits?: Partial<{ chunkBytes: number; maxBytes: number; idleMs: number }>;
}

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
export function describe(durable: boolean, archives = false): Description {
  return {
    configOptions: [], commands: [], policies: [],
    capabilities: { experimental: true, acceptance: durable ? "durable" : "memory", persistence: durable,
      methods: ["initialize", "config/validate", "session/create", ...(durable ? ["session/load"] : []), "session/messages", "session/status",
        "session/suspend", "session/resume", "session/stop", "channel/push", "channel/create", "channel/edit", "channel/suspend", "channel/resume", "channel/delete", "channel/withdraw", "channel/interrupt", "session/idle",
        ...(archives ? ["session/export", "session/import", "transfer/open", "transfer/write", "transfer/read", "transfer/close"] : [])],
      events: ["turn_started", "turn_took", "items_receipt", "tool_call", "message_completed", "turn_suspended", "turn_resumed", "turn_ended", "channel_state", "item_withdrawn", "session/event"] },
  };
}

export function createProtocolServer(open: (request: SessionRequest) => Promise<OpenedSession>, options: ProtocolServerOptions = {}): ProtocolEndpoint & { dispose(): void } {
  const limits = { ...TRANSFER_LIMITS, ...options.limits } as TransferLimits;
  const transfers = options.importArchive && options.transferDirectory ? createTransfers(options.transferDirectory, limits) : undefined;
  const description = describe(!!options.durable, !!transfers);
  let initialized = false;
  let opening = false;
  let current: OpenedSession | undefined;
  let activeConfig: ProtocolConfig | undefined;
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
    activeConfig = structuredClone(request.config);
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
    if (method === "config/validate") {
      keys(p, ["config"]);
      try { validateManagedConfig(p.config); } catch (error) { throw new Fault("invalid_config", String(error)); }
      return { valid: true };
    }
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
    if (transfers && method.startsWith("transfer/")) {
      if (method === "transfer/open") { keys(p, ["bytes", "sha256"]); return { transferId: transfers.openUpload(p.bytes, p.sha256), limits }; }
      if (method === "transfer/write") { keys(p, ["transferId", "offset", "data"]); return { received: transfers.write(p.transferId, p.offset, p.data) }; }
      if (method === "transfer/read") { keys(p, ["transferId", "offset"]); return transfers.read(p.transferId, p.offset); }
      keys(p, ["transferId"]); transfers.close(p.transferId); return {};
    }
    if (transfers && method === "session/import") {
      keys(p, ["from", "sessionId"]);
      const from = obj(p.from);
      if (p.sessionId !== undefined) text(p.sessionId);
      // Whole file first, whole validation next, and only then one atomic publish.
      let bytes: Uint8Array;
      if (from.type === "path") { keys(from, ["type", "path"]); bytes = readArchiveFile(text(from.path), limits.maxBytes); }
      else if (from.type === "transfer") { keys(from, ["type", "transferId"]); bytes = transfers.consume(from.transferId); }
      else return bad("Import source must be a path or a transfer");
      const payload = decodeArchive(bytes, limits.maxBytes) as SessionFilePayload<SessionArchive>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).sort().join() !== "archive,config" || payload.archive?.archiveVersion !== 2)
        throw new Fault("invalid_archive", "Invalid session file payload");
      try { validateConfig(payload.config); } catch (error) { throw new Fault("invalid_archive", String(error)); }
      const sessionId = p.sessionId ?? payload.archive?.snapshot?.session?.sessionId;
      if (typeof sessionId !== "string" || !sessionId.trim()) throw new Fault("invalid_archive", "Archive does not name a session");
      const imported = options.importArchive!(payload, sessionId);
      if (!imported.ok) throw new Fault(imported.error.code === "invalid_input" ? "invalid_params" : imported.error.code, imported.error.message);
      return { sessionId: imported.value.sessionId, lifecycle: imported.value.lifecycle, revision: imported.revision };
    }
    if (!current) throw new Fault("not_ready", "Create or load a session first");
    if (transfers && method === "session/export") {
      keys(p, ["to"]);
      const to = obj(p.to);
      if (to.type === "path") { keys(to, ["type", "path"]); text(to.path); }
      else if (to.type === "transfer") keys(to, ["type"]);
      else bad("Export destination must be a path or a transfer");
      const exported = current.exportArchive?.() ?? { ok: false as const, error: { code: "invalid_state" as const, message: "This session cannot be exported" } };
      if (!exported.ok) throw new Fault(exported.error.code, exported.error.message);
      const { bytes, sha256 } = encodeArchive({ archive: exported.value, config: activeConfig! }, limits.maxBytes);
      if (to.type === "path") { writeArchiveFile(to.path, bytes); return { bytes: bytes.length, sha256 }; }
      return { bytes: bytes.length, sha256, transferId: transfers.offer(bytes, sha256) };
    }
    const session = current.session;
    if (method.startsWith("channel/") && method !== "channel/push") {
      const channel = text(p.channel);
      let result;
      if (method === "channel/create") {
        keys(p, ["channel", "displayName"]);
        result = session.channels.create({ channelId: channel, ...(p.displayName === undefined ? {} : { displayName: text(p.displayName) }) });
      } else if (method === "channel/edit") {
        keys(p, ["channel", "displayName"]);
        result = session.channels.edit(channel, p.displayName === null ? null : text(p.displayName));
      } else if (method === "channel/suspend") {
        keys(p, ["channel"]); result = await session.channels.suspend(channel);
      } else if (method === "channel/resume") {
        keys(p, ["channel"]); result = session.channels.resume(channel);
      } else if (method === "channel/delete") {
        keys(p, ["channel"]); result = session.channels.delete(channel);
      } else if (method === "channel/withdraw") {
        keys(p, ["channel", "item"]); const outcome = session.channels.withdraw(channel, text(p.item));
        if (!outcome.ok) throw new Fault(outcome.error.code, outcome.error.message);
        const { item } = outcome.value;
        return { outcome: outcome.value.outcome, item: { id: item.itemId, channel: item.channelId, kind: item.kind, sender: item.senderId, milestone: item.milestone,
          ...(item.turnId === undefined ? {} : { turnId: String(item.turnId) }) },
          ...(outcome.value.outcome === "withdrawn" ? { repeated: outcome.value.repeated } : {}) };
      } else {
        keys(p, ["channel", "turn", "reason"]); const rawTurn = text(p.turn), turn = Number(rawTurn);
        if (!Number.isSafeInteger(turn) || turn < 1 || String(turn) !== rawTurn) bad("Expected a turn ID");
        const outcome = session.channels.interrupt(channel, turn, p.reason === undefined ? undefined : text(p.reason));
        if (!outcome.ok) throw new Fault(outcome.error.code, outcome.error.message);
        return { interrupted: outcome.value.interrupted, turn: turnStatus(outcome.value.turn) };
      }
      if (!result.ok) throw new Fault(result.error.code, result.error.message);
      const status = wireStatus(session.status(), session.snapshot()).channels.find(value => value.channel === channel)!;
      return { channel: status, ...(method === "channel/create" ? { created: (result.value as { created: boolean }).created } : {}) };
    }
    if (method === "session/idle") { keys(p, []); return { idle: session.agent.idle() }; }
    if (method === "session/status") { keys(p, []); return wireStatus(session.status(), session.snapshot()); }
    if (method === "session/suspend" || method === "session/resume") {
      keys(p, []);
      // Suspend answers only once `suspended` is committed, after in-flight
      // iterations settle; a refusal changes nothing and consumes nothing.
      const outcome = method === "session/suspend" ? await session.suspend() : session.resume();
      if (!outcome.ok) throw new Fault(outcome.error.code, outcome.error.message);
      return wireStatus(outcome.status, session.snapshot());
    }
    if (method === "session/stop") { keys(p, []); return wireStatus(session.stop("Stopped by the host"), session.snapshot()); }
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
        const fault = error instanceof FrameLimit ? new Fault("transfer_limit", error.message)
          : error instanceof TransferFault || error instanceof SessionFileError ? new Fault(error.code, error.message) : error;
        return { jsonrpc: "2.0", id, error: { code: fault instanceof Fault ? fault.rpc : -32603,
          message: String(fault), data: { code: fault instanceof Fault ? fault.tag : "internal_error" } } };
      }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeSession(listener) { sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
    dispose() { transfers?.dispose(); current?.close(); current = undefined; },
  };
}
