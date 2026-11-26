import html from "./index.html" with { type: "text" };
import type { InspectorBinding } from "./config.ts";
import type { Inspection } from "./state.ts";

/** The managed launcher supplies an exact authority for a wildcard bind. */
export function serveInspector(inspection: Inspection, binding: number | InspectorBinding = 3000,
  project: (body: unknown) => unknown = body => body) {
  const { host, port, authority } = typeof binding === "number"
    ? { host: "127.0.0.1", port: binding, authority: undefined } : binding;
  return Bun.serve({
    hostname: host, port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.method !== "GET") return new Response("Read only", { status: 405 });
      if (request.headers.get("host") !== (authority ?? server.url.host)) return new Response("Invalid host", { status: 403 });
      if (url.pathname === "/") return new Response(html as unknown as string, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
      const json = (body: unknown) => Response.json(project(body), { headers: { "Cache-Control": "no-store" } });
      try {
        if (url.pathname === "/state") return json(inspection.status());
        if (url.pathname === "/context") return json(inspection.liveContext());
        if (url.pathname === "/timeline") {
          const cursor = url.searchParams.get("before");
          if (cursor !== null && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) < 1))
            return new Response("Invalid timeline position", { status: 400 });
          return json(inspection.timeline(cursor === null ? undefined : Number(cursor)));
        }
        if (url.pathname === "/channel" || url.pathname === "/calls") {
          const id = url.searchParams.get("id");
          return id ? json(url.pathname === "/calls" ? inspection.modelCalls(id) : inspection.channel(id)) : new Response("Channel ID is required", { status: 400 });
        }
      } catch (error) {
        return new Response(String(project(error instanceof Error ? error.message : String(error))), { status: 500 });
      }
      if (url.pathname !== "/events") return new Response("Not found", { status: 404 });
      server.timeout(request, 0);
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = () => {
            // Drop slow connections; EventSource reconnects with a fresh snapshot.
            if ((controller.desiredSize ?? 0) <= 0) {
              clearTimeout(timer); unsubscribe(); controller.close(); return;
            }
            controller.enqueue(new TextEncoder().encode("data: changed\n\n"));
          };
          unsubscribe = inspection.subscribe(() => {
            timer ??= setTimeout(() => { timer = undefined; send(); }, 40);
          });
          send();
        },
        cancel() { clearTimeout(timer); unsubscribe(); },
      });
      return new Response(stream, { headers: {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      } });
    },
  });
}
