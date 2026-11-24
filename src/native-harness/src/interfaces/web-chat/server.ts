import { SESSION_INPUT_MAX_BYTES } from "../../contracts/input-limits.ts";
import { networkInterfaces } from "node:os";
import type { createManagedAttachmentService } from "../../capabilities/attachments/service.ts";

/** Separate LAN surface; the inspector remains bound to loopback. */
export function serveWebChat(handleChannel: (request: Request) => Promise<Response>, port = 3001, token: string = crypto.randomUUID(),
  options: { attachments?: ReturnType<typeof createManagedAttachmentService>; ensureChannel?: (id: string) => void } = {}) {
  const page = Bun.file(new URL("./index.html", import.meta.url)).text().then(
    html => html.replace("__SESSION_INPUT_MAX_BYTES__", String(SESSION_INPUT_MAX_BYTES)),
  );
  const server = Bun.serve({
    hostname: "0.0.0.0", port, development: false, idleTimeout: 0, maxRequestBodySize: 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(await page, { headers: {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        } });
      }
      if (url.pathname !== "/messages" && url.pathname !== "/events" && !url.pathname.startsWith("/attachments/")) return new Response("Not found", { status: 404 });
      const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
      if (supplied !== token) return new Response("Open the pairing link printed by the agent", { status: 401 });
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return new Response("Invalid origin", { status: 403 });
      if (url.pathname.startsWith("/attachments/")) {
        const service = options.attachments;
        if (!service) return Response.json({ error: "Attachments are unavailable", code: "incompatible" }, { status: 404 });
        if (request.method !== "POST") return new Response("Use POST", { status: 405 });
        try {
          const body = await request.json() as Record<string, unknown>;
          if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.channel !== "string" || !body.channel.trim()) throw new Error("Invalid attachment request");
          const channel = body.channel;
          const exact = (keys: string[]) => { if (Object.keys(body).some(key => !keys.includes(key))) throw new Error("Invalid attachment field"); };
          if (url.pathname === "/attachments/begin") {
            exact(["channel", "filename", "mediaType", "bytes", "sha256"]); options.ensureChannel?.(channel);
            return Response.json(service.begin({ channel, filename: body.filename as string, mediaType: body.mediaType as string, bytes: body.bytes as number, sha256: body.sha256 as string }));
          }
          if (url.pathname === "/attachments/read") { exact(["channel", "id", "offset"]); return Response.json(service.read(channel, body.id as string, body.offset as number)); }
          if (typeof body.uploadId !== "string" || !body.uploadId) throw new Error("Invalid upload ID");
          if (url.pathname === "/attachments/status") { exact(["channel", "uploadId"]); return Response.json(service.status(channel, body.uploadId)); }
          if (url.pathname === "/attachments/write") { exact(["channel", "uploadId", "offset", "data"]); return Response.json(service.write(channel, body.uploadId, body.offset as number, body.data as string)); }
          if (url.pathname === "/attachments/finalize") { exact(["channel", "uploadId"]); return Response.json(await service.finalize(channel, body.uploadId)); }
          if (url.pathname === "/attachments/abort") { exact(["channel", "uploadId"]); service.abort(channel, body.uploadId); return Response.json({}); }
          return new Response("Not found", { status: 404 });
        } catch (error) {
          const fault = error as { code?: string; message?: string; expectedOffset?: number };
          return Response.json({ error: fault.message ?? String(error), code: fault.code ?? "invalid_params", ...(fault.expectedOffset === undefined ? {} : { expectedOffset: fault.expectedOffset }) }, { status: fault.code === "not_found" ? 404 : 400 });
        }
      }
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
