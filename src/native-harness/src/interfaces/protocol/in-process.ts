import type { ClientTransport, ProtocolEndpoint, RpcNotification, RpcResponse, RpcSessionNotification } from "../../contracts/protocol.ts";

// Match the data boundary stdio will impose: no shared references or functions.
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function createInProcessTransport(endpoint: ProtocolEndpoint): ClientTransport {
  let closed = false;
  const closeListeners = new Set<(error?: Error) => void>();
  const listeners = new Set<(message: RpcResponse | RpcNotification) => void>();
  const sessionListeners = new Set<(message: RpcSessionNotification) => void>();
  function deliver(message: RpcResponse | RpcNotification) {
    if (closed) return;
    for (const listener of listeners) { try { listener(copy(message)); } catch { /* Isolate observers. */ } }
  }
  // Channel and session notifications share one microtask queue, so they
  // reach the client in the order the endpoint published them.
  const unsubscribeChannel = endpoint.subscribe(message => queueMicrotask(() => deliver(copy(message))));
  const unsubscribeSession = endpoint.subscribeSession?.(message => queueMicrotask(() => {
    if (closed) return;
    for (const listener of sessionListeners) { try { listener(copy(message)); } catch { /* Isolate observers. */ } }
  }));
  const unsubscribe = () => { unsubscribeChannel(); unsubscribeSession?.(); };
  return {
    send(request) {
      if (closed) throw new Error("Transport closed");
      const captured = copy(request);
      queueMicrotask(() => {
        if (closed) return;
        void endpoint.request(captured).then(deliver, error => deliver({ jsonrpc: "2.0", id: captured.id,
          error: { code: -32603, message: String(error), data: { code: "internal_error" } } }));
      });
    },
    subscribe(listener) { if (closed) throw new Error("Transport closed"); listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeSession(listener) { if (closed) throw new Error("Transport closed"); sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
    onClose(listener) {
      if (closed) listener(); else closeListeners.add(listener);
      return () => { closeListeners.delete(listener); };
    },
    close() {
      if (closed) return;
      endpoint.disconnect?.();
      closed = true; unsubscribe(); listeners.clear(); sessionListeners.clear();
      for (const listener of closeListeners) listener();
      closeListeners.clear();
    },
  };
}
