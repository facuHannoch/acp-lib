import type { ClientTransport, Methods, DurableMethods, InitializeParams, CreateParams, PushParams } from "../contracts/protocol.ts";
import type { EventSink, SessionEventSink } from "../contracts/events.ts";
import { createHash } from "node:crypto";

type Calls = Methods & DurableMethods;

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
  private readonly sessionListeners = new Set<SessionEventSink>();
  private unsubscribeSession = () => {};
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
    this.unsubscribeSession = transport.subscribeSession?.(message => {
      for (const listener of this.sessionListeners) { try { listener(structuredClone(message.params)); } catch { /* Consumer isolation. */ } }
    }) ?? (() => {});
    this.unsubscribeClose = transport.onClose(error => {
      if (this.closed) return;
      this.terminalError = new HarnessClientError("transport_closed", error?.message ?? "Transport closed");
      this.close();
    });
  }
  request<K extends keyof Calls>(method: K, params: Calls[K]["params"]): Promise<Calls[K]["result"]> {
    if (this.closed) return Promise.reject(this.terminalError);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new HarnessClientError("timeout", `Request timed out: ${method}`)); }, this.timeoutMs);
      this.waiting.set(id, { timer, reject, resolve: value => resolve(value as Calls[K]["result"]) });
      try { this.transport.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.waiting.delete(id); reject(error); }
    });
  }
  initialize(params: InitializeParams = { protocolVersion: 1, host: { name: "harness-client", version: "0" }, callbacks: [], subscription: { text: "final", tools: "full" } }) {
    return this.request("initialize", params);
  }
  createSession(params: CreateParams) { return this.request("session/create", params); }
  validateConfig(config: unknown) { return this.request("config/validate", { config }); }
  respondApproval(requestId: string, decision: "allow_once" | "deny") { return this.request("approval/respond", { requestId, decision }); }
  /** Open an existing session. The returned view precedes every live event
   * for work the session recovers; callers reconcile their own records with it. */
  loadSession(params: Calls["session/load"]["params"]) { return this.request("session/load", params); }
  messages(params: Calls["session/messages"]["params"]) { return this.request("session/messages", params); }
  status() { return this.request("session/status", {}); }
  modelCalls(params: Calls["session/model-calls"]["params"] = {}) { return this.request("session/model-calls", params); }
  readMessage(params: Calls["session/message/read"]["params"]) { return this.request("session/message/read", params); }
  /** Resolves once the session is cleanly suspended: active iterations have
   * finished and every unfinished turn is checkpointed. May take as long as a
   * running tool; pass a longer client timeout for long tools. */
  suspend() { return this.request("session/suspend", {}); }
  /** Explicit: a loaded suspended session runs nothing until this is called. */
  resume() { return this.request("session/resume", {}); }
  /** Immediate: cancels inference and tools and reports active turns interrupted. */
  stop() { return this.request("session/stop", {}); }
  /** Write the session's archive to a path the harness can reach. */
  exportTo(path: string) { return this.request("session/export", { to: { type: "path", path } }); }
  /** Import an archive file the harness can reach, as a new session. */
  importFrom(path: string, sessionId?: string) { return this.request("session/import", { from: { type: "path", path }, ...(sessionId === undefined ? {} : { sessionId }) }); }
  /** Fetch the archive bytes over the connection in bounded chunks. The bytes
   * are checked against the length and SHA-256 the harness reported. */
  async exportArchive(): Promise<Uint8Array> {
    const { bytes, sha256, transferId } = await this.request("session/export", { to: { type: "transfer" } });
    const archive = new Uint8Array(bytes);
    try {
      for (let offset = 0, eof = bytes === 0; !eof;) {
        const chunk = await this.request("transfer/read", { transferId: transferId!, offset });
        const part = Buffer.from(chunk.data, "base64");
        // No progress and no end means the bytes are not there: fail rather
        // than ask for the same offset forever.
        if ((!part.length && !chunk.eof) || offset + part.length > bytes) throw new HarnessClientError("invalid_archive", `Archive transfer ended at ${offset} of ${bytes} bytes`);
        archive.set(part, offset); offset += part.length; eof = chunk.eof;
      }
    } finally { await this.request("transfer/close", { transferId: transferId! }).catch(() => {}); }
    if (createHash("sha256").update(archive).digest("hex") !== sha256) throw new HarnessClientError("invalid_archive", "Received archive does not match its SHA-256");
    return archive;
  }
  /** Send archive bytes over the connection in bounded chunks, then import them as a new session. */
  async importArchive(archive: Uint8Array, sessionId?: string) {
    const { transferId, limits } = await this.request("transfer/open", { bytes: archive.length, sha256: createHash("sha256").update(archive).digest("hex") });
    try {
      for (let offset = 0; offset < archive.length; offset += limits.chunkBytes)
        await this.request("transfer/write", { transferId, offset, data: Buffer.from(archive.subarray(offset, offset + limits.chunkBytes)).toString("base64") });
    } catch (error) { await this.request("transfer/close", { transferId }).catch(() => {}); throw error; }
    return this.request("session/import", { from: { type: "transfer", transferId }, ...(sessionId === undefined ? {} : { sessionId }) });
  }
  /** Resolves when the input is accepted (Received), never with a reply. Follow
   * `turn_started`/`turn_took` for the item ID to find the turn that took it. */
  push(params: PushParams) { return this.request("channel/push", params); }
  createChannel(params: Calls["channel/create"]["params"]) { return this.request("channel/create", params); }
  editChannel(params: Calls["channel/edit"]["params"]) { return this.request("channel/edit", params); }
  suspendChannel(params: Calls["channel/suspend"]["params"]) { return this.request("channel/suspend", params); }
  resumeChannel(params: Calls["channel/resume"]["params"]) { return this.request("channel/resume", params); }
  deleteChannel(params: Calls["channel/delete"]["params"]) { return this.request("channel/delete", params); }
  withdrawItem(params: Calls["channel/withdraw"]["params"]) { return this.request("channel/withdraw", params); }
  interruptTurn(params: Calls["channel/interrupt"]["params"]) { return this.request("channel/interrupt", params); }
  idle() { return this.request("session/idle", {}); }
  onChannelEvent(listener: EventSink) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onSessionEvent(listener: SessionEventSink) { this.sessionListeners.add(listener); return () => { this.sessionListeners.delete(listener); }; }
  close() {
    if (this.closed) return;
    this.closed = true; this.unsubscribe(); this.unsubscribeSession(); this.unsubscribeClose(); this.transport.close(); this.listeners.clear(); this.sessionListeners.clear();
    for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(this.terminalError); }
    this.waiting.clear();
  }
}
