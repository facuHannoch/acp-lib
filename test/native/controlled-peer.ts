import { HarnessClient } from "../../src/native-harness/src/client.ts";
import type { ClientTransport, RpcRequest } from "../../src/native-harness/src/contracts/protocol.ts";

export function controlledHarnessPeer(answer: (request: RpcRequest) => unknown, timeoutMs: number) {
  const requests: RpcRequest[] = [];
  let deliver: Parameters<ClientTransport["subscribe"]>[0] = () => {};
  const transport: ClientTransport = {
    send(request) {
      requests.push(request);
      const result = answer(request);
      if (result !== undefined) deliver({ jsonrpc: "2.0", id: request.id, result });
    },
    subscribe(listener) { deliver = listener; return () => {}; },
    onClose: () => () => {},
    close() {},
  };
  return { client: new HarnessClient(transport, timeoutMs), requests };
}
