import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PromptResult, Usage } from "./types.ts";

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

export interface TranscriptActivityLine {
  v: 1;
  t: "activity";
  ts: number;
  kind: string;
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
  /** Return at most this many entries. Keeps the newest matching entries. */
  limit?: number;
}

export async function appendTranscriptLine(
  path: string,
  line: TranscriptLine,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
}

/** Read the message projection of a transcript. Meta/activity/raw lines are skipped. */
export async function readTranscript(
  path: string,
  options: ReadTranscriptOptions = {},
): Promise<TranscriptEntry[]> {
  const lines = await readTranscriptLines(path, options);
  return lines.filter(isTranscriptMessageLine);
}

/** Read all recognized transcript lines, preserving oldest-first order. */
export async function readTranscriptLines(
  path: string,
  options: ReadTranscriptOptions = {},
): Promise<TranscriptLine[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }

  const out: TranscriptLine[] = [];
  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw) as unknown;
      if (!isTranscriptLine(line)) continue;
      if (options.before != null && line.ts >= options.before) continue;
      out.push(line);
    } catch {
      /* skip malformed lines */
    }
  }

  if (options.limit != null && options.limit >= 0 && out.length > options.limit) {
    return out.slice(out.length - options.limit);
  }
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
