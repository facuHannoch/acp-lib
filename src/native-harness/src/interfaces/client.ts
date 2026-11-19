import type { ClientTransport, Methods, InitializeParams, CreateParams, PushParams } from "../contracts/protocol.ts";
import type { EventSink } from "../contracts/events.ts";

export class HarnessClientError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "HarnessClientError"; }
}

/** Typed host API; transport details stay below this boundary. */
export class HarnessClient {
  private nextId = 0;
  private closed = false;
  private terminalError = new HarnessClientError("closed", "Client closed");
  private unsubscribeClose = () => {};
  private readonly listeners = new Set<EventSink>();
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly unsubscribe: () => void;
  constructor(private readonly transport: ClientTransport, private readonly timeoutMs = 30000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Request timeout must be positive");
    this.unsubscribe = transport.subscribe(message => {
      if ("method" in message) {
        for (const listener of this.listeners) { try { listener(structuredClone(message.params)); } catch { /* Consumer isolation. */ } }
      } else {
        if (message.id === null) return;
        const waiting = this.waiting.get(message.id);
        if (!waiting) return;
        this.waiting.delete(message.id); clearTimeout(waiting.timer);
        if ("error" in message) waiting.reject(new HarnessClientError(message.error.data.code, message.error.message));
        else waiting.resolve(message.result);
      }
    });
    this.unsubscribeClose = transport.onClose(error => {
      if (this.closed) return;
      this.terminalError = new HarnessClientError("transport_closed", error?.message ?? "Transport closed");
      this.close();
    });
  }
  request<K extends keyof Methods>(method: K, params: Methods[K]["params"]): Promise<Methods[K]["result"]> {
    if (this.closed) return Promise.reject(this.terminalError);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new HarnessClientError("timeout", `Request timed out: ${method}`)); }, this.timeoutMs);
      this.waiting.set(id, { timer, reject, resolve: value => resolve(value as Methods[K]["result"]) });
      try { this.transport.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.waiting.delete(id); reject(error); }
    });
  }
  initialize(params: InitializeParams = { protocolVersion: 1, host: { name: "harness-client", version: "0" }, callbacks: [], subscription: { text: "final", tools: "full" } }) {
    return this.request("initialize", params);
  }
  createSession(params: CreateParams) { return this.request("session/create", params); }
  push(params: PushParams) { return this.request("channel/push", params); }
  idle() { return this.request("session/idle", {}); }
  onChannelEvent(listener: EventSink) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close() {
    if (this.closed) return;
    this.closed = true; this.unsubscribe(); this.unsubscribeClose(); this.transport.close(); this.listeners.clear();
    for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(this.terminalError); }
    this.waiting.clear();
  }
}
