import { Readable } from "node:stream";
import { connectMcp, supportedMcpVersions } from "./client.ts";

const receiveLimit = 256 * 1024;
type Fetch = (...args: Parameters<typeof fetch>) => Promise<Response>;

export function connectMcpHttps(name: string, endpoint: string, headers: Record<string, string>,
  deadlineMs?: number, secrets?: readonly string[], fixtureCa?: string) {
  return connectMcp(name, async () => {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    // The Bun package-name shim delegates back to proxy-aware Bun fetch.
    const undici: typeof import("undici") = await import(new URL("index.js", import.meta.resolve("undici/package.json")).href);
    const dispatcher = new undici.Agent({ headersTimeout: 0, bodyTimeout: 0,
      connect: { rejectUnauthorized: true, ...(fixtureCa === undefined ? {} : { ca: fixtureCa }) } });
    const send: Fetch = async (input, init) => {
      const response = await dispatcher.request({
        origin: new URL(String(input)).origin,
        path: new URL(String(input)).pathname,
        method: "POST", body: String(init?.body), signal: init?.signal ?? undefined,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), "accept-encoding": "identity" },
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else for (const item of value ?? []) headers.append(name, item);
      }
      const encoding = headers.get("content-encoding");
      if ((response.statusCode >= 300 && response.statusCode < 400) || (encoding && encoding.toLowerCase() !== "identity")) {
        response.body.destroy();
        throw new Error("MCP HTTPS response refused");
      }
      if ([204, 205, 304].includes(response.statusCode)) {
        response.body.destroy();
        return new Response(null, { status: response.statusCode, headers });
      }
      return new Response(Readable.toWeb(response.body) as ReadableStream<Uint8Array>, { status: response.statusCode, headers });
    };
    const requests = new Map<number | string, AbortController>();
    const finished = new Set<number | string>();
    const receiveFailure = (id: number | string, lifetime: AbortController) => {
      setTimeout(() => {
        if (requests.get(id) === lifetime && !lifetime.signal.aborted && !finished.has(id)) void transport.close().catch(() => {});
        release(id);
      }, 0);
    };
    function release(id: number | string) {
      requests.delete(id);
      finished.delete(id);
    }
    const cancellations = new Set<Promise<void>>();
    const fencedFetch: Fetch = async (input, init) => {
      if (String(input) !== endpoint) throw new Error("MCP endpoint refused");
      if (init?.method === "GET") return new Response(null, { status: 405 });
      if (init?.method !== "POST") throw new Error("MCP method refused");
      const message = JSON.parse(String(init.body));
      const id: unknown = message.id;
      const requestId = typeof id === "number" || typeof id === "string" ? id : undefined;
      const cancelId = message.method === "notifications/cancelled" ? message.params?.requestId : undefined;
      const lifetime = requestId === undefined ? undefined : new AbortController();
      const signals = [init.signal, lifetime?.signal, requestId === undefined ? AbortSignal.timeout(250) : undefined]
        .filter((signal): signal is AbortSignal => !!signal);
      if (lifetime && requestId !== undefined) requests.set(requestId, lifetime);
      let done: (() => void) | undefined;
      if (cancelId !== undefined) {
        let finish!: () => void;
        const pending = new Promise<void>(resolve => { finish = resolve; });
        cancellations.add(pending);
        done = () => { requests.get(cancelId)?.abort(); cancellations.delete(pending); finish(); };
      }
      const releaseRequest = () => { if (requestId !== undefined) release(requestId); };
      try {
        const response = await send(endpoint, { ...init, redirect: "error", signal: AbortSignal.any(signals) });
        if (!response.ok || requestId === undefined) {
          await response.body?.cancel();
          releaseRequest();
          return new Response(null, { status: response.status, headers: response.headers });
        }
        if (!response.body) { releaseRequest(); return response; }
        const reader = response.body.getReader();
        const streamed = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
        let count = 0;
        let jsonStart = !streamed;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                controller.close();
                if (streamed) receiveFailure(requestId, lifetime!);
                else releaseRequest();
                return;
              }
              count += chunk.value.byteLength;
              if (count > receiveLimit) {
                await reader.cancel();
                throw new Error("MCP response limit exceeded");
              }
              if (jsonStart) {
                for (const byte of chunk.value) {
                  if (byte === 32 || byte === 9 || byte === 10 || byte === 13) continue;
                  if (byte === 91) { await reader.cancel(); throw new Error("MCP response batch refused"); }
                  jsonStart = false;
                  break;
                }
              }
              controller.enqueue(chunk.value);
            } catch (error) {
              if (streamed) receiveFailure(requestId, lifetime!);
              else releaseRequest();
              controller.error(error);
            }
          },
          async cancel() { releaseRequest(); await reader.cancel(); },
        });
        return new Response(body, { status: response.status, headers: response.headers });
      } catch {
        releaseRequest();
        throw new Error("MCP HTTPS request failed");
      } finally { done?.(); }
    };
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers },
      fetch: fencedFetch,
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
    });
    const close = transport.close.bind(transport);
    let closing: Promise<void> | undefined;
    transport.close = () => closing ??= (async () => {
      try { await close(); } finally { await dispatcher.destroy(); }
    })();
    const start = transport.start.bind(transport);
    transport.start = async () => {
      const onmessage = transport.onmessage;
      transport.onmessage = message => {
        if ("id" in message && ("result" in message || "error" in message) && message.id !== undefined && requests.has(message.id)) {
          finished.add(message.id);
        }
        onmessage?.(message);
      };
      await start();
    };
    const setVersion = transport.setProtocolVersion.bind(transport);
    transport.setProtocolVersion = version => {
      if (!supportedMcpVersions.has(version)) throw new Error("Unsupported MCP protocol revision");
      setVersion(version);
    };
    return { transport, async drain() {
      // SDK cancellation enters async send before its POST reaches fencedFetch.
      await Bun.sleep(0);
      await Promise.allSettled(cancellations);
    } };
  }, deadlineMs, secrets);
}
