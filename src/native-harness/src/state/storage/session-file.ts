import type { PortableSessionConfig } from "../../contracts/session-file.ts";

/** Narrow, definite-length CBOR profile for JSON-compatible session data. */
export class SessionFileError extends Error {
  constructor(readonly code: "invalid_archive" | "transfer_limit" | "serialization_error", message: string) { super(message); }
}
const bad = (message: string): never => { throw new Error(message); };
export function validateConfig(value: unknown): PortableSessionConfig {
  const v = value as any;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "model,system,version"
    || v.version !== 1 || typeof v.system !== "string" || !v.model || typeof v.model !== "object" || Array.isArray(v.model)
    || Object.keys(v.model).sort().join() !== "protocol,script" || v.model.protocol !== "scripted"
    || typeof v.model.script !== "string" || !v.model.script.trim()) bad("Invalid portable configuration");
  return structuredClone(v);
}
function cborEncode(value: unknown): Uint8Array {
  const chunks: Uint8Array[] = [];
  const head = (major: number, n: number) => {
    if (!Number.isSafeInteger(n) || n < 0) bad("Invalid CBOR length");
    if (n < 24) { chunks.push(Uint8Array.of(major * 32 + n)); return; }
    const size = n <= 255 ? 1 : n <= 65535 ? 2 : n <= 0xffffffff ? 4 : 8;
    const bytes = new Uint8Array(1 + size), view = new DataView(bytes.buffer);
    bytes[0] = major * 32 + ({ 1: 24, 2: 25, 4: 26, 8: 27 } as Record<number, number>)[size]!;
    if (size === 1) view.setUint8(1, n); else if (size === 2) view.setUint16(1, n); else if (size === 4) view.setUint32(1, n); else view.setBigUint64(1, BigInt(n));
    chunks.push(bytes);
  };
  const visit = (v: unknown, depth: number) => {
    if (v === null) { chunks.push(Uint8Array.of(0xf6)); return; }
    if (typeof v === "boolean") { chunks.push(Uint8Array.of(v ? 0xf5 : 0xf4)); return; }
    if (typeof v === "number") {
      if (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))) bad("Invalid number");
      if (Number.isSafeInteger(v) && !Object.is(v, -0)) { head(v >= 0 ? 0 : 1, v >= 0 ? v : -1 - v); return; }
      const bytes = new Uint8Array(9); bytes[0] = 0xfb; new DataView(bytes.buffer).setFloat64(1, v); chunks.push(bytes); return;
    }
    if (typeof v === "string") { const bytes = new TextEncoder().encode(v); if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== v) bad("Invalid text"); head(3, bytes.length); chunks.push(bytes); return; }
    if (!v || typeof v !== "object" || depth >= 128) bad("Invalid value or nesting");
    if (Array.isArray(v)) { head(4, v.length); for (const x of v) visit(x, depth + 1); return; }
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) bad("Invalid map");
    const entries = Object.entries(v as object); head(5, entries.length); for (const [k, x] of entries) { visit(k, depth + 1); visit(x, depth + 1); }
  };
  visit(value, 0);
  return Buffer.concat(chunks);
}
function cborDecode(bytes: Uint8Array): unknown {
  let pos = 0; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const take = (n: number) => { if (!Number.isSafeInteger(n) || n < 0 || n > bytes.length - pos) bad("Truncated CBOR"); const p = pos; pos += n; return p; };
  const arg = (a: number): number => {
    if (a < 24) return a;
    if (a === 24) return view.getUint8(take(1));
    if (a === 25) return view.getUint16(take(2));
    if (a === 26) return view.getUint32(take(4));
    if (a === 27) { const n = view.getBigUint64(take(8)); if (n > BigInt(Number.MAX_SAFE_INTEGER)) bad("Unsafe integer"); return Number(n); }
    return bad("Invalid or indefinite CBOR argument");
  };
  const visit = (depth: number): unknown => {
    const b = view.getUint8(take(1)), major = b >> 5, a = b & 31;
    if (major === 0 || major === 1) { const n = arg(a); const v = major === 0 ? n : -1 - n; if (!Number.isSafeInteger(v)) bad("Unsafe integer"); return v; }
    if (major === 3) { const n = arg(a), p = take(n); return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(p, p + n)); }
    if (major === 4 || major === 5) {
      if (depth >= 128) bad("CBOR nesting limit"); const n = arg(a); if (n > bytes.length - pos) bad("Invalid CBOR container length");
      if (major === 4) { const out: unknown[] = []; for (let i = 0; i < n; i++) out.push(visit(depth + 1)); return out; }
      const out: Record<string, unknown> = Object.create(null);
      for (let i = 0; i < n; i++) { const k = visit(depth + 1); if (typeof k !== "string" || Object.hasOwn(out, k)) bad("Invalid map key"); Object.defineProperty(out, k as string, { value: visit(depth + 1), enumerable: true, writable: true, configurable: true }); }
      return out;
    }
    if (major === 7) {
      if (a === 20) return false; if (a === 21) return true; if (a === 22) return null;
      let n: number;
      if (a === 25) { const bits = view.getUint16(take(2)), sign = bits & 0x8000 ? -1 : 1, exp = (bits >> 10) & 31, frac = bits & 1023; n = exp === 0 ? sign * 2 ** -14 * (frac / 1024) : exp === 31 ? (frac ? NaN : sign * Infinity) : sign * 2 ** (exp - 15) * (1 + frac / 1024); }
      else if (a === 26) n = view.getFloat32(take(4)); else if (a === 27) n = view.getFloat64(take(8)); else return bad("Unsupported CBOR simple value");
      if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) bad("Invalid number"); return n;
    }
    return bad("Unsupported CBOR type");
  };
  const value = visit(0); if (pos !== bytes.length) bad("Extra CBOR item"); return value;
}
export function encodeSessionFile(value: unknown, maxBytes: number): Uint8Array {
  let payload: Uint8Array;
  try { payload = cborEncode(value); } catch (e) { throw new SessionFileError("serialization_error", String(e)); }
  if (payload.length > 0xffffffff || payload.length + 14 > maxBytes) throw new SessionFileError("transfer_limit", "Session file exceeds limit");
  const bytes = new Uint8Array(14 + payload.length); bytes.set(new TextEncoder().encode("HARNSESS")); const view = new DataView(bytes.buffer); view.setUint16(8, 1); view.setUint32(10, payload.length); bytes.set(payload, 14); return bytes;
}
export function decodeSessionFile(bytes: Uint8Array, maxBytes: number): unknown {
  if (bytes.length < 14 || new TextDecoder().decode(bytes.subarray(0, 8)) !== "HARNSESS") throw new SessionFileError("invalid_archive", "Invalid session file header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(8) !== 1 || bytes.length !== 14 + view.getUint32(10)) throw new SessionFileError("invalid_archive", "Invalid session file version or length");
  if (bytes.length > maxBytes) throw new SessionFileError("transfer_limit", "Session file exceeds limit");
  try { return cborDecode(bytes.subarray(14)); } catch (e) { throw new SessionFileError("invalid_archive", String(e)); }
}
