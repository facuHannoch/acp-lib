import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createSession } from "./index.ts";
import type { SessionStorage, SessionStorageAdapter } from "./contracts/storage.ts";
import type { ExecuteTool } from "./contracts/loop.ts";
import { createScriptedModel } from "./capabilities/model/scripted.ts";
import { echoDefinition, executeEcho } from "./capabilities/tools/echo.ts";
import { createHoldTool, createRecordTool, holdDefinition, recordDefinition } from "./capabilities/tools/record.ts";
import { createMemoryStorageAdapter } from "./state/storage/memory.ts";
import { createSqliteStorageAdapter } from "./state/storage/sqlite.ts";
import { createProtocolServer, SessionOpenError } from "./interfaces/protocol/server.ts";
import { HarnessClient, createInProcessTransport } from "./client.ts";

export interface ScriptedServerOptions {
  /** Directory of durable sessions, one SQLite file per session ID. */
  home?: string;
  /** Storage location for a session ID, for tests that keep one location across servers. */
  adapter?: (sessionId: string) => SessionStorageAdapter;
  /** `<point>:<n>`: kill this process, without unwinding, right after the n-th
   * time the point is passed. Points are storage method names (after their
   * commit) and `tool` (after a tool ran, before its result is recorded). */
  fault?: string;
  /** File the `record` tool appends to. */
  effects?: string;
  /** Directory for transfer files when there is no home. */
  transfers?: string;
  /** Smaller transfer limits for tests. */
  limits?: Partial<{ chunkBytes: number; maxBytes: number; idleMs: number }>;
}

/** Real process death at an exact durable boundary: nothing after the commit
 * runs, so no event, acknowledgment or cleanup can soften the crash. */
function faults(spec: string | undefined) {
  const [point, nth] = (spec ?? "").split(":");
  let seen = 0;
  return (passed: string) => {
    if (!point || passed !== point || ++seen !== Number(nth)) return;
    process.kill(process.pid, "SIGKILL");
    Bun.sleepSync(60_000);
  };
}
function withFaults(storage: SessionStorage, hit: (point: string) => void): SessionStorage {
  return new Proxy(storage, { get(target, key) {
    const value = Reflect.get(target, key) as unknown;
    if (typeof value !== "function" || typeof key !== "string") return value;
    return (...args: unknown[]) => { const result = value.apply(target, args); if (result?.ok) hit(key); return result; };
  } });
}

/** Real execution with scripted models per channel, exposed through the
 * protocol. In memory by default; durable when given a home or an adapter. */
export function createScriptedServer(options: ScriptedServerOptions = {}) {
  const models = new Map<string, ReturnType<typeof createScriptedModel>>();
  const durable = !!(options.home || options.adapter);
  const hit = faults(options.fault);
  const memory = createMemoryStorageAdapter();
  const locate = (sessionId: string) => {
    if (options.home && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) throw new Error("sessionId must be a plain file name for durable sessions");
    return options.adapter?.(sessionId) ?? (options.home ? createSqliteStorageAdapter(join(options.home, `${sessionId}.sqlite`)) : memory);
  };
  const server = createProtocolServer(async ({ mode, sessionId, config }) => {
    const script: unknown = await Bun.file(config.model.script).json();
    createScriptedModel(script); // Validate before the session is acknowledged.
    const adapter = locate(sessionId);
    // Compatible means: same prompt and same script content.
    const compatibilityKey = createHash("sha256").update(JSON.stringify([config.system, script])).digest("hex");
    const opened = adapter.open({ mode, identity: { sessionId, compatibilityKey } });
    if (!opened.ok) {
      const code = opened.error.code;
      throw new SessionOpenError(code === "not_found" || code === "already_exists" || code === "owner_conflict" || code === "incompatible" ? code : "storage_failure", opened.error.message);
    }
    const storage = options.fault ? withFaults(opened.value, hit) : opened.value;
    const record = createRecordTool(options.effects), hold = createHoldTool(options.effects);
    const executeTool: ExecuteTool = async (call, signal) => {
      const result = await (call.name === "record" ? record(call, signal) : call.name === "hold" ? hold(call, signal) : executeEcho(call, signal));
      hit("tool");
      return result;
    };
    const session = createSession({ systemPrompt: config.system, storage, configureTurn(turn) {
      let scripted = models.get(turn.channelId);
      if (!scripted) {
        // A script is consumed one response per recorded assistant message, so
        // a reopened session continues where the previous process stopped.
        const consumed = session.snapshot().timeline.filter(entry => entry.channelId === turn.channelId && entry.message.role === "assistant").length;
        scripted = createScriptedModel(script, consumed); models.set(turn.channelId, scripted);
      }
      return { model: scripted.model, tools: [echoDefinition, recordDefinition, holdDefinition], executeTool };
    } });
    return { session, close() { opened.value.close(); }, exportArchive: () => storage.exportArchive() };
  }, { durable, limits: options.limits, transferDirectory: durable ? options.home ?? options.transfers ?? mkdtempSync(join(tmpdir(), "harness-transfers-")) : undefined,
    importArchive(payload, sessionId) {
      try { return locate(sessionId).importSessionFile(payload, { sessionId }); }
      catch (error) { return { ok: false, error: { code: "invalid_input", message: String(error) } }; }
    } });
  return { server, models };
}

export function createInProcessHarness(options?: ScriptedServerOptions) {
  const { server, models } = createScriptedServer(options);
  const client = new HarnessClient(createInProcessTransport(server));
  return { client, models, server, close: () => { client.close(); server.dispose(); } };
}
