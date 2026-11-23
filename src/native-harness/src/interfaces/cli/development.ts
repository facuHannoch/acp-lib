import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSession } from "../../index.ts";
import type { Model } from "../../contracts/loop.ts";
import type { PersistentSession, TurnServices } from "../../contracts/session.ts";
import { openRouter } from "../../capabilities/model/openrouter.ts";
import { loadScenario, scriptedCompatibilityKey } from "../../capabilities/model/scenario-file.ts";
import { scenarioAttempt } from "../../capabilities/model/scenario-attempt.ts";
import { bindModelAttempt } from "../../capabilities/model/attempt.ts";
import { openRouterAttempt } from "../../capabilities/model/openrouter-stream.ts";
import { currentTimeDefinition, executeCurrentTime } from "../../capabilities/tools/builtin/current-time.ts";
import { debugToolDefinitions, debugToolHandlers } from "../../capabilities/tools/debug/index.ts";
import { notifyChannelDefinition } from "../../capabilities/tools/builtin/notify-channel.ts";
import { createMemoryStorageAdapter } from "../../state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../../state/storage/sqlite.ts";
import { createInspection } from "../inspector/state.ts";
import { observeModel, observeSession } from "../inspector/observe.ts";
import type { ManagedConfig } from "../../contracts/config-permissions.ts";
import { chooseManagedConfig } from "../../runtime/config/paths.ts";
import { resolveCredential, validateManagedConfig } from "../../runtime/config/managed.ts";

export interface DevelopmentOptions {
  systemPrompt: string;
  /** Explicit replacement of the selected config's system text for this open. */
  instructions?: string;
  /** SQLite file for a durable session; memory when omitted. */
  database?: string;
  /** Expected ID for a named session, or the ID to assign on creation. */
  sessionId?: string;
  /** Create the database (it must not exist) instead of opening it. */
  create?: boolean;
  /** Provider credentials, or `script` for offline runs without a key. */
  provider?: { apiKey: string; model: string };
  /** A scripted-model file: one script, or `{ channels: { <id>: script }, default?: script }`. */
  script?: string;
  /** Optional tools supplied by a scripted test. */
  scriptedTools?: Pick<TurnServices, "tools" | "executeTool">;
  /** Validated portable config selected by the development host. */
  managedConfig?: ManagedConfig;
  /** Provider injection and environment are useful for offline tests and hosts. */
  providerFactory?: (apiKey: string, model: string, onRequest?: (body: string) => void) => Model;
  /** Expose safe diagnostic tools for this process. */
  debugTools?: boolean;
  /** Process-local prompt override used by the development debug mode. */
  debugInstructions?: string;
  environment?: Record<string, string | undefined>;
}

/** The development session exactly as `bun run start` runs it, without any
 * listener: storage, real or scripted inference, tools and the
 * inspector's view. Opening executes nothing; the caller starts or resumes. */
