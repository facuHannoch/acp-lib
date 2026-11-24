import type { Readable } from "node:stream";
import { PassThrough, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { DirectHttpError, directUrl } from "./direct-address.ts";
import { requestDirect, type DirectTransportDependencies } from "./direct-transport.ts";

const rawLimit = 2 * 1024 * 1024, decodedLimit = 4 * 1024 * 1024, previewLimit = 2048;
const tooLarge = () => new DirectHttpError("response_too_large", "Web response exceeded the transfer limit.");

async function boundedBody(response: { body: Readable; headers: Record<string, string | undefined> }, signal: AbortSignal, discard: boolean): Promise<Buffer> {
  let received = 0, decoded = 0;
  const chunks: Buffer[] = [];
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
    : encoding === "br" ? createBrotliDecompress() : encoding === undefined || encoding === "identity" ? new PassThrough() : undefined;
  if (!decoder) {
    response.body.destroy();
    throw new DirectHttpError("unsupported_content", "Unsupported response encoding.");
  }
  const count = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    received += chunk.length;
    callback(received > rawLimit ? tooLarge() : null, chunk);
  } });
  const collect = new Writable({ write(chunk: Buffer, _encoding, callback) {
    decoded += chunk.length;
    if (decoded > decodedLimit) { callback(tooLarge()); return; }
    if (!discard) chunks.push(chunk);
    callback();
  } });
  await pipeline(response.body, count, decoder, collect, { signal });
  return Buffer.concat(chunks, discard ? 0 : decoded);
}

const entity = (text: string) => text.replace(/&(#x[\da-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/g, (raw, code: string) => {
  if (code.startsWith("#")) {
    const scalar = code[1] === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return scalar > 0 && scalar <= 0x10ffff && (scalar < 0xd800 || scalar > 0xdfff) ? String.fromCodePoint(scalar) : "�";
  }
  return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[code] ?? raw;
});

function readableHtml(input: string) {
  const output: string[] = [], title: string[] = [];
  const excluded = new Set(["script", "style", "head", "nav", "footer", "noscript", "template", "svg"]);
  const tags = /<!--[\s\S]*?(?:-->|$)|<\/?[a-z][^<>]*>/gi;
  let hidden: string | undefined, inTitle = false, offset = 0;
  for (const match of input.matchAll(tags)) {
    const text = input.slice(offset, match.index);
    if (inTitle) title.push(text);
    else if (!hidden) output.push(text);
    const name = /^<(\/?)([a-z][\w:-]*)/i.exec(match[0]);
    const tag = name?.[2]?.toLowerCase();
    if (tag === "title") inTitle = !name?.[1];
    if (tag && excluded.has(tag) && !name?.[1] && !hidden) hidden = tag;
    if (tag === hidden && name?.[1]) hidden = undefined;
    if (!hidden && ["br", "p", "div", "li", "section", "article", "h1", "h2", "h3", "tr"].includes(tag ?? "")) output.push("\n");
    offset = match.index + match[0].length;
  }
  if (!hidden) output.push(input.slice(offset));
  const clean = (text: string) => entity(text).replace(/[^\S\n]+/g, " ").replace(/\n(?:\s*\n)+/g, "\n").trim();
  return { title: clean(title.join("")) || null, text: clean(output.join("")) };
}

interface DirectPage { url: string; title: string | null; text: string; truncated: boolean; coverage: "full" | "unknown" }

function preview(page: DirectPage): string {
  const fits = () => Buffer.byteLength(JSON.stringify(page)) <= previewLimit;
  if (fits()) return JSON.stringify(page);
  page.truncated = true;
  function shorten(field: "title" | "text") {
    const units: string[] = [];
    for (const scalar of page[field] ?? "") {
      if (units.length === previewLimit) break;
      units.push(scalar);
    }
    const set = (count: number) => { const value = units.slice(0, count).join("");
      if (field === "title") page.title = value || null;
      else page.text = value; };
    set(0);
    if (!fits()) return;
    let lower = 0, upper = units.length;
    while (lower < upper) {
      const mid = Math.ceil((lower + upper) / 2);
      set(mid);
      if (fits()) lower = mid; else upper = mid - 1;
    }
    set(lower);
  }
  if (page.title !== null) shorten("title");
  if (!fits()) shorten("text");
  if (!fits()) throw new DirectHttpError("result_too_large", "The source URL does not fit the result budget.");
  return JSON.stringify(page);
}

export async function fetchDirect(input: string, deadlineMs: number, signal: AbortSignal, dependencies?: DirectTransportDependencies): Promise<string> {
  const expiresAt = performance.now() + deadlineMs;
  const deadline = AbortSignal.timeout(deadlineMs);
  const stop = AbortSignal.any([signal, deadline]);
  try {
    let url = directUrl(input);
    const source = url.href;
    const seen = new Set<string>();
    for (let hops = 0; ; hops++) {
      if (seen.has(url.href)) throw new DirectHttpError("blocked_destination", "Web redirect loop refused.");
      seen.add(url.href);
      const response = await requestDirect(url, stop, dependencies);
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        await boundedBody(response, stop, true);
        if (hops === 5 || !response.headers.location) throw new DirectHttpError("blocked_destination", "Web redirect refused.");
        url = directUrl(response.headers.location, url);
        continue;
      }
      if (status < 200 || status >= 300 || status === 206) {
        await boundedBody(response, stop, true);
        throw new DirectHttpError("page_unavailable", "Web server did not return a successful page.");
      }
      const [mime, ...parameters] = (response.headers["content-type"] ?? "").toLowerCase().split(";");
      const charset = parameters.map(part => part.trim()).find(part => part.startsWith("charset="))?.slice(8).replace(/^"|"$/g, "") ?? "utf-8";
      const bytes = await boundedBody(response, stop, false);
      if (!["text/html", "text/plain"].includes(mime!.trim()) || !["utf-8", "utf8", "us-ascii", "iso-8859-1", "windows-1252"].includes(charset))
        throw new DirectHttpError("unsupported_content", "Only HTML and plain text in supported charsets are readable.");
      let decoded: string;
      try {
        if (charset === "us-ascii" && bytes.some(byte => byte > 127)) throw new Error();
        decoded = new TextDecoder(charset === "windows-1252" || charset === "iso-8859-1" ? "windows-1252" : "utf-8", { fatal: true }).decode(bytes);
      } catch { throw new DirectHttpError("unsupported_content", "Web response cannot be decoded."); }
      const html = mime!.trim() === "text/html";
      const result = html ? readableHtml(decoded) : { title: null, text: decoded.trim() };
      if (!result.text) throw new DirectHttpError("page_unavailable", "Web page has no readable text.");
      const output = preview({ ...result, url: source, truncated: false, coverage: html ? "unknown" : "full" });
      stop.throwIfAborted();
      if (performance.now() >= expiresAt) throw new DirectHttpError("tool_timeout", "Web fetch deadline exceeded.");
      return output;
    }
  } catch (error) {
    if (signal.aborted) throw new DirectHttpError("tool_interrupted", "Web fetch interrupted.");
    if (deadline.aborted) throw new DirectHttpError("tool_timeout", "Web fetch deadline exceeded.");
    if (error instanceof DirectHttpError) throw error;
    throw new DirectHttpError("page_unavailable", "Web destination could not be read.");
  }
}
