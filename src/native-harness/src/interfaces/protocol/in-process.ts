import type { ClientTransport, ProtocolEndpoint, RpcCallbackCancel, RpcCallbackRequest, RpcNotification, RpcResponse, RpcSessionNotification } from "../../contracts/protocol.ts";
type Callback = RpcCallbackRequest | RpcCallbackCancel;
const isCallback = (message: { method?: string }): message is Callback => message.method === "functions/call" || message.method === "results/read" || message.method === "functions/cancel" || message.method === "context/worker-approvals/read";
import { LiveQueue } from "./live-queue.ts";

// Match the data boundary stdio imposes: no shared references or functions.
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function createInProcessTransport(endpoint: ProtocolEndpoint): ClientTransport {
  let closed = false;
  const closeListeners = new Set<(error?: Error) => void>();
  const listeners = new Set<(message: RpcResponse | RpcNotification) => void>();
  const sessionListeners = new Set<(message: RpcSessionNotification) => void>();
  const callbackListeners = new Set<(message: Callback) => void>();
  let unsubscribeChannel = () => {}, unsubscribeSession: (() => void) | undefined, unsubscribeCallbacks: (() => void) | undefined;
  function close(error?: Error) {
    if (closed) return;
    closed = true; endpoint.disconnect?.(); unsubscribeChannel(); unsubscribeSession?.(); unsubscribeCallbacks?.();
    listeners.clear(); sessionListeners.clear(); callbackListeners.clear();
    for (const listener of closeListeners) { try { listener(error); } catch { /* Isolate observers. */ } }
    closeListeners.clear();
  }
  function fail(cause: unknown) {
    if (closed) return;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    close(error);
    // Like stdio's failed writer, a failed connection stops its session; the
    // request is asynchronous but the producer never waits on the consumer.
    void endpoint.request({ jsonrpc: "2.0", id: -1, method: "session/stop", params: {} }).catch(() => {});
  }
  const queue = new LiveQueue(value => new Promise<void>(resolve => queueMicrotask(() => {
    if (!closed) {
      const message = value as RpcResponse | RpcNotification | RpcSessionNotification | Callback;
      if ("method" in message && isCallback(message)) {
        for (const listener of callbackListeners) { try { listener(copy(message)); } catch { /* Isolate observers. */ } }
      } else if ("method" in message && message.method === "session/event") {
        for (const listener of sessionListeners) { try { listener(copy(message)); } catch { /* Isolate observers. */ } }
      } else for (const listener of listeners) { try { listener(copy(message as RpcResponse | RpcNotification)); } catch { /* Isolate observers. */ } }
    }
    resolve();
  })), fail);
  function enqueue(message: RpcResponse | RpcNotification | RpcSessionNotification | Callback) {
    if (closed) return;
    try { queue.send(message); } catch (error) { fail(error); }
  }
  // Notifications and responses use the same bounded queue and preserve order.
  unsubscribeChannel = endpoint.subscribe(enqueue);
  unsubscribeSession = endpoint.subscribeSession?.(enqueue);
  // Callback requests travel in the same queue, so they keep their place among events.
  unsubscribeCallbacks = endpoint.subscribeCallbacks?.(enqueue);
  return {
    send(request) {
      if (closed) throw new Error("Transport closed");
      const captured = copy(request);
      queueMicrotask(() => {
        if (closed) return;
        void endpoint.request(captured).then(enqueue, error => enqueue({ jsonrpc: "2.0", id: captured.id,
          error: { code: -32603, message: String(error), data: { code: "internal_error" } } }));
      });
    },
    subscribe(listener) { if (closed) throw new Error("Transport closed"); listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeSession(listener) { if (closed) throw new Error("Transport closed"); sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
    subscribeCallbacks(listener) { if (closed) throw new Error("Transport closed"); callbackListeners.add(listener); return () => { callbackListeners.delete(listener); }; },
    respond(response) { if (closed) return; const captured = copy(response); queueMicrotask(() => { if (!closed) endpoint.respond?.(captured); }); },
    onClose(listener) { if (closed) listener(); else closeListeners.add(listener); return () => { closeListeners.delete(listener); }; },
    close() { close(); },
  };
}
