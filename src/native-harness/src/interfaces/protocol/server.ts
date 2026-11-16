import type { ProtocolEndpoint, RpcRequest, RpcResponse, RpcNotification, ProtocolConfig, Description, Subscription } from "../../contracts/protocol.ts";
import type { HarnessSession } from "../../contracts/session.ts";

class Fault extends Error {
  constructor(readonly tag: string, message: string, readonly rpc = -32602) { super(message); }
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
export const description: Description = {
  configOptions: [], commands: [], policies: [],
  capabilities: { experimental: true, acceptance: "memory", persistence: false,
    methods: ["initialize", "session/create", "channel/push", "session/idle"],
    events: ["turn_started", "turn_took", "tool_call", "message_completed", "turn_ended"] },
};

export function createProtocolServer(create: (config: ProtocolConfig) => Promise<HarnessSession>): ProtocolEndpoint {
  let initialized = false;
  let creating = false;
  let session: HarnessSession | undefined;
  let subscription: Subscription = { text: "final", tools: "full" };
  const listeners = new Set<(notification: RpcNotification) => void>();
  const accepted = new Map<string, string>();
  const participants = new Set<string>();
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
      text(p.sessionId);
      if (session || creating) throw new Fault("already_exists", "One session per endpoint");
      try {
        const config = obj(p.config); keys(config, ["version", "system", "model"]);
        if (config.version !== 1 || typeof config.system !== "string") bad("Expected version 1 and a system string");
        const model = obj(config.model); keys(model, ["protocol", "script"]);
        if (model.protocol !== "scripted") bad("Only scripted model configuration is supported by this subset");
        text(model.script);
      } catch (error) { throw new Fault("invalid_config", String(error)); }
      if (!Array.isArray(p.participants)) bad("participants must be an array");
      const ids = new Set<string>();
      for (const value of p.participants) {
        const participant = obj(value); keys(participant, ["id", "kind"]); const id = text(participant.id);
        if (ids.has(id) || !["person", "agent", "worker", "host"].includes(participant.kind)) bad("Invalid or duplicate participant");
        ids.add(id);
      }
      if (Object.keys(obj(p.channels)).length) bad("Initial channel settings are not supported; channels are created on push");
      creating = true;
      try { session = await create(p.config); }
      catch (error) { throw new Fault("invalid_config", String(error)); }
      finally { creating = false; }
      for (const id of ids) participants.add(id);
      session.subscribe(value => {
        const event = structuredClone(value);
        if (event.event.type === "tool_call") {
          if (subscription.tools === "none") return;
          if (subscription.tools === "summary") { delete event.event.input; delete event.event.output; }
        }
        const message: RpcNotification = { jsonrpc: "2.0", method: "channel/event", params: event };
        for (const listener of listeners) { try { listener(structuredClone(message)); } catch { /* Isolate clients. */ } }
      });
      return { sessionId: p.sessionId };
    }
    if (!session) throw new Fault("not_ready", "Create a session first");
    if (method === "session/idle") { keys(p, []); return { idle: session.agent.idle() }; }
    keys(p, ["channel", "item"]);
    const channel = text(p.channel), item = obj(p.item);
    keys(item, ["id", "kind", "sender", "content", "delivery", "wake"]);
    const id = text(item.id), sender = text(item.sender);
    if (item.kind !== "user_message" || (item.delivery !== undefined && item.delivery !== "queue") || (item.wake !== undefined && item.wake !== true)) bad("Only waking, queued user messages are supported");
    if (!Array.isArray(item.content) || !item.content.length) bad("Expected text parts");
    const parts = item.content.map((value: unknown) => { const part = obj(value); keys(part, ["type", "text"]);
      if (part.type !== "text") bad("Only text parts are supported"); return { type: "text", text: text(part.text) }; });
    const signature = JSON.stringify({ channel, sender, parts });
    const previous = accepted.get(id);
    if (previous !== undefined) {
      if (previous !== signature) throw new Fault("item_conflict", `Item ID ${id} already identifies different input`);
      return { accepted: true };
    }
    participants.add(sender);
    // send stores synchronously, then schedules work. Never wait for inference
    // before returning acceptance; its eventual outcome is an event.
    const result = session.agent.send({ channelId: channel, participantId: sender, itemId: id,
      text: parts.map((part: { text: string }) => part.text).join("\n") });
    accepted.set(id, signature);
    void result.catch(() => {});
    return { accepted: true };
  }
  return {
    async request(request: RpcRequest): Promise<RpcResponse> {
      const id = request && Number.isSafeInteger(request.id) ? request.id : null;
      try {
        if (!request || request.jsonrpc !== "2.0" || !Number.isSafeInteger(request.id) || typeof request.method !== "string") throw new Fault("invalid_request", "Invalid request envelope", -32600);
        const result = await dispatch(request.method, request.params);
        return { jsonrpc: "2.0", id: request.id, result };
      } catch (error) {
        return { jsonrpc: "2.0", id, error: { code: error instanceof Fault ? error.rpc : -32603,
          message: String(error), data: { code: error instanceof Fault ? error.tag : "internal_error" } } };
      }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
