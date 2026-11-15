import { networkInterfaces } from "node:os";

/** Separate LAN surface; the inspector remains bound to loopback. */
export function serveWebChat(handleChannel: (request: Request) => Promise<Response>, port = 3001, token: string = crypto.randomUUID()) {
  const server = Bun.serve({
    hostname: "0.0.0.0", port, development: false, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(Bun.file(new URL("./index.html", import.meta.url)), { headers: {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        } });
      }
      if (url.pathname !== "/messages" && url.pathname !== "/events") return new Response("Not found", { status: 404 });
      const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
      if (supplied !== token) return new Response("Open the pairing link printed by the agent", { status: 401 });
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return new Response("Invalid origin", { status: 403 });
      return handleChannel(request);
    },
  });
  const hosts = new Set(["127.0.0.1"]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) if (!address.internal && address.family === "IPv4") hosts.add(address.address);
  }
  return {
    server,
    urls: [...hosts].map(host => `http://${host}:${server.port}/?token=${encodeURIComponent(token)}`),
  };
}
