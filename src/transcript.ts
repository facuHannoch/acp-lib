// The chat transcript: one JSON object per line, append-only, readable without starting
// the agent. Deliberately lightweight and harness-agnostic — it is not a replacement for
// whatever full-fidelity record the provider keeps.
//
// FILE CONTRACT
//
// - `t:"msg"` DELIMITS A TURN. A turn is `msg(user) → activity… → msg(assistant)`; writes
//   serialize in call order, so that nesting always holds. A trailing user message with no
//   assistant message after it means the turn DIED IN FLIGHT (crash, kill, cancel) — the
//   activity lines inside it are the record of what it was doing.
// - `t:"activity"` lines are SETTLED RECORDS, not raw deltas. FOLD THEM LAST-WINS ON
//   `recordId` — `foldRecords()` from `./activity.ts` is exactly that, and is the only
//   supported way to read them. A tool call normally writes 2–3 lines (announced → input →
//   settled); later lines supersede earlier ones with the same `recordId`. `reason` lets a
//   compact view take only `settled`/`flushed` without folding at all.
// - `reason:"flushed"` means the turn ended with that record still open, written at its
//   real status. It is NOT `settled`.
// - Lines with neither `recordId` nor `reason` are raw activity deltas written by 0.2.x, from
//   before this format. Those two fields are the discriminator, which is why `v` is still 1.
// - Unrecognized `t` values and malformed lines are SKIPPED, never fatal: a partially
//   written final line (torn write) costs that line only.
// - `ts` is wall-clock milliseconds and is the ordering key ACROSS types, so a reader can
//   interleave `msg` and `activity` on one timeline.
//
// Any future change to fold semantics or line meaning bumps `v`.

import { appendFile, mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { foldRecords, type AggregatedRecord, type EmitReason } from "./activity.ts";
import type { ActivityEvent, PromptResult, Usage } from "./types.ts";

export type TranscriptRole = "user" | "assistant";

export interface TranscriptMetaLine {
  v: 1;
  t: "meta";
  event: "open";
  ts: number;
  internalSessionId?: string | null;
  adapter?: string;
}

export interface TranscriptMessageLine {
  v: 1;
  t: "msg";
  role: TranscriptRole;
  text: string;
  ts: number;
  usage?: Usage | null;
  stopReason?: string;
  status?: PromptResult["status"];
}

/**
 * One aggregated activity record, flattened: the `ActivityEvent`'s own fields sit at the
 * top level beside the envelope. Fold last-wins on `recordId` (see the file contract at
 * the top of this module).
 */
export interface TranscriptActivityLine {
  v: 1;
  t: "activity";
  ts: number;
  kind: string;
  /** Fold key. Absent on raw activity lines written by 0.2.x. */
  recordId?: string;
  /** Lifecycle position. Absent on raw activity lines written by 0.2.x. */
  reason?: EmitReason;
  /** Set when `maxBytes` clipped a field on this line. */
  truncated?: boolean;
  [key: string]: unknown;
}

export interface TranscriptPermissionLine {
  v: 1;
  t: "permission";
  ts: number;
  toolCallId?: string;
  title?: string;
  request?: unknown;
  outcome?: unknown;
}

export interface TranscriptRawLine {
  v: 1;
  t: "raw";
  ts: number;
  protocol: "acp" | string;
  event: string;
  data: unknown;
}

export type TranscriptLine =
  | TranscriptMetaLine
  | TranscriptMessageLine
  | TranscriptActivityLine
  | TranscriptPermissionLine
  | TranscriptRawLine;

export type TranscriptEntry = TranscriptMessageLine;

export interface ReadTranscriptOptions {
  /** Return entries with `ts` lower than this cursor. */
  before?: number;
  /**
   * Return at most this many entries, keeping the NEWEST matching ones.
   *
   * `limit` counts entries that SURVIVE `types` — ask for twenty messages and you get
   * twenty messages, however many activity lines sit between them.
   *
   * With a limit the file is read backwards from EOF in chunks, so the cost is
   * proportional to the region that holds `limit` matches rather than to the whole
   * transcript. Narrow `types` on an activity-heavy file widens that region: twenty
   * messages may span thousands of activity lines, and in the worst case the read reaches
   * the start of the file — which is what every read did before the tail read existed.
   */
  limit?: number;
  /**
   * Keep only these line types. Omit for everything recognized.
   *
   * This is what makes `limit` mean what you asked for. `["msg", "activity"]` is the
   * interleaved chat view; `meta` and `raw` are noise a renderer would discard anyway,
   * and excluding them here stops them consuming the budget.
   */
  types?: Array<TranscriptLine["t"]>;
}

/** Backwards read granularity. Big enough that a typical page needs one or two reads. */
const TAIL_CHUNK_BYTES = 64 * 1024;

const LF = 0x0a;

/** Views from `subarray` keep the source's buffer kind; pin the loose form. */
type Bytes = Uint8Array<ArrayBufferLike>;

export async function appendTranscriptLine(
  path: string,
  line: TranscriptLine,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
}

/**
 * Read the message projection of a transcript. Meta/activity/raw lines are skipped, and
 * `limit` counts MESSAGES — the entries this returns — not lines.
 *
 * `types` is forced: this function is the message projection, so honouring a caller's
 * `types` would be incoherent.
 */
export async function readTranscript(
  path: string,
  options: ReadTranscriptOptions = {},
): Promise<TranscriptEntry[]> {
  const lines = await readTranscriptLines(path, { ...options, types: ["msg"] });
  return lines.filter(isTranscriptMessageLine);
}

/**
 * Read all recognized transcript lines, preserving oldest-first order.
 *
 * `before` + `limit` are the pagination contract: page back through a conversation by
 * passing the oldest returned `ts` as the next `before`.
 */
export async function readTranscriptLines(
  path: string,
  options: ReadTranscriptOptions = {},
): Promise<TranscriptLine[]> {
  const types = options.types ? new Set<string>(options.types) : undefined;
  if (options.limit != null && options.limit >= 0) {
    return readTail(path, options.limit, options.before, types);
  }

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }

  const out: TranscriptLine[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = parseTranscriptLine(raw, options.before, types);
    if (line) out.push(line);
  }
  return out;
}

