import { Resolver } from "node:dns/promises";
import { Readable } from "node:stream";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as connectTls, type TLSSocket } from "node:tls";
import { DirectHttpError, directHostname, publicAddress } from "./direct-address.ts";

export interface DirectSocketTarget {
  address: string;
  family: 4 | 6;
  port: number;
  hostname: string;
  secure: boolean;
}

/** The fixture seam supplies candidates, not a bypass around destination checks. */
export interface DirectTransportDependencies {
  resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
  connect(target: DirectSocketTarget, signal: AbortSignal): Promise<Socket>;
}

async function resolve(hostname: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const resolver = new Resolver();
  const stop = () => resolver.cancel();
  const missing = (error: NodeJS.ErrnoException): string[] => {
    if (error.code === "ENODATA" || error.code === "ENOTFOUND") return [];
    throw error;
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const [a, aaaa] = await Promise.all([resolver.resolve4(hostname).catch(missing), resolver.resolve6(hostname).catch(missing)]);
    return [...a, ...aaaa];
  } finally { signal.removeEventListener("abort", stop); resolver.cancel(); }
}

function closeSocket(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise(resolve => {
    socket.once("close", resolve);
    socket.destroy();
  });
}

export function dialDirect(target: DirectSocketTarget, signal: AbortSignal, trustedCa?: string): Promise<Socket> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const options = { host: target.address, family: target.family, port: target.port };
    const socket = target.secure ? connectTls({
      ...options, ...(isIP(target.hostname) ? {} : { servername: target.hostname }),
      ALPNProtocols: ["http/1.1"], ca: trustedCa,
      rejectUnauthorized: true, checkServerIdentity: (_hostname, certificate) => checkServerIdentity(target.hostname, certificate),
    }) : connect(options);
    const event = target.secure ? "secureConnect" : "connect";
    const cleanup = () => {
      socket.removeListener(event, ready);
      socket.removeListener("error", failed);
      signal.removeEventListener("abort", stop);
    };
    const ready = () => {
      if (target.secure) {
        const tls = socket as TLSSocket;
        try {
          if (!tls.authorized || checkServerIdentity(target.hostname, tls.getPeerCertificate())) {
            throw new Error("Web TLS verification failed.");
          }
        } catch {
          failed(new Error("Web TLS verification failed."));
          return;
        }
      }
      cleanup();
      resolve(socket);
    };
    const failed = (error: Error) => {
      cleanup();
      void closeSocket(socket).then(() => reject(error));
    };
    const stop = () => failed(signal.reason);
    socket.once(event, ready);
    socket.once("error", failed);
    signal.addEventListener("abort", stop, { once: true });
  });
}

export const directTransport: DirectTransportDependencies = { resolve, connect: dialDirect };

export async function requestDirect(url: URL, signal: AbortSignal, dependencies = directTransport): Promise<DirectResponse> {
  signal.throwIfAborted();
  const hostname = directHostname(url);
  const addresses = isIP(hostname) ? [hostname] : await dependencies.resolve(hostname, signal);
  signal.throwIfAborted();
  if (!addresses.length) throw new DirectHttpError("page_unavailable", "Web hostname had no addresses.");
  const families = addresses.map(publicAddress);
  const address = addresses[0]!, family = families[0]!, secure = url.protocol === "https:";
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  const socket = await dependencies.connect({ address, family, port, hostname, secure }, signal);
  try {
    signal.throwIfAborted();
    const peer = socket.remoteAddress, type = family === 4 ? "ipv4" : "ipv6";
    const exact = new BlockList();
    exact.addAddress(address, type);
    if (!peer || publicAddress(peer) !== family || !exact.check(peer, type) || socket.remotePort !== port)
      throw new DirectHttpError("blocked_destination", "Connected peer did not match the validated destination.");
    return await readPinnedResponse(socket, url, signal);
  } catch (error) { await closeSocket(socket); throw error; }
}

