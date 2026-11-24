import type { RetrievedMessage, TimelineSearch, TimelineSearchResult, TimelineWindow, TimelineWindowResult } from "../../contracts/timeline-retrieval.ts";
import { retrievalMessage, scoreTimeline, timelineBytes, timelineQuery, timelineTokens } from "../../util/timeline-text.ts";
import { Fail, type Meta, type Tables } from "./engine.ts";

const maxResponseBudget = 32 * 1024;
const candidateCap = 1000;
const verificationBudget = 2 * 1024 * 1024;
const byteSize = (value: unknown) => timelineBytes(JSON.stringify(value));

function excerpt(text: string, first: number): string {
  // NFC changes token spelling but not the boundaries of ordinary combining
  // sequences. Use the original offsets so the excerpt retains attribution.
  const token = Array.from(text.matchAll(/[\p{L}\p{M}\p{N}]+/gu))[first];
  const before = Array.from(text.slice(0, token?.index ?? 0)).slice(-40).join("");
  const after = text.slice(token?.index ?? 0);
  let result = before, bytes = timelineBytes(before);
  for (const scalar of after) {
    bytes += timelineBytes(scalar);
    if (bytes > 512) break;
    result += scalar;
  }
  return result;
}

export function searchTimeline(tables: Tables, input: TimelineSearch, maxBytes = maxResponseBudget): TimelineSearchResult {
  const responseBudget = Math.min(maxResponseBudget, maxBytes);
  const tokens = timelineQuery(input);
  if (!tokens) throw new Fail("invalid_input", "Query requires searchable words within timeline limits");
  const candidates = tables.retrievalCandidates([...new Set(tokens.map(word => word.folded))], input.channel, candidateCap + 1);
  const form = input.case_sensitive ? "exact" : "folded";
  const wanted = tokens.map(word => word[form]);
  const matches: Array<{ score: number; hit: TimelineSearchResult["hits"][number] }> = [];
  let budget = verificationBudget, partial = candidates.length > candidateCap;
  for (const row of candidates.slice(0, candidateCap)) {
    if (row.bytes > budget) { partial = true; break; }
    budget -= row.bytes;
    const entry = tables.retrievalEntry(row.seq);
    const message = entry && retrievalMessage(entry);
    if (!message || (input.channel !== undefined && message.channel !== input.channel)) continue;
    const { text, ...origin } = message;
    const { score, first } = scoreTimeline(timelineTokens(text).map(word => word[form]), wanted, input.match === "phrase");
    if (score) matches.push({ score, hit: { ...origin, excerpt: excerpt(text, first) } });
  }
  matches.sort((a, b) => b.score - a.score || b.hit.seq - a.hit.seq);
  const hits: TimelineSearchResult["hits"] = [];
  for (const { hit } of matches.slice(0, 20)) {
    if (byteSize({ hits: [...hits, hit], partial: false }) > responseBudget) { partial = true; break; }
    hits.push(hit);
  }
  return { hits, partial };
}

type Cursor = [1, string, string, number, string, number, number, number, number, number, number, number];
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const invalid = () => new Fail("invalid_input", "Invalid timeline window cursor");

function decode(cursor: string): Cursor {
  try {
    const data = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (Array.isArray(data) && data.length === 12 && data[0] === 1 &&
      [data[1], data[2], data[4]].every(value => typeof value === "string") &&
      [data[3], ...data.slice(5)].every(natural) && encode(data as Cursor) === cursor) return data as Cursor;
  } catch { /* invalid below */ }
  throw invalid();
}

function pointRead(tables: Tables, id: string): RetrievedMessage {
  const seq = id.startsWith("item:") ? tables.item(id.slice(5))?.entrySeq :
    /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : tables.retrievalReplyId(id);
  const entry = seq === undefined ? undefined : tables.retrievalEntry(seq);
  const message = entry && retrievalMessage(entry);
  if (!message || message.message_id !== id) throw new Fail("not_found", "Unknown timeline message");
  return message;
}

export function readMessageWindow(tables: Tables, meta: Meta, input: TimelineWindow, maxBytes = maxResponseBudget): TimelineWindowResult {
  const responseBudget = Math.min(maxResponseBudget, maxBytes);
  const saved = input.cursor === undefined ? undefined : decode(input.cursor);
  const target = pointRead(tables, input.message_id);
  const before = input.before ?? saved?.[6] ?? 0, after = input.after ?? saved?.[7] ?? 0;
  const revision = saved?.[5] ?? meta.revision;
  if (!natural(before) || before > 20 || !natural(after) || after > 20 || revision > meta.revision || target.seq > revision ||
    (saved && (saved[1] !== meta.sessionId || saved[2] !== target.message_id || saved[3] !== target.seq ||
      saved[4] !== target.channel || saved[6] !== before || saved[7] !== after))) throw invalid();
  const nearby = (direction: "older" | "newer", limit: number) => limit ? tables.readRange({
    kind: "conversation", direction, limit, channel: target.channel, throughRevision: revision, exclusiveSeq: target.seq,
  }).slice(0, limit).flatMap(entry => { const message = retrievalMessage(entry); return message ? [message] : []; }) : [];
  const window = [...nearby("older", before).reverse(), target, ...nearby("newer", after)];
  const first = window[0]!.seq, last = window.at(-1)!.seq;
  const start = saved ? window.findIndex(message => message.seq === saved[10]) : 0;
  if (start < 0 || (saved && (saved[8] !== first || saved[9] !== last))) throw invalid();
  const result: TimelineWindowResult = { target: target.message_id, sequence: target.seq, revision, messages: [] };
  const next = (seq: number, offset: number) => encode([1, meta.sessionId, target.message_id, target.seq, target.channel,
    revision, before, after, first, last, seq, offset]);
  for (let index = start; index < window.length; index++) {
    const { text, ...origin } = window[index]!;
    const offset = index === start ? saved?.[11] ?? 0 : 0;
    const body = Buffer.from(text);
    if (offset > body.length || (offset > 0 && (offset === body.length || (body[offset]! & 0xc0) === 0x80))) throw invalid();
    const rest = body.subarray(offset), following = window[index + 1];
    const fragment = (end: number) => {
      const cursor = end < rest.length ? next(origin.seq, offset + end) : following && next(following.seq, 0);
      return { ...result, messages: [...result.messages, { ...origin, offset, text: rest.subarray(0, end).toString() }],
        ...(cursor === undefined ? {} : { next: cursor }) };
    };
    if (result.messages.length === 20) return { ...result, next: next(origin.seq, offset) };
    const full = rest.length <= responseBudget ? fragment(rest.length) : undefined;
    if (full && byteSize(full) <= responseBudget) { result.messages = full.messages; continue; }
    if (result.messages.length) return { ...result, next: next(origin.seq, offset) };
    let lo = 0, hi = Math.min(rest.length, responseBudget);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (byteSize(fragment(mid)) <= responseBudget) lo = mid;
      else hi = mid - 1;
    }
    while (lo > 0 && lo < rest.length && (rest[lo]! & 0xc0) === 0x80) lo--;
    if (!lo) throw new Fail("transfer_limit", "Timeline message identity exceeds the response budget");
    return fragment(lo);
  }
  return result;
}
