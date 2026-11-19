import type { ClientTransport, ProtocolEndpoint, RpcNotification, RpcResponse } from "../../contracts/protocol.ts";

// Match the data boundary stdio will impose: no shared references or functions.
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function createInProcessTransport(endpoint: ProtocolEndpoint): ClientTransport {
  let closed = false;
  const closeListeners = new Set<(error?: Error) => void>();
  const listeners = new Set<(message: RpcResponse | RpcNotification) => void>();
  function deliver(message: RpcResponse | RpcNotification) {
    if (closed) return;
    for (const listener of listeners) { try { listener(copy(message)); } catch { /* Isolate observers. */ } }
  }
  const unsubscribe = endpoint.subscribe(message => queueMicrotask(() => deliver(copy(message))));
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
    onClose(listener) {
      if (closed) listener(); else closeListeners.add(listener);
      return () => { closeListeners.delete(listener); };
    },
    close() {
      if (closed) return;
      closed = true; unsubscribe(); listeners.clear();
      for (const listener of closeListeners) listener();
      closeListeners.clear();
    },
  };
}