// This stage takes ownership of the already-connected and verified socket.
export async function readPinnedResponse(socket: Socket, url: URL, signal: AbortSignal): Promise<DirectResponse> {
  try {
    signal.throwIfAborted();
    const stop = () => socket.destroy(new Error("Web request aborted."));
    signal.addEventListener("abort", stop, { once: true });
    socket.once("close", () => signal.removeEventListener("abort", stop));
    const reader = new ResponseReader(socket);
    socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: text/plain, text/html\r\nAccept-Encoding: gzip, deflate, br\r\nConnection: close\r\n\r\n`);
    return await reader.response();
  } catch (error) { await closeSocket(socket); throw error; }
}

interface DirectResponse {
  statusCode: number;
  headers: Record<string, string | undefined>;
  body: Readable;
  close(): Promise<void>;
}

const malformed = () => new DirectHttpError("page_unavailable", "Malformed web response.");

// Parse only the response framing required by a one-shot HTTP/1.x GET.
class ResponseReader {
  readonly #iterator: AsyncIterator<Buffer>;
  #buffer: Buffer = Buffer.alloc(0);
  #offset = 0;

  constructor(readonly socket: Socket) {
    this.#iterator = socket[Symbol.asyncIterator]();
  }

  async #fill() {
    const next = await this.#iterator.next();
    this.#buffer = next.done ? Buffer.alloc(0) : next.value;
    this.#offset = 0;
    return !next.done;
  }

  async #line(limit: number): Promise<string> {
    const chunks: Buffer[] = [];
    let length = 0;
    while (this.#offset < this.#buffer.length || await this.#fill()) {
      const lf = this.#buffer.indexOf(10, this.#offset);
      const end = lf < 0 ? this.#buffer.length : lf + 1;
      const part = this.#buffer.subarray(this.#offset, end);
      length += part.length;
      if (length > limit) throw malformed();
      chunks.push(part);
      this.#offset = end;
      if (lf >= 0) {
        const line = Buffer.concat(chunks, length);
        if (line.length < 2 || line[line.length - 2] !== 13) throw malformed();
        return line.subarray(0, -2).toString("latin1");
      }
    }
    throw malformed();
  }

  async *#bytes(count?: number) {
    while (count !== 0) {
      if (this.#offset === this.#buffer.length && !await this.#fill()) {
        if (count !== undefined) throw malformed();
        return;
      }
      const take = Math.min(count ?? Infinity, this.#buffer.length - this.#offset);
      const part = this.#buffer.subarray(this.#offset, this.#offset + take);
      this.#offset += take;
      if (count !== undefined) count -= take;
      yield part;
    }
  }

  async *#body(mode: "chunked" | "fixed", size?: number) {
    try {
      if (mode === "fixed") { yield* this.#bytes(size); return; }
      let framing = 0;
      for (;;) {
        const line = await this.#line(1024);
        framing += line.length + 4;
        if (framing > 64 * 1024) throw malformed();
        const hex = /^([0-9a-f]+)(?:;[^\x00-\x1f\x7f]*)?$/i.exec(line)?.[1];
        const bytes = hex === undefined ? NaN : parseInt(hex, 16);
        if (!Number.isSafeInteger(bytes)) throw malformed();
        if (bytes === 0) { await this.#headers(); return; }
        yield* this.#bytes(bytes);
        if (await this.#line(2) !== "") throw malformed();
      }
    } finally { await closeSocket(this.socket); }
  }

  async #headers() {
    const headers: Record<string, string | undefined> = Object.create(null);
    let remaining = 16 * 1024;
    for (;;) {
      const line = await this.#line(remaining);
      remaining -= line.length + 2;
      if (line === "") return headers;
      const match = /^([!#$%&'*+.^_`|~\w-]+):[ \t]*([^\x00-\x08\x0a-\x1f\x7f]*)$/.exec(line);
      if (!match) throw malformed();
      const name = match[1]!.toLowerCase();
      if (headers[name] !== undefined && ["content-length", "transfer-encoding", "location", "content-encoding", "content-type"].includes(name)) throw malformed();
      headers[name] = match[2]!.trim();
    }
  }

  async response(): Promise<DirectResponse> {
    let statusCode: number;
    let headers: Record<string, string | undefined>;
    for (let informational = 0; ; informational++) {
      const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: [^\r\n]*)?$/.exec(await this.#line(1024));
      if (!status || informational === 5) throw malformed();
      statusCode = Number(status[1]);
      headers = await this.#headers();
      if (statusCode >= 200) break;
      if (statusCode === 101) throw malformed();
    }
    const transfer = headers["transfer-encoding"]?.toLowerCase();
    const length = headers["content-length"];
    if (transfer !== undefined && (transfer !== "chunked" || length !== undefined)) throw malformed();
    if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw malformed();
    const empty = statusCode === 204 || statusCode === 304;
    const body = Readable.from(this.#body(!empty && transfer === "chunked" ? "chunked" : "fixed",
      empty ? 0 : length === undefined ? undefined : Number(length)), { objectMode: false });
    body.once("close", () => this.socket.destroy());
    return { statusCode, headers, body, close: () => closeSocket(this.socket) };
  }
}
