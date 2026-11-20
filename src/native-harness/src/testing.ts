import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, existsSync, rmdirSync, appendFileSync } from "node:fs";
import { createSession } from "./index.ts";
import type { SessionStorage, SessionStorageAdapter } from "./contracts/storage.ts";
import type { ExecuteTool, Model } from "./contracts/loop.ts";
import { createScriptedModel } from "./capabilities/model/scripted.ts";
import { bindModelAttempt, completeModelAttempt } from "./capabilities/model/attempt.ts";
import { openRouterAttempt } from "./capabilities/model/openrouter-stream.ts";
import { openRouter } from "./capabilities/model/openrouter.ts";
import { scenarioDefinitions } from "./capabilities/tools/scenario.ts";
import { echoDefinition, executeEcho } from "./capabilities/tools/echo.ts";
import { createHoldTool, createRecordTool, holdDefinition, recordDefinition } from "./capabilities/tools/record.ts";
import { createMemoryStorageAdapter } from "./state/storage/memory.ts";
import { createSqliteStorageAdapter } from "./state/storage/sqlite.ts";
import { validateSessionPayload } from "./state/storage/archive.ts";
import { createProtocolServer, SessionOpenError } from "./interfaces/protocol/server.ts";
import { HarnessClient, createInProcessTransport } from "./client.ts";
import { chooseManagedConfig, managedSessionPaths } from "./runtime/config/paths.ts";
import { resolveCredential } from "./runtime/config/managed.ts";

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
  /** Offline test-only request capture; one JSON record per inference. */
  requests?: string;
  /** Directory for transfer files when there is no home. */
  transfers?: string;
  /** Smaller transfer limits for tests. */
  limits?: Partial<{ chunkBytes: number; maxBytes: number; idleMs: number }>;
  /** Offline provider injection and destination environment for tests/hosts. */
  providerFactory?: (apiKey: string, model: string) => Model;
  environment?: Record<string, string | undefined>;
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
  const noSidecar = join(mkdtempSync(join(tmpdir(), "harness-config-")), "config.json");
  const locate = (sessionId: string) => {
    return options.adapter?.(sessionId) ?? (options.home ? createSqliteStorageAdapter(managedSessionPaths(sessionId, options.home).database) : memory);
  };
  const server = createProtocolServer(async ({ mode, sessionId, config: inline }) => {
    const paths = options.home ? managedSessionPaths(sessionId, options.home) : undefined;
    const adapter = locate(sessionId);
    const stored = mode === "open" ? adapter.readSavedConfig() : undefined;
    if (stored && !stored.ok) throw new SessionOpenError(stored.error.code === "not_found" || stored.error.code === "owner_conflict" ? stored.error.code : "storage_failure", stored.error.message);
    const config = chooseManagedConfig({ mode, sidecar: paths?.config ?? noSidecar, inline, saved: stored?.ok ? stored.value : undefined });
    const script: unknown = config.model.protocol === "scripted" ? await Bun.file(config.model.script).json() : undefined;
    if (config.model.protocol === "scripted") createScriptedModel(script); // Validate before acknowledgment.
    const credential = config.model.protocol === "openrouter" ? resolveCredential(config.model, options.environment ?? process.env) : undefined;
    // Compatible means: same prompt and same script content.
    const compatibility = config.model.protocol === "scripted" ? [config.system, script]
      : [config.system, config.model.model, scenarioDefinitions.map(tool => tool.name)];
    const compatibilityKey = createHash("sha256").update(JSON.stringify(compatibility)).digest("hex");
    if (mode === "create" && paths) mkdirSync(paths.directory, { recursive: true });
    const opened = adapter.open({ mode, identity: { sessionId, compatibilityKey }, config });
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
    const session = createSession({ systemPrompt: config.system, config, storage, configureTurn(turn) {
      if (config.model.protocol === "openrouter") {
        const model = (options.providerFactory ?? openRouter)(credential!, config.model.model);
        if (!options.providerFactory) bindModelAttempt(model, { scripted: false, create: () => openRouterAttempt(credential!, config.model.protocol === "openrouter" ? config.model.model : "") });
        return { model, tools: [echoDefinition, recordDefinition, holdDefinition], executeTool };
      }
      let scripted = models.get(turn.channelId);
      if (!scripted) { scripted = createScriptedModel(script); models.set(turn.channelId, scripted); }
      const selected = scripted.model;
      const model: Model = (messages, definitions, signal) => {
        if (options.requests) appendFileSync(options.requests, `${JSON.stringify({ channel: turn.channelId, turnId: turn.turnId, messages })}\n`);
        return selected(messages, definitions, signal);
      };
      bindModelAttempt(model, { scripted: true, create: step => {
        const next = completeModelAttempt(scripted!.modelAt(step!));
        return (request, signal) => {
          if (options.requests) appendFileSync(options.requests, `${JSON.stringify({ channel: turn.channelId, turnId: turn.turnId, messages: request.messages })}\n`);
          return next(request, signal);
        };
      } });
      return { model, tools: [echoDefinition, recordDefinition, holdDefinition], executeTool };
    } });
    return { session, config, close() { opened.value.close(); }, commitConfig() {
      const saved = storage.saveConfig(config);
      if (!saved.ok && saved.error.code !== "incompatible") throw new SessionOpenError("storage_failure", saved.error.message);
    }, exportArchive: () => storage.exportArchive() };
  }, { durable, limits: options.limits, transferDirectory: durable ? options.home ?? options.transfers ?? mkdtempSync(join(tmpdir(), "harness-transfers-")) : undefined,
    importArchive(payload, sessionId) {
      let createdDirectory: string | undefined;
      try {
        validateSessionPayload(payload);
        if (options.home) {
          const directory = managedSessionPaths(sessionId, options.home).directory;
          if (!existsSync(directory)) { mkdirSync(directory, { recursive: true }); createdDirectory = directory; }
        }
        const result = locate(sessionId).importSessionFile(payload, { sessionId });
        if (!result.ok && createdDirectory) { try { rmdirSync(createdDirectory); } catch { /* Keep an occupied directory. */ } }
        return result;
      }
      catch (error) {
        if (createdDirectory) { try { rmdirSync(createdDirectory); } catch { /* Keep an occupied directory. */ } }
        return { ok: false, error: { code: (error as { code?: string }).code === "invalid_archive" ? "invalid_archive" : "invalid_input", message: String(error) } };
      }
    } });
  return { server, models };
}

export function createInProcessHarness(options?: ScriptedServerOptions) {
  const { server, models } = createScriptedServer(options);
  const client = new HarnessClient(createInProcessTransport(server));
  return { client, models, server, close: () => { client.close(); server.dispose(); } };
}
