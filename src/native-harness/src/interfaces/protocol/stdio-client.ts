import type { ClientTransport, StdioConnection, RpcCallbackCancel, RpcCallbackRequest, RpcResponse, RpcNotification, RpcSessionNotification } from "../../contracts/protocol.ts";
type Callback = RpcCallbackRequest | RpcCallbackCancel;
/** Decision 0021: a request or cancellation from the harness. */
function callback(value: any): value is Callback {
  if (!value || value.jsonrpc !== "2.0" || !value.params || typeof value.params !== "object") return false;
  if (value.method === "functions/cancel") return typeof value.params.invocationId === "string" && typeof value.params.reason === "string";
  if (!Number.isSafeInteger(value.id)) return false;
  if (value.method === "functions/call") return [value.params.invocationId, value.params.sessionId, value.params.channel, value.params.turnId, value.params.tool, value.params.handler].every(field => typeof field === "string")
    && !!value.params.arguments && typeof value.params.arguments === "object";
  return value.method === "results/read" && [value.params.resultId, value.params.invocationId, value.params.channel].every(field => typeof field === "string")
    && Number.isSafeInteger(value.params.offset) && Number.isSafeInteger(value.params.length);
}
import { LineDecoder, LineWriter } from "./framing.ts";

const strings = (value: unknown) => Array.isArray(value) && value.every((id: unknown) => typeof id === "string");
function message(value: any): value is RpcResponse | RpcNotification | RpcSessionNotification {
  if (!value || value.jsonrpc !== "2.0") return false;
  if (value.method === "session/event") return value.params?.type === "lifecycle" && Number.isSafeInteger(value.params.revision)
    && ["running", "suspending", "suspended"].includes(value.params.lifecycle);
  if (value.method === "channel/event") {
    if (typeof value.params?.channel !== "string" || !value.params?.event) return false;
    if (value.params.revision !== undefined && !Number.isSafeInteger(value.params.revision)) return false;
    const event = value.params.event;
    if (event.type === "channel_state") return ["open", "suspending", "suspended", "retired"].includes(event.lifecycle)
      && (event.displayName === undefined || typeof event.displayName === "string") && (event.policy === undefined || typeof event.policy === "string");
    if (event.type === "item_withdrawn") return typeof event.item === "string";
    if (typeof event.turnId !== "string") return false;
    switch (event.type) {
      case "turn_started": case "turn_took": return strings(event.items);
      case "items_receipt": return strings(event.items) && ["delivered", "seen"].includes(event.milestone);
      case "turn_suspended": case "turn_resumed": return true;
      case "approval_closed": return typeof event.requestId === "string" && typeof event.reason === "string";
      case "approval_requested": return typeof event.requestId === "string" && typeof event.channel === "string"
        && typeof event.toolCallId === "string" && typeof event.tool === "string" && typeof event.arguments === "string";
      case "turn_ended": return ["completed", "failed", "interrupted"].includes(event.outcome)
        && (event.error === undefined || typeof event.error === "string")
        && (event.uncertainCalls === undefined || strings(event.uncertainCalls));
      case "text_delta": return typeof event.messageId === "string" && typeof event.text === "string";
      case "text_gap": return typeof event.messageId === "string";
      case "text_incomplete": return typeof event.messageId === "string" && ["failed", "incomplete", "output_limit", "timeout", "interrupted"].includes(event.reason);
      case "message_completed": return typeof event.messageId === "string" && (event.reference === true && event.parts === undefined || Array.isArray(event.parts)
        && event.parts.every((part: any) => part?.type === "text" && typeof part.text === "string"));
      case "tool_call": return typeof event.id === "string" && typeof event.name === "string"
        && ["started", "completed", "failed", "skipped", "interrupted"].includes(event.status)
        && (event.invocationId === undefined || typeof event.invocationId === "string")
        && (event.input === undefined || typeof event.input === "string")
        && (event.output === undefined || typeof event.output === "string");
      default: return false;
    }
  }
  if ("method" in value) return false;
  if (value.id !== null && !Number.isSafeInteger(value.id)) return false;
  if ("error" in value) return !("result" in value) && typeof value.error?.code === "number"
    && typeof value.error?.message === "string" && typeof value.error?.data?.code === "string";
  return value.id !== null && "result" in value;
}

export function createStdioTransport(connection: StdioConnection): ClientTransport {
  let closed = false;
  let failure: Error | undefined;
  const listeners = new Set<(value: RpcResponse | RpcNotification) => void>();
  const sessionListeners = new Set<(value: RpcSessionNotification) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  const callbackListeners = new Set<(value: Callback) => void>();
  const reader = connection.readable.getReader();
  const writer = new LineWriter(connection.write);
  function stop(error?: Error) {
    if (closed) return;
    closed = true; failure = error;
    void reader.cancel().catch(() => {});
    for (const listener of closeListeners) { try { listener(error); } catch { /* Isolate consumers. */ } }
    closeListeners.clear(); listeners.clear(); sessionListeners.clear(); callbackListeners.clear();
    // Close stdin only after queued frames. Process ownership stays with host.
    void writer.flush().catch(() => {}).then(() => connection.end()).catch(() => {});
  }
  const decoder = new LineDecoder();
  void (async () => {
    try {
      while (!closed) {
        const chunk = await reader.read();
        if (chunk.done) { decoder.finish(); stop(new Error("Protocol output closed")); break; }
        for (const line of decoder.push(chunk.value)) {
          const value: unknown = JSON.parse(line);
          // Handlers run in the listener's own tasks: reading never waits for one.
          if (callback(value)) { for (const listener of callbackListeners) { try { listener(structuredClone(value)); } catch { /* Consumer isolation. */ } } continue; }
          if (!message(value)) throw new Error("Invalid protocol message from server");
          // Lifecycle notifications never reach channel/response listeners.
          if ("method" in value && value.method === "session/event") {
            for (const listener of sessionListeners) { try { listener(structuredClone(value)); } catch { /* Consumer isolation. */ } }
          } else for (const listener of listeners) { try { listener(structuredClone(value as RpcResponse | RpcNotification)); } catch { /* Consumer isolation. */ } }
        }
      }
    } catch (error) { stop(new Error(`Protocol connection failed: ${String(error)}`)); }
    finally { reader.releaseLock(); }
  })();
  // Let buffered stdout drain before interpreting a normal exit as EOF.
  void connection.exited?.then(code => { if (code !== 0) stop(new Error(`Harness process exited with code ${code}`)); }, error => stop(new Error(String(error))));
  return {
    send(request) {
      if (closed) throw failure ?? new Error("Transport closed");
      try { void writer.send(request).catch(error => stop(new Error(String(error)))); }
      catch (error) { stop(new Error(String(error))); throw error; }
    },
    subscribe(listener) { if (closed) throw failure ?? new Error("Transport closed"); listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeSession(listener) { if (closed) throw failure ?? new Error("Transport closed"); sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
    subscribeCallbacks(listener) { if (closed) throw failure ?? new Error("Transport closed"); callbackListeners.add(listener); return () => { callbackListeners.delete(listener); }; },
    respond(response) { if (closed) return; try { void writer.send(response).catch(error => stop(new Error(String(error)))); } catch (error) { stop(new Error(String(error))); } },
    onClose(listener) { if (closed) listener(failure); else closeListeners.add(listener); return () => { closeListeners.delete(listener); }; },
    close() { stop(); },
  };
}