export async function openDevelopment(options: DevelopmentOptions) {
  const sqlite = options.database ? createSqliteStorageAdapter(options.database) : undefined;
  const adapter = sqlite ?? createMemoryStorageAdapter();
  let sessionId = options.sessionId ?? "development";
  if (options.database && !options.create && !existsSync(options.database))
    throw new Error(`No session database at ${options.database}. Pass --create to create it.`);
  let managedConfig = options.managedConfig;
  let hadSaved = false, hasSidecar = false;
  if (options.database && !options.create) {
    const saved = sqlite!.readSavedHeader();
    if (!saved.ok) throw new Error(`Cannot read saved config (${saved.error.code}): ${saved.error.message}`);
    sessionId = options.sessionId ?? saved.value.sessionId;
    hadSaved = saved.value.config !== undefined;
    const sidecar = join(dirname(options.database), "config.json"); hasSidecar = existsSync(sidecar);
    const inline = managedConfig ?? (options.script ? { version: 1, system: options.systemPrompt, model: { protocol: "scripted", script: options.script },
      defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } } } : undefined);
    if (inline || hadSaved || hasSidecar) managedConfig = chooseManagedConfig({ mode: "open", sidecar, inline, saved: saved.value.config });
  }
  const useLegacyCredential = !!options.provider && !hadSaved && !hasSidecar && !options.managedConfig;
  if (!managedConfig && options.script) managedConfig = validateManagedConfig({ version: 1, system: options.systemPrompt,
    model: { protocol: "scripted", script: options.script }, defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } } });
  if (!managedConfig && options.provider) managedConfig = validateManagedConfig({ version: 1, system: options.systemPrompt,
    model: { protocol: "openrouter", model: options.provider.model, apiKeyEnv: "OPENROUTER_API_KEY" }, defaultPolicy: "__legacy_allow",
    policies: { __legacy_allow: { fallback: "allow", tools: {} } } });
  if (managedConfig && options.instructions !== undefined) managedConfig = { ...managedConfig, system: options.instructions };
  const savedConfig = managedConfig;
  if (managedConfig && options.debugInstructions !== undefined && options.instructions === undefined)
    managedConfig = { ...managedConfig, system: options.debugInstructions };
  const systemPrompt = options.instructions ?? options.debugInstructions ?? managedConfig?.system ?? options.systemPrompt;
  const scriptPath = managedConfig?.model.protocol === "scripted" ? managedConfig.model.script : undefined;
  const providerModel = managedConfig?.model.protocol === "openrouter" ? managedConfig.model : undefined;
  const apiKey = providerModel ? (useLegacyCredential ? options.provider!.apiKey : resolveCredential(providerModel, options.environment ?? process.env)) : undefined;
  if (providerModel && !apiKey) throw new Error(`config.model.apiKeyEnv: environment variable ${providerModel.apiKeyEnv} is missing or empty`);
  const script = scriptPath ? await loadScenario(scriptPath) : undefined;
  if (!script && !providerModel) throw new Error("Development needs provider credentials or a script");
  const scriptedTools = script ? options.scriptedTools : undefined;
  const tools = [currentTimeDefinition, ...(scriptedTools?.tools ?? []),
    ...(options.debugTools ? debugToolDefinitions : []), notifyChannelDefinition];
  const compatibilityKey = script ? scriptedCompatibilityKey(script.modelDigest, systemPrompt)
    : createHash("sha256").update(JSON.stringify([systemPrompt, providerModel!.model, tools.map(tool => tool.name)])).digest("hex");
  const opened = adapter.open({ mode: options.database && !options.create ? "open" : "create",
    identity: { sessionId, compatibilityKey }, config: managedConfig, requiredScriptDigest: script?.modelDigest });
  if (!opened.ok) throw new Error(`Cannot open session storage (${opened.error.code}): ${opened.error.message}`);
  const storage = opened.value;
  if (savedConfig) {
    const saved = storage.saveConfig(savedConfig);
    if (!saved.ok && saved.error.code !== "incompatible") { storage.close(); throw new Error(`Cannot save config: ${saved.error.message}`); }
  }

  const inspection = createInspection(systemPrompt, tools, storage, options.database ?? "memory");
  const captureScript = (options.environment ?? process.env).HARNESS_CAPTURE_SCRIPT_REQUESTS === "1";
  const session: PersistentSession = createSession({
    systemPrompt, storage, config: managedConfig, captureContext: (!script || captureScript) ? inspection.capture : undefined,
    observeModelCall: inspection.modelCall,
    configureTurn(turn) {
      const model = observeModel(inspection, turn.channelId, onRequest => {
        if (script) return async () => { throw new Error("Scripted model requires a reserved attempt"); };
        const provider = (options.providerFactory ?? openRouter)(apiKey!, providerModel!.model, onRequest);
        return provider;
      }, turn.turnId);
      if (script) {
        bindModelAttempt(model, { scripted: true, create: step => {
          const next = scenarioAttempt(script, turn.channelId, step!);
          return async function* (request, signal) {
            if (captureScript)
              inspection.request(turn.channelId, JSON.stringify(request), turn.turnId);
            for await (const event of next(request, signal)) { if (event.type === "response") inspection.response(turn.channelId, event.response); yield event; }
          };
        } });
      } else if (!options.providerFactory) bindModelAttempt(model, { scripted: false, create: () => {
        const next = openRouterAttempt(apiKey!, providerModel!.model, fetch, body => inspection.request(turn.channelId, body, turn.turnId));
        return async function* (request, signal) { for await (const event of next(request, signal)) { if (event.type === "response") inspection.response(turn.channelId, event.response); yield event; } };
      } });
      return { model, tools, executeTool: (call, signal) => {
        const debug = options.debugTools ? debugToolHandlers.get(call.name) : undefined;
        if (debug) return debug(call, signal);
        return call.name === currentTimeDefinition.name || !scriptedTools
          ? executeCurrentTime(call, signal) : scriptedTools.executeTool(call, signal);
      } };
    },
  });
  const observed = observeSession(session, inspection);
  const stop = session.stop;
  session.stop = reason => { const result = stop(reason); inspection.stopped(); return result; };
  return {
    session, inspection, storage: options.database ?? "memory",
    /** The session as local clients use it: acceptance also refreshes the inspector. */
    local: { agent: observed.agent, subscribe: session.subscribe },
    close() { observed.stop(); const closed = storage.close(); if (!closed.ok) throw new Error(`Cannot close session storage (${closed.error.code}): ${closed.error.message}`); },
  };
}
