import { createHash } from "node:crypto";
import type { LoadedScenario, ScenarioModelRecord, ScenarioSend } from "../../contracts/scenario.ts";
import { parseUniqueJson } from "../../util/json.ts";
import { ScriptedModelError } from "./scripted-error.ts";

const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const scriptedCompatibilityKey = (digest: string, system: string) =>
  `scripted-jsonl-v1:${digest}:${hash(JSON.stringify(system))}`;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: readonly string[]) {
  for (const key of Object.keys(value)) if (!names.includes(key)) throw new Error(`Unknown field ${key}`);
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonblank string`);
  return value;
}
function count(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
  return value;
}
function list(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite JSON number");
  if (value === null || typeof value !== "object") return value;
  const record = object(value);
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
}
function model(raw: Record<string, unknown>): ScenarioModelRecord {
  fields(raw, ["type", "channelId", "delayMs", "chunks", "usage", "content", "calls", "failure", "wait"]);
  const channelId = raw.channelId === undefined ? undefined : text(raw.channelId, "channelId");
  const delayMs = raw.delayMs === undefined ? 0 : count(raw.delayMs, "delayMs");
  const chunks = list(raw.chunks, "chunks").map(value => {
    const chunk = object(value); fields(chunk, ["afterMs", "text"]);
    if (typeof chunk.text !== "string" || chunk.text.length === 0) throw new Error("chunk.text must be nonempty");
    return { afterMs: count(chunk.afterMs, "afterMs"), text: chunk.text };
  });
  const usage = raw.usage === undefined ? undefined : object(raw.usage);
  if (usage) {
    fields(usage, ["inputTokens", "outputTokens", "totalTokens"]);
    for (const [key, value] of Object.entries(usage)) count(value, key);
  }
  const common = { type: "model" as const, channelId, delayMs, chunks, usage };
  if (["content", "failure", "wait"].filter(key => Object.hasOwn(raw, key)).length !== 1)
    throw new Error("Expected exactly one of content, failure or wait");
  if (Object.hasOwn(raw, "content")) {
    if (raw.content !== null && typeof raw.content !== "string") throw new Error("content must be a string or null");
    if (chunks.length && (raw.content === null || chunks.map(chunk => chunk.text).join("") !== raw.content))
      throw new Error("chunks must equal the final content");
    const ids = new Set<string>();
    const calls = list(raw.calls, "calls").map(value => {
      const call = object(value); fields(call, ["id", "name", "arguments"]);
      const id = text(call.id, "call.id");
      if (ids.has(id)) throw new Error(`Duplicate call ID ${id}`);
      ids.add(id);
      return { id, name: text(call.name, "call.name"), arguments: canonical(object(call.arguments)) as Record<string, unknown> };
    });
    return { ...common, content: raw.content, calls };
  }
  if (Object.hasOwn(raw, "calls")) throw new Error("calls requires content");
  if (Object.hasOwn(raw, "wait")) {
    if (raw.wait !== "cancel") throw new Error("wait must be cancel");
    return { ...common, wait: raw.wait };
  }
  const failure = object(raw.failure); fields(failure, ["kind", "message"]);
  const kind = failure.kind;
  if (kind !== "transient" && kind !== "provider" && kind !== "invalid_request" && kind !== "invalid_config") throw new Error("Unknown failure kind");
  return { ...common, failure: { kind, message: text(failure.message, "failure.message") } };
}

export function parseScenario(bytes: Uint8Array, path = "<scenario>"): LoadedScenario {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const defaultModels: ScenarioModelRecord[] = [], channelModels = new Map<string, ScenarioModelRecord[]>();
  const sends: ScenarioSend[] = [], inputIds = new Set<string>();
  let name = "", line = 0;
  try {
    for (let start = 0; start < source.length;) {
      const newline = source.indexOf(10, start), end = newline < 0 ? source.length : newline;
      line++;
      const raw = object(parseUniqueJson(decoder.decode(source.subarray(start, end))));
      start = end + 1;
      if (line === 1) {
        fields(raw, ["type", "version", "name"]);
        if (raw.type !== "scenario" || raw.version !== 1) throw new Error("Expected scenario version 1");
        name = text(raw.name, "name");
      } else if (raw.type === "model") {
        const record = model(raw);
        if (record.channelId === undefined) defaultModels.push(record);
        else {
          const sequence = channelModels.get(record.channelId) ?? [];
          sequence.push(record); channelModels.set(record.channelId, sequence);
        }
      } else if (raw.type === "send") {
        fields(raw, ["type", "atMs", "channelId", "participantId", "inputId", "text"]);
        const inputId = text(raw.inputId, "inputId");
        if (inputIds.has(inputId)) throw new Error(`Duplicate input ID ${inputId}`);
        inputIds.add(inputId);
        sends.push({ type: "send", inputId, atMs: count(raw.atMs, "atMs"), channelId: text(raw.channelId, "channelId"),
          participantId: text(raw.participantId, "participantId"), text: text(raw.text, "text") });
      } else throw new Error("Unexpected record type");
    }
    if (!defaultModels.length && !channelModels.size) throw new Error("Expected at least one model record");
  } catch (error) {
    throw new ScriptedModelError("invalid_script", `${path}:${Math.max(1, line)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sequence = (records: ScenarioModelRecord[]) => records.map(({ type: _type, channelId: _channel, ...record }) => canonical(record));
  const pairs = [...channelModels.keys()].sort().map(channel => [channel, sequence(channelModels.get(channel)!)]);
  return { name, defaultModels, channelModels, sends, fileDigest: hash(source), modelDigest: hash(JSON.stringify([sequence(defaultModels), pairs])) };
}

export async function loadScenario(path: string): Promise<LoadedScenario> {
  let data: ArrayBuffer;
  try { data = await Bun.file(path).arrayBuffer(); }
  catch (error) { throw new ScriptedModelError("script_load_failed", `Cannot read script ${path}: ${String(error)}`); }
  return parseScenario(new Uint8Array(data), path);
}
