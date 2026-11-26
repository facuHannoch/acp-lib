import { Socket, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
export type ServiceEgress =
  | { mode: "direct" }
  | { mode: "proxy-required"; proxy: string }
  | { mode: "unavailable"; reason: "invalid_egress_mode" | "invalid_egress_proxy" };

export function resolveServiceEgress(environment: Readonly<Record<string, string | undefined>>): ServiceEgress {
  const mode = environment.HARNESS_WEB_EGRESS;
  if (mode === undefined || mode === "direct") return { mode: "direct" };
  if (mode !== "proxy-required") return { mode: "unavailable", reason: "invalid_egress_mode" };
  const raw = environment.HTTPS_PROXY;
  if (raw && /^https?:\/\/[a-z\d.:[\]-]+\/?$/i.test(raw)) {
    const url = URL.parse(raw);
    if (url?.hostname && url.pathname === "/" && !url.username && !url.password) {
      const rawHost = raw.replace(/^https?:\/\//i, "").replace(/\/$/, "").replace(/:\d+$/, "");
      if (isIP(url.hostname) !== 4 || rawHost === url.hostname) return { mode, proxy: url.origin };
    }
  }
  return { mode: "unavailable", reason: "invalid_egress_proxy" };
}

export class ServiceTransportError extends Error {}
export function fixedServiceTransport(origin: string, egress: ServiceEgress, fixtureCa?: string) {
  const destination = new URL(origin);
  if (destination.protocol !== "https:" || destination.origin !== origin) throw new Error("Expected fixed HTTPS origin");
  return async (path: string, headers: Record<string, string>, body: string, signal: AbortSignal) => {
    if (!/^\/[a-z\d/_-]+$/i.test(path) || path.includes("//") ||
        Object.keys(headers).some(name => /^(host|connection|upgrade|transfer-encoding|forwarded|x-forwarded-.*|proxy-.*)$/i.test(name)))
      throw new ServiceTransportError("Service request routing refused");
    if (egress.mode === "unavailable") throw new ServiceTransportError("Service egress unavailable");
    signal.throwIfAborted();
    const undici: typeof import("undici") = await import(new URL("index.js", import.meta.resolve("undici/package.json")).href);
    const tls = (url: URL) => ({
      rejectUnauthorized: true, ca: fixtureCa,
      checkServerIdentity: (_: string, peer: Parameters<typeof checkServerIdentity>[1]) =>
        checkServerIdentity(url.hostname.replace(/^\[|\]$/g, ""), peer),
    });
    const proxy = egress.mode === "proxy-required" ? new undici.Client(egress.proxy, {
      maxHeaderSize: 16 * 1024, connect: tls(new URL(egress.proxy)), allowH2: false,
    }) : undefined;
    let tunnel: Awaited<ReturnType<typeof proxySocket>> | undefined;
    async function proxySocket(client: NonNullable<typeof proxy>) {
      try {
        const authority = `${destination.hostname}:${destination.port || "443"}`;
        const connected = await client.connect({ path: authority, headers: { host: authority }, signal });
        connected.socket.on("error", () => {});
        if (connected.statusCode < 200 || connected.statusCode >= 300) {
          connected.socket.destroy();
          throw new ServiceTransportError("Service CONNECT refused");
        }
        if (!(connected.socket instanceof Socket)) { connected.socket.destroy(); throw new ServiceTransportError("Service CONNECT socket invalid"); }
        return connected.socket;
      } catch (error) {
        if (error instanceof ServiceTransportError) throw error;
        throw new ServiceTransportError("Service proxy connection or TLS failed");
      }
    }
    let dispatcher: InstanceType<typeof undici.Client> | undefined;
    async function close() {
      tunnel?.destroy();
      await Promise.allSettled([dispatcher?.destroy(), proxy?.destroy()]);
    }
    try {
      if (proxy) tunnel = await proxySocket(proxy);
      signal.throwIfAborted();
      const connector = undici.buildConnector({ ...tls(destination), allowH2: false });
      dispatcher = new undici.Client(origin, { connect: (options, callback) =>
        connector({ ...options, httpSocket: tunnel }, callback) });
      const response = await dispatcher.request({ path, method: "POST", headers, body, signal });
      response.body.on("error", () => {});
      if (response.statusCode >= 300 && response.statusCode < 400) throw new ServiceTransportError("Service redirect refused");
      return { response, close };
    } catch (error) {
      await close();
      if (error instanceof ServiceTransportError) throw error;
      throw new ServiceTransportError("Service connection or TLS failed");
    }
  };
}
