import { openMcpRegistry } from "./capabilities/tools/mcp/registry.ts";
import { createWebRegistry, directWebFetch } from "./capabilities/tools/web/registry.ts";
import { exaHttpsTransport } from "./capabilities/tools/web/exa-transport.ts";
import { webDefinitions } from "./capabilities/tools/web/definitions.ts";
import { compatibleInferenceKey } from "./runtime/config/inference-key.ts";
import { wallReminderClock } from "./runtime/reminder-timer.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, existsSync, rmdirSync, appendFileSync } from "node:fs";
import { createSession } from "./index.ts";
import type { SessionStorage, SessionStorageAdapter } from "./contracts/storage.ts";
import type { ExecuteTool, Model } from "./contracts/loop.ts";
import { loadScenario, scriptedCompatibilityKey } from "./capabilities/model/scenario-file.ts";
import { scenarioAttempt } from "./capabilities/model/scenario-attempt.ts";
import type { ModelRequest } from "./contracts/model-execution.ts";
import type { LoadedScenario } from "./contracts/scenario.ts";
export type { LoadedScenario, ScenarioHeader, ScenarioModelRecord, ScenarioRecord, ScenarioSend } from "./contracts/scenario.ts";
export { loadScenario, parseScenario } from "./capabilities/model/scenario-file.ts";
import { bindModelAttempt } from "./capabilities/model/attempt.ts";
import { openAICompatibleAttempt, openRouterAttempt } from "./capabilities/model/openrouter-stream.ts";
import { openRouter } from "./capabilities/model/openrouter.ts";
import { notifyChannelDefinition } from "./capabilities/tools/builtin/notify-channel.ts";
import { echoDefinition, executeEcho } from "./capabilities/tools/testing/echo.ts";
import { createHoldTool, createRecordTool, holdDefinition, recordDefinition } from "./capabilities/tools/testing/record.ts";
import { createMemoryStorageAdapter } from "./state/storage/memory.ts";
import { createSqliteStorageAdapter } from "./state/storage/sqlite.ts";
import { validateSessionPayload } from "./state/storage/archive.ts";
import { createProtocolServer, SessionOpenError } from "./interfaces/protocol/server.ts";
import { parseCatalog } from "./capabilities/tools/runtime/catalog.ts";
import { HarnessClient, createInProcessTransport } from "./client.ts";
import { chooseManagedConfig, managedSessionPaths } from "./runtime/config/paths.ts";
import { resolveCompatibleCredential, resolveCredential } from "./runtime/config/managed.ts";
import { createManagedAttachmentService } from "./capabilities/attachments/service.ts";
import { imageValidationAvailable, validateManagedImage } from "./capabilities/attachments/image-validation.ts";

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
  /** Opt-in scripted stall and shorter model deadline for offline process tests. */
  stallChannel?: string;
  snapshotLog?: string;
  /** Lightweight local attempt evidence without request capture. */
  attempts?: string;
  captureRequests?: boolean;
  /** Test seam for observing file reads. */
  scenarioLoader?: (path: string) => Promise<LoadedScenario>;
  streamResponses?: boolean;
  modelTimeoutMs?: number;
  reminderTime?: number;
  /** Directory for transfer files when there is no home. */
  transfers?: string;
  /** Smaller transfer limits for tests. */
  limits?: Partial<{ chunkBytes: number; maxBytes: number; idleMs: number }>;
  /** Offline provider injection and destination environment for tests/hosts. */
  providerFactory?: (apiKey: string, model: string) => Model;
  /** Test-only loopback fixture for observing the actual provider request. */
  providerEndpoint?: string;
  /** Test assembly injection; never selected through managed configuration. */
  webTransport?: import("./capabilities/tools/web/exa.ts").ExaTransport;
  webHttp?: import("./capabilities/tools/web/registry.ts").DirectFetch;
  /** Offline stdio fixture endpoint, restricted to literal loopback. */
  webEndpoint?: string;
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
const BUILTINS = [echoDefinition, recordDefinition, holdDefinition];
export function createScriptedServer(options: ScriptedServerOptions = {}) {
  let fixtureEndpoint: string | undefined;
  if (options.providerEndpoint) {
    const url = new URL(options.providerEndpoint);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Provider fixture must use loopback HTTP");
    fixtureEndpoint = url.href;
  }
  let webFixture: import("./capabilities/tools/web/exa.ts").ExaTransport | undefined;
  if (options.webEndpoint) {
    const url = new URL(options.webEndpoint);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash)
      throw new Error("Web fixture must use literal loopback HTTP");
    webFixture = async input => {
      const response = await fetch(new URL(input.path, url), { method: "POST", headers: { "content-type": "application/json", "x-api-key": input.key }, body: JSON.stringify(input.body), signal: input.signal, redirect: "manual" });
      const chunks: Uint8Array[] = []; let size = 0;
      if (response.body) for await (const chunk of response.body) { size += chunk.byteLength; if (size > 2 * 1024 * 1024) throw Error("fixture response too large"); chunks.push(chunk); }
      return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    };
  }
  const providerFetch = fixtureEndpoint ? ((_: string | URL | Request, init?: RequestInit) => fetch(fixtureEndpoint!, init)) as unknown as typeof fetch : fetch;
  const models = new Map<string, ModelRequest[]>();
  const durable = !!(options.home || options.adapter);
  const hit = faults(options.fault);
  const memory = createMemoryStorageAdapter();
  const noSidecar = join(mkdtempSync(join(tmpdir(), "harness-config-")), "config.json");
  const locate = (sessionId: string) => {
    if (options.adapter) return options.adapter(sessionId);
    if (options.home) {
      const paths = managedSessionPaths(sessionId, options.home);
      return createSqliteStorageAdapter(paths.database, { mediaRoot: join(paths.directory, "media") });
    }
    return memory;
  };
  const server = createProtocolServer(async ({ mode, sessionId, config: inline, tools }) => {
    // Decision 0021: the catalog's names must not collide with the built-ins.
    const catalog = tools && parseCatalog(tools, [...BUILTINS, ...webDefinitions].map(tool => tool.name));
    const paths = options.home ? managedSessionPaths(sessionId, options.home) : undefined;
    const adapter = locate(sessionId);
    const stored = mode === "open" ? adapter.readSavedConfig() : undefined;
    if (stored && !stored.ok) throw new SessionOpenError(stored.error.code === "not_found" || stored.error.code === "owner_conflict" ? stored.error.code : "storage_failure", stored.error.message);
    const config = chooseManagedConfig({ mode, sidecar: paths?.config ?? noSidecar, inline, saved: stored?.ok ? stored.value : undefined });
    const script = config.model.protocol === "scripted" ? await (options.scenarioLoader ?? loadScenario)(config.model.script) : undefined;
    const credential = config.model.protocol === "openrouter" ? resolveCredential(config.model, options.environment ?? process.env) : undefined;
    let imageInput = !!paths && !options.adapter && config.model.protocol !== "openai-compatible" && config.model.imageInput === true && (config.model.protocol === "scripted" || !options.providerFactory) && imageValidationAvailable();
    const compatible = config.model.protocol === "openai-compatible" ? config.model : undefined;
    const environment = options.environment ?? process.env;
    let compatibleKey = compatible && mode === "create" ? resolveCompatibleCredential(compatible, environment) : undefined;
    const compatibilityKey = compatible ? compatibleInferenceKey(compatible, config.system, [...BUILTINS, notifyChannelDefinition].map(tool => tool.name)) : script ? scriptedCompatibilityKey(script.modelDigest, config.system + (config.model.protocol !== "openai-compatible" && config.model.imageInput === true ? "\n[image-input-enabled]" : ""))
      : createHash("sha256").update(JSON.stringify([config.system, config.model.protocol === "openrouter" && config.model.model,
        [...BUILTINS, notifyChannelDefinition].map(tool => tool.name), ...(config.model.protocol !== "openai-compatible" && config.model.imageInput === true ? ["image-input-enabled"] : [])])).digest("hex");
    if (mode === "create" && paths) mkdirSync(paths.directory, { recursive: true });
    const makeWebTools = () => {
      const result = createWebRegistry(config, environment, { exa: options.webTransport ?? webFixture ?? exaHttpsTransport, http: options.webHttp ?? directWebFetch });
      if (!result.ok) throw new SessionOpenError("invalid_config", result.error.message);
      return result.value;
    };
    let webTools = mode === "create" ? makeWebTools() : undefined;
    const opened = adapter.open({ mode, identity: { sessionId, compatibilityKey }, config, requiredScriptDigest: script?.modelDigest });
    if (!opened.ok) {
      const code = opened.error.code;
      throw new SessionOpenError(code === "not_found" || code === "already_exists" || code === "owner_conflict" || code === "incompatible" || code === "invalid_config" ? code : "storage_failure", opened.error.message);
    }
    const storage = options.fault || options.snapshotLog ? withFaults(opened.value, point => {
      if (point === "snapshot" && options.snapshotLog) appendFileSync(options.snapshotLog, "snapshot\n");
      hit(point);
    }) : opened.value;
    let mcp: Awaited<ReturnType<typeof openMcpRegistry>> | undefined;
    let attachments: ReturnType<typeof createManagedAttachmentService> | undefined;
    try {
      const execution = storage.executionCompatible();
      if (!execution.ok) throw new Error(execution.error.message);
      if (!execution.value) imageInput = false;
      if (execution.value && mode === "open") {
        if (compatible) compatibleKey = resolveCompatibleCredential(compatible, environment);
        webTools = makeWebTools();
      }
      if (execution.value && config.mcpServers) mcp = await openMcpRegistry(config, environment);
      if (execution.value && paths && !options.adapter) attachments = createManagedAttachmentService(join(paths.directory, "media"), storage, validateManagedImage, Date.now, hit);
    } catch (error) { await mcp?.close(); opened.value.close(); throw error; }
    const record = createRecordTool(options.effects), hold = createHoldTool(options.effects);
    const executeTool: ExecuteTool = async (call, signal) => {
      const result = await (call.name === "record" ? record(call, signal) : call.name === "hold" ? hold(call, signal) : executeEcho(call, signal));
      hit("tool");
      return result;
    };
    const revisions = new Map<string, number>();
    const session = createSession({
      ...(script && options.reminderTime !== undefined && Number.isSafeInteger(options.reminderTime)
        ? { reminderClock: { ...wallReminderClock, now: () => options.reminderTime! } } : {}), ...(options.requests ? { captureContext: ({ context }: import("./contracts/context.ts").ContextCapture) =>
      revisions.set(context.channelId, context.timelineRevision) } : {}), systemPrompt: config.system, config, storage, imageInput, webTools, mcpTools: mcp?.bindings, ...(catalog ? { catalog } : {}), configureTurn(turn) {
      if (compatible) {
        const model: Model = async () => { throw new Error("Chat Completions requires a model attempt"); };
        bindModelAttempt(model, { scripted: false,
          ...(options.modelTimeoutMs === undefined ? {} : { settings: { timeoutMs: options.modelTimeoutMs } }),
          create: () => openAICompatibleAttempt(compatible.baseUrl, compatible.model, compatibleKey, fetch, undefined, attachments ? id => {
            const value = storage.readManagedAttachment(id); return value.ok ? value.value?.metadata : undefined;
          } : undefined) });
        return { model, tools: [echoDefinition, recordDefinition, holdDefinition], executeTool };
      }
      if (config.model.protocol === "openrouter") {
        const model = (options.providerFactory ?? openRouter)(credential!, config.model.model);
        if (!options.providerFactory) bindModelAttempt(model, { scripted: false, create: () => openRouterAttempt(credential!, config.model.protocol === "openrouter" ? config.model.model : "", providerFetch, undefined,
          attachments ? { supported: imageInput, metadata(id) { const value = storage.readManagedAttachment(id); return value.ok ? value.value?.metadata : undefined; },
            read(metadata) { return attachments!.readForInference(turn.channelId, metadata.id); },
            verify(metadata, signal) { return attachments!.verifyForInference(turn.channelId, metadata.id, signal); } } : undefined) });
        return { model, tools: [echoDefinition, recordDefinition, holdDefinition], executeTool };
      }
      const model: Model = async () => { throw new Error("Scripted model requires a reserved attempt"); };
      bindModelAttempt(model, { scripted: true, ...(options.modelTimeoutMs === undefined ? {} : { settings: { timeoutMs: options.modelTimeoutMs } }), create: (step, ordinal) => {
        const next = scenarioAttempt(script!, turn.channelId, step!);
        return async function* (request, signal) {
          // Offline rehearsal can observe the real provider projection while
          // retaining scripted records as the source of model decisions.
          if (fixtureEndpoint && imageInput && attachments && request.messages.some(message => message.role === "user" && message.parts)) {
            const probe = openRouterAttempt("fixture", "scripted-fixture", providerFetch, undefined, {
              supported: true, metadata(id) { const value = storage.readManagedAttachment(id); return value.ok ? value.value?.metadata : undefined; },
              read(metadata) { return attachments!.readForInference(turn.channelId, metadata.id); },
              verify(metadata, signal) { return attachments!.verifyForInference(turn.channelId, metadata.id, signal); },
            });
            for await (const event of probe(request, signal)) if (event.type === "failure") throw new Error(event.code ?? event.message);
          }
          if (options.attempts) appendFileSync(options.attempts, `${JSON.stringify({ channel: turn.channelId, turnId: turn.turnId, step, ordinal, itemIds: request.takenItemIds })}\n`);
          if (options.captureRequests) {
            const requests = models.get(turn.channelId) ?? [];
            requests.push(structuredClone(request));
            models.set(turn.channelId, requests);
          }
          if (options.requests) appendFileSync(options.requests, `${JSON.stringify({ channel: turn.channelId, turnId: turn.turnId, revision: revisions.get(turn.channelId), messages: request.messages, tools: request.tools.map(tool => tool.name) })}\n`);
          if (options.stallChannel === turn.channelId && step === 0) {
            yield { type: "accepted" }; yield { type: "usage", usage: { inputTokens: 7 } };
            yield { type: "text_delta", text: "Partial reply" };
            if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
            return;
          }
          let streamed = false;
          for await (const event of next(request, signal)) {
            if (event.type === "text_delta") streamed = true;
            if (!streamed && options.streamResponses && event.type === "response" && event.response.content)
              yield { type: "text_delta", text: event.response.content };
            yield event;
          }
        };
      } });
      return { model, tools: [echoDefinition, recordDefinition, holdDefinition], executeTool };
    } });
    return { session, config, imageInput, ...(mcp ? { mcpStatus: mcp.status, stopMcp: mcp.close } : {}), ...(attachments ? { attachments } : {}), close() { void mcp?.close(); attachments?.close(); opened.value.close(); }, commitConfig() {
      const saved = storage.saveConfig(config);
      if (!saved.ok && saved.error.code !== "incompatible") throw new SessionOpenError("storage_failure", saved.error.message);
    }, exportArchive: () => storage.exportArchive() };
  }, { durable, functions: true, mcpStdio: true, attachments: !!options.home && !options.adapter, limits: options.limits, transferDirectory: durable ? options.home ?? options.transfers ?? mkdtempSync(join(tmpdir(), "harness-transfers-")) : undefined,
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
  return { client, models, server, close: () => { client.close(); return server.dispose(); } };
}
