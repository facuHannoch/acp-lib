/**
 * Consumer functions for native conversations (tools and callbacks spec).
 *
 * The consumer registers functions by name. The harness offers them to the model, checks policy,
 * arguments and availability, and only then sends `functions/call` here. This module owns what
 * belongs to the host side of that call:
 * - the catalog sent on every open, with the runtime selection the consumer currently wants;
 * - routing a call to its handler, with the signal that aborts when the harness stops waiting;
 * - storing a result that is too large to send inline, in a directory only this process uses, and
 *   serving bounded reads of it by ID. The harness never reads this directory: it may be on
 *   another filesystem.
 */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FunctionError,
  type FunctionCall,
  type FunctionResult,
  type ResultPage,
  type ResultRead,
  type ToolCatalogInput,
} from "../native-harness/src/client.ts";

export { FunctionError };

export interface NativeFunctionContext {
  readonly invocationId: string;
  readonly channel: string;
  readonly turnId: string;
  readonly tool: string;
  /** Configured contributors from the harness authorization snapshot.
   * Order grants no precedence. An empty list means none contributed. */
  readonly policyNames: readonly string[];
  /** Aborts when the harness stops waiting: the tool's deadline, an interrupt, a stop or a lost connection. */
  readonly signal: AbortSignal;
}

export interface NativeFunction {
  readonly description: string;
  /** JSON Schema of the arguments object. The harness validates a call against it before dispatch. */
  readonly parameters: Record<string, unknown>;
  /**
   * `fixed` (default): always registered. `revocable`: its grant can be revoked and restored, and the
   * harness keeps that with the session. `runtime`: enabled and removed by name while running.
   */
  readonly group?: "fixed" | "revocable" | "runtime";
  /** For a `runtime` function: enabled from the start. Default false. */
  readonly enabled?: boolean;
  /** From dispatch. Absent: the default below, and without one no deadline. */
  readonly deadlineMs?: number;
  /** Returns any JSON value. Throw `FunctionError` for a failure the model should see with its code. */
  handler(args: Record<string, unknown>, context: NativeFunctionContext): Promise<unknown> | unknown;
}

export interface NativeFunctionsConfig {
  /** By tool name. The name is also the handler binding and the policy rule name. */
  readonly tools: Readonly<Record<string, NativeFunction>>;
  readonly defaultDeadlineMs?: number;
  /** Where oversized results are kept. Default: a new private directory under the OS temp dir, removed on stop. */
  readonly resultDirectory?: string;
  /** Serialized output above this is stored and returned by reference. Default 16 384 bytes. */
  readonly inlineBytes?: number;
  /** How long a stored result can be read. Default 86 400 000 ms (24 hours). */
  readonly resultTtlMs?: number;
  /** Names a stored result. Default: a random UUID. Must return a new UUID each time; for deterministic tests. */
  readonly newResultId?: () => string;
}

/** Adjustable defaults (native harness BUSINESS_RULES.md, tools and host callbacks). */
export const NATIVE_FUNCTION_DEFAULTS = { inlineBytes: 16_384, previewChars: 512, resultTtlMs: 86_400_000 } as const;

const RESULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface NativeFunctionHost {
  /** Handler names advertised at `initialize`. */
  handlers(): string[];
  /** The catalog for `session/create` and `session/open`, with the current runtime selection. */
  catalog(): ToolCatalogInput;
  /** Remember a runtime selection so the next open supplies it again. */
  select(name: string, enabled: boolean): void;
  call(call: FunctionCall, signal: AbortSignal): Promise<FunctionResult>;
  read(read: ResultRead): ResultPage;
  /** Calls being handled now, by invocation ID. */
  active(): string[];
  dispose(): void;
}