/**
 * Un-flatten one activity line back into the record it was written from.
 *
 * Null for a line that predates this format (no `recordId`/`reason`) — those are raw
 * deltas and cannot be folded. `seq` is 0: it is a live-stream ordering device for the
 * mid-turn join, never a file field.
 *
 * Exported because a reader that interleaves `msg` and `activity` on one `ts` timeline
 * needs per-line conversion; use `readActivityRecords` if you only want the folded state.
 */
export function toActivityRecord(line: TranscriptActivityLine): AggregatedRecord | null {
  if (!line.recordId || !line.reason) return null;
  const { v, t, ts, recordId, reason, ...event } = line;
  return { recordId, reason, seq: 0, event: event as unknown as ActivityEvent };
}

/**
 * The folded activity state of a transcript: everything that happened, one entry per
 * `recordId`, last write winning. This is THE read path for activity — the same fold the
 * live stream uses, so a reload shows what was watched.
 */
export async function readActivityRecords(
  path: string,
  options: ReadTranscriptOptions = {},
): Promise<Map<string, AggregatedRecord>> {
  const records: AggregatedRecord[] = [];
  // `types` forced for the same reason as readTranscript: `limit` should count the thing
  // this returns. Note the newest N activity lines always carry the LATEST state of what
  // they cover, since a later line supersedes an earlier one with the same `recordId`.
  for (const line of await readTranscriptLines(path, { ...options, types: ["activity"] })) {
    if (line.t !== "activity") continue;
    const record = toActivityRecord(line);
    if (record) records.push(record);
  }
  return foldRecords(records);
}

/**
 * The newest `limit` matching lines, read backwards from EOF.
 *
 * Accumulates RAW BYTES and decodes only the assembled tail, so a multi-byte character
 * split across a chunk boundary is whole again before anyone looks at it. The leading
 * fragment of each block is a line whose beginning we haven't read yet, so it is carried
 * into the next iteration rather than parsed.
 */
async function readTail(
  path: string,
  limit: number,
  before?: number,
  types?: Set<string>,
): Promise<TranscriptLine[]> {
  if (limit === 0) return [];

  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return [];
  }

  try {
    const { size } = await handle.stat();
    const newestFirst: TranscriptLine[] = [];
    const decoder = new TextDecoder();
    let end = size;
    let carry: Bytes = new Uint8Array(0);

    while (end > 0 && newestFirst.length < limit) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      const block = concatBytes(await readBytes(handle, start, end - start), carry);
      end = start;

      let body: Bytes;
      if (start === 0) {
        body = block; // reached the beginning: nothing is partial any more
        carry = new Uint8Array(0);
      } else {
        const firstBreak = block.indexOf(LF);
        if (firstBreak < 0) {
          carry = block; // a single line longer than one chunk
          continue;
        }
        carry = block.subarray(0, firstBreak);
        body = block.subarray(firstBreak + 1);
      }

      const raws = decoder.decode(body).split(/\r?\n/);
      for (let i = raws.length - 1; i >= 0 && newestFirst.length < limit; i--) {
        const line = parseTranscriptLine(raws[i]!, before, types);
        if (line) newestFirst.push(line);
      }
    }

    return newestFirst.reverse();
  } finally {
    await handle.close();
  }
}

/**
 * One line → a recognized entry, or null (blank, malformed, unknown, or filtered out).
 *
 * Every rejection happens HERE, which is what makes `limit` count survivors: both read
 * paths tally what this returns, so narrowing `types` narrows what the budget is spent on
 * without either loop knowing about it.
 */
function parseTranscriptLine(
  raw: string,
  before?: number,
  types?: Set<string>,
): TranscriptLine | null {
  if (!raw.trim()) return null;
  try {
    const line = JSON.parse(raw) as unknown;
    if (!isTranscriptLine(line)) return null;
    if (types && !types.has(line.t)) return null;
    if (before != null && line.ts >= before) return null;
    return line;
  } catch {
    return null; // skip malformed lines
  }
}

async function readBytes(handle: FileHandle, start: number, length: number): Promise<Uint8Array> {
  const buf = new Uint8Array(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buf, read, length - read, start + read);
    if (bytesRead <= 0) break;
    read += bytesRead;
  }
  return read === length ? buf : buf.subarray(0, read);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function isTranscriptLine(value: unknown): value is TranscriptLine {
  if (!isRecord(value)) return false;
  if (value.v !== 1 || typeof value.t !== "string" || !isFiniteNumber(value.ts)) return false;

  switch (value.t) {
    case "meta":
      return value.event === "open";
    case "msg":
      return (
        (value.role === "user" || value.role === "assistant") &&
        typeof value.text === "string"
      );
    case "activity":
      return typeof value.kind === "string";
    case "permission":
      return true;
    case "raw":
      return typeof value.protocol === "string" && typeof value.event === "string";
    default:
      return false;
  }
}

function isTranscriptMessageLine(value: TranscriptLine): value is TranscriptMessageLine {
  return value.t === "msg";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
