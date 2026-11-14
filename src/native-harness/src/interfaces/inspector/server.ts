import type { Inspection } from "./state.ts";

/** Read-only development UI, bound to loopback only. */
export function serveInspector(inspection: Inspection, port = 3000) {
  return Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.method !== "GET") return new Response("Read only", { status: 405 });
      if (request.headers.get("host") !== server.url.host) return new Response("Invalid host", { status: 403 });
      if (url.pathname === "/") return new Response(Bun.file(new URL("./index.html", import.meta.url)), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
      if (url.pathname === "/state") return Response.json(inspection.snapshot(), {
        headers: { "Cache-Control": "no-store" },
      });
      if (url.pathname !== "/events") return new Response("Not found", { status: 404 });
      server.timeout(request, 0);
      let unsubscribe = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = () => {
            // Drop slow connections; EventSource reconnects with a fresh snapshot.
            if ((controller.desiredSize ?? 0) <= 0) {
              unsubscribe(); controller.close(); return;
            }
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(inspection.snapshot())}\n\n`));
          };
          unsubscribe = inspection.subscribe(send);
          send();
        },
        cancel() { unsubscribe(); },
      });
      return new Response(stream, { headers: {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      } });
    },
  });
}
