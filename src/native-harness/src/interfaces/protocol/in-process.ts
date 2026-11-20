import type { ClientTransport, ProtocolEndpoint, RpcNotification, RpcResponse, RpcSessionNotification } from "../../contracts/protocol.ts";
import { LiveQueue } from "./live-queue.ts";

// Match the data boundary stdio imposes: no shared references or functions.
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function createInProcessTransport(endpoint: ProtocolEndpoint): ClientTransport {
  let closed = false;
  const closeListeners = new Set<(error?: Error) => void>();
  const listeners = new Set<(message: RpcResponse | RpcNotification) => void>();
  const sessionListeners = new Set<(message: RpcSessionNotification) => void>();
  let unsubscribeChannel = () => {}, unsubscribeSession: (() => void) | undefined;
  function close(error?: Error) {
    if (closed) return;
    closed = true; endpoint.disconnect?.(); unsubscribeChannel(); unsubscribeSession?.();
    listeners.clear(); sessionListeners.clear();
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
      const message = value as RpcResponse | RpcNotification | RpcSessionNotification;
      if ("method" in message && message.method === "session/event") {
        for (const listener of sessionListeners) { try { listener(copy(message)); } catch { /* Isolate observers. */ } }
      } else for (const listener of listeners) { try { listener(copy(message as RpcResponse | RpcNotification)); } catch { /* Isolate observers. */ } }
    }
    resolve();
  })), fail);
  function enqueue(message: RpcResponse | RpcNotification | RpcSessionNotification) {
    if (closed) return;
    try { queue.send(message); } catch (error) { fail(error); }
  }
  // Notifications and responses use the same bounded queue and preserve order.
  unsubscribeChannel = endpoint.subscribe(enqueue);
  unsubscribeSession = endpoint.subscribeSession?.(enqueue);
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
    onClose(listener) { if (closed) listener(); else closeListeners.add(listener); return () => { closeListeners.delete(listener); }; },
    close() { close(); },
  };
}