export function createNativeFunctionHost(config: NativeFunctionsConfig): NativeFunctionHost {
  const inlineBytes = config.inlineBytes ?? NATIVE_FUNCTION_DEFAULTS.inlineBytes;
  const ttl = config.resultTtlMs ?? NATIVE_FUNCTION_DEFAULTS.resultTtlMs;
  const enabled = new Set(Object.entries(config.tools).filter(([, tool]) => tool.group === "runtime" && tool.enabled).map(([name]) => name));
  const active = new Set<string>();
  let directory = config.resultDirectory, owned = false;
  const results = () => {
    if (directory === undefined) { directory = mkdtempSync(join(tmpdir(), "acp-native-results-")); owned = true; }
    else mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  };
  return {
    handlers: () => Object.keys(config.tools),
    catalog: () => ({
      catalog: Object.entries(config.tools).map(([name, tool]) => ({ name, description: tool.description, parameters: tool.parameters, handler: name,
        group: tool.group ?? "fixed", ...(tool.deadlineMs === undefined ? {} : { deadlineMs: tool.deadlineMs }) })),
      enabled: [...enabled],
      ...(config.defaultDeadlineMs === undefined ? {} : { defaultDeadlineMs: config.defaultDeadlineMs }),
    }),
    select(name, on) { if (on) enabled.add(name); else enabled.delete(name); },
    async call(call, signal) {
      const tool = Object.hasOwn(config.tools, call.handler) ? config.tools[call.handler] : undefined;
      if (!tool) throw new FunctionError("handler_missing", `No function is registered as ${call.handler}`);
      active.add(call.invocationId);
      try {
        const output = await tool.handler(call.arguments, { invocationId: call.invocationId, channel: call.channel, turnId: call.turnId, tool: call.tool, signal });
        const text = JSON.stringify(output ?? null);
        const bytes = Buffer.byteLength(text);
        if (bytes <= inlineBytes) return { output: output ?? null };
        // Too large to send inline: keep the bytes here and hand the harness a preview and an ID.
        const resultId = (config.newResultId ?? randomUUID)();
        if (!RESULT_ID.test(resultId)) throw new FunctionError("result_store_failed", "The result could not be stored");
        writeFileSync(join(results(), resultId), text, { mode: 0o600 });
        return { preview: text.slice(0, NATIVE_FUNCTION_DEFAULTS.previewChars),
          reference: { resultId, bytes, retention: "temporary", expiresAt: new Date(Date.now() + ttl).toISOString() } };
      } finally { active.delete(call.invocationId); }
    },
    read(read) {
      // An ID is a name this module generated, never a path.
      if (!RESULT_ID.test(read.resultId) || directory === undefined) throw new FunctionError("result_not_found", "No stored result has this ID");
      const path = join(directory, read.resultId);
      let size: number, written: number;
      try { const stat = statSync(path); size = stat.size; written = stat.mtimeMs; }
      catch { throw new FunctionError("result_expired", "That result is no longer stored"); }
      if (written + ttl <= Date.now()) { rmSync(path, { force: true }); throw new FunctionError("result_expired", "That result was temporary and has expired"); }
      const offset = Math.min(Math.max(0, read.offset), size), length = Math.max(0, Math.min(read.length, size - offset));
      const buffer = Buffer.alloc(length);
      const file = openSync(path, "r");
      try { readSync(file, buffer, 0, length, offset); } finally { closeSync(file); }
      // Never split a UTF-8 character: drop a trailing partial one; the next read starts there.
      let end = length;
      if (offset + length < size) {
        let start = end;
        while (start > 0 && (buffer[start - 1]! & 0xc0) === 0x80) start--;
        if (start > 0) {
          const lead = buffer[start - 1]!, need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
          if (end - (start - 1) < need) end = start - 1;
        }
      }
      return { text: buffer.subarray(0, end).toString("utf8"), eof: offset + end >= size, totalBytes: size };
    },
    active: () => [...active],
    dispose() { if (owned && directory !== undefined) rmSync(directory, { recursive: true, force: true }); },
  };
}
