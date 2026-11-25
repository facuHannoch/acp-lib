import { fixedServiceTransport, type ServiceEgress } from "./service-egress.ts";
import { request } from "node:https";
import { Transform, Writable, type Readable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { ExaTransport } from "./exa.ts";

const cap = 2 * 1024 * 1024;
export class ExaResponseLimit extends Error {}
/** Streaming transform limits input before any decompressing allocation. */
export function boundedBytes(max: number): Transform {
  let total = 0;
  return new Transform({ transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
    total += chunk.length;
    if (total > max) done(new ExaResponseLimit("Exa response exceeds size limit")); else done(null, chunk);
  } });
}
async function readExaBody(stream: Readable, header: string | string[] | undefined, signal: AbortSignal) {
  const encoding = typeof header === "string" ? header.trim().toLowerCase() : header === undefined ? "identity" : "";
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
    : encoding === "br" ? createBrotliDecompress() : undefined;
  if (!decoder && encoding !== "identity") { stream.destroy(); throw new Error("Unsupported Exa content encoding"); }
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done(); } });
  if (decoder) await pipeline(stream, boundedBytes(cap), decoder, boundedBytes(cap), sink, { signal });
  else await pipeline(stream, boundedBytes(cap), sink, { signal });
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { return undefined; }
}

/** Fixed Exa origin: no redirects, proxy forwarding, cookies or source-site secrets. */
/** Injection is an assembly-only offline test seam, not managed configuration. */
export function createExaHttpsTransport(send: typeof request = request): ExaTransport {
 return ({ path, key, body, signal }) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const req = send({ protocol: "https:", hostname: "api.exa.ai", port: 443, method: "POST", path, signal,
    headers: { "content-type": "application/json", "accept": "application/json", "accept-encoding": "gzip, deflate, br", "content-length": Buffer.byteLength(payload), "x-api-key": key } }, async response => {
    const status = response.statusCode ?? 0;
    try {
      resolve({ status, body: await readExaBody(response, response.headers["content-encoding"], signal) });
    } catch (error) { reject(error); }
  });
  req.on("error", reject);
  req.end(payload);
 });
}
export const exaHttpsTransport = createExaHttpsTransport();

export function exaServiceTransport(egress: ServiceEgress, origin = "https://api.exa.ai", fixtureCa?: string): ExaTransport {
  const send = fixedServiceTransport(origin, egress, fixtureCa);
  return async ({ path, key, body, signal }) => {
    const payload = JSON.stringify(body);
    const { response, close } = await send(path, {
      "content-type": "application/json", accept: "application/json", "accept-encoding": "gzip, deflate, br",
      "content-length": String(Buffer.byteLength(payload)), "x-api-key": key,
    }, payload, signal);
    try {
      return { status: response.statusCode, body: await readExaBody(response.body, response.headers["content-encoding"], signal) };
    } finally { await close(); }
  };
}
