import { createWebRegistry, directWebFetch } from "../../capabilities/tools/web/registry.ts";
import { exaHttpsTransport } from "../../capabilities/tools/web/exa-transport.ts";
import { compatibleInferenceKey } from "../../runtime/config/inference-key.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createSession } from "../../index.ts";
import type { Model } from "../../contracts/loop.ts";
import type { PersistentSession, TurnServices } from "../../contracts/session.ts";
import { openRouter } from "../../capabilities/model/openrouter.ts";
import { loadScenario, scriptedCompatibilityKey } from "../../capabilities/model/scenario-file.ts";
import { scenarioAttempt } from "../../capabilities/model/scenario-attempt.ts";
import { bindModelAttempt } from "../../capabilities/model/attempt.ts";
import { openAICompatibleAttempt, openRouterAttempt } from "../../capabilities/model/openrouter-stream.ts";
import { currentTimeDefinition, executeCurrentTime } from "../../capabilities/tools/builtin/current-time.ts";
import { debugToolDefinitions, debugToolHandlers } from "../../capabilities/tools/debug/index.ts";
import { notifyChannelDefinition } from "../../capabilities/tools/builtin/notify-channel.ts";
import { createMemoryStorageAdapter } from "../../state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../../state/storage/sqlite.ts";
import { createInspection } from "../inspector/state.ts";
import { observeModel, observeSession } from "../inspector/observe.ts";
import type { ManagedConfig } from "../../contracts/config-permissions.ts";
import { chooseManagedConfig } from "../../runtime/config/paths.ts";
import { resolveCompatibleCredential, resolveCredential, validateManagedConfig } from "../../runtime/config/managed.ts";
import { createManagedAttachmentService } from "../../capabilities/attachments/service.ts";
import { imageValidationAvailable, validateManagedImage } from "../../capabilities/attachments/image-validation.ts";

export interface DevelopmentOptions {
  systemPrompt: string;
  /** Explicit replacement of the selected config's system text for this open. */
  instructions?: string;
  /** SQLite file for a durable session; memory when omitted. */
  database?: string;
  /** Managed session media root; explicit databases default to PATH.media. */
  mediaRoot?: string;
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
  timelineTools?: boolean;
  /** Process-local prompt override used by the development debug mode. */
  debugInstructions?: string;
  environment?: Record<string, string | undefined>;
}

/** The development session exactly as `bun run start` runs it, without any
 * listener: storage, real or scripted inference, tools and the
 * inspector's view. Opening executes nothing; the caller starts or resumes. */
export async function openDevelopment(options: DevelopmentOptions) {
  const sqlite = options.database ? createSqliteStorageAdapter(options.database, { mediaRoot: options.mediaRoot ?? `${options.database}.media` }) : undefined;
  let adapter = sqlite ?? createMemoryStorageAdapter();
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
  if (managedConfig && options.timelineTools) managedConfig = { ...managedConfig, timelineTools: true };
  const savedConfig = managedConfig;
  if (managedConfig && options.debugInstructions !== undefined && options.instructions === undefined)
    managedConfig = { ...managedConfig, system: options.debugInstructions };
  const systemPrompt = options.instructions ?? options.debugInstructions ?? managedConfig?.system ?? options.systemPrompt;
  const scriptPath = managedConfig?.model.protocol === "scripted" ? managedConfig.model.script : undefined;
  const compatible = managedConfig?.model.protocol === "openai-compatible" ? managedConfig.model : undefined;
  const creating = !options.database || !!options.create;
  const environment = options.environment ?? process.env;
  let compatibleKey = compatible && creating ? resolveCompatibleCredential(compatible, environment) : undefined;
  const providerModel = managedConfig?.model.protocol === "openrouter" ? managedConfig.model : undefined;
  const apiKey = providerModel ? (useLegacyCredential ? options.provider!.apiKey : resolveCredential(providerModel, options.environment ?? process.env)) : undefined;
  if (providerModel && !apiKey) throw new Error(`config.model.apiKeyEnv: environment variable ${providerModel.apiKeyEnv} is missing or empty`);
  const script = scriptPath ? await loadScenario(scriptPath) : undefined;
  if (!script && !providerModel && !compatible) throw new Error("Development needs provider credentials or a script");
  const scriptedTools = script ? options.scriptedTools : undefined;
  const tools = [currentTimeDefinition, ...(scriptedTools?.tools ?? []),
    ...(options.debugTools ? debugToolDefinitions : []), notifyChannelDefinition];
  let imageInput = managedConfig?.model.protocol !== "openai-compatible" && managedConfig?.model.imageInput === true && (managedConfig.model.protocol === "scripted" || !options.providerFactory) && imageValidationAvailable();
  const compatibilityKey = compatible ? compatibleInferenceKey(compatible, systemPrompt, tools.map(tool => tool.name)) : script ? scriptedCompatibilityKey(script.modelDigest, systemPrompt + (managedConfig?.model.protocol !== "openai-compatible" && managedConfig?.model.imageInput === true ? "\n[image-input-enabled]" : ""))
    : createHash("sha256").update(JSON.stringify([systemPrompt, providerModel!.model, tools.map(tool => tool.name), ...(managedConfig?.model.protocol !== "openai-compatible" && managedConfig?.model.imageInput === true ? ["image-input-enabled"] : [])])).digest("hex");
  const tempMedia = sqlite ? undefined : mkdtempSync(join(tmpdir(), "harness-media-"));
  const mediaRoot = options.database ? options.mediaRoot ?? `${options.database}.media` : join(tempMedia!, "media");
  if (!sqlite) adapter = createMemoryStorageAdapter({ mediaRoot });
  const makeWebTools = () => {
    const result = createWebRegistry(managedConfig ?? {}, environment, { exa: exaHttpsTransport, http: directWebFetch });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
  };
  let webTools = creating ? makeWebTools() : undefined;
  const opened = adapter.open({ mode: options.database && !options.create ? "open" : "create",
    identity: { sessionId, compatibilityKey }, config: managedConfig, requiredScriptDigest: script?.modelDigest });
  if (!opened.ok) { if (tempMedia) rmSync(tempMedia, { recursive: true, force: true }); throw new Error(`Cannot open session storage (${opened.error.code}): ${opened.error.message}`); }
  const storage = opened.value;
  let attachments: ReturnType<typeof createManagedAttachmentService> | undefined;
  try {
    const execution = storage.executionCompatible();
    if (!execution.ok) throw new Error(execution.error.message);
    if (!execution.value) imageInput = false;
    else {
      if (!creating) { if (compatible) compatibleKey = resolveCompatibleCredential(compatible, environment); webTools = makeWebTools(); }
      attachments = createManagedAttachmentService(mediaRoot, storage, validateManagedImage);
    }
  }
  catch (error) { storage.close(); if (tempMedia) rmSync(tempMedia, { recursive: true, force: true }); throw error; }
  if (savedConfig) {
    const saved = storage.saveConfig(savedConfig);
    if (!saved.ok && saved.error.code !== "incompatible") { attachments?.close(); storage.close(); if (tempMedia) rmSync(tempMedia, { recursive: true, force: true }); throw new Error(`Cannot save config: ${saved.error.message}`); }
  }

  const inspection = createInspection(systemPrompt, tools, storage, options.database ?? "memory");
  const captureScript = (options.environment ?? process.env).HARNESS_CAPTURE_SCRIPT_REQUESTS === "1";
  const session: PersistentSession = createSession({
    systemPrompt, storage, config: managedConfig, imageInput, webTools, captureContext: (!script || captureScript) ? inspection.capture : undefined,
    observeModelCall: inspection.modelCall,
    configureTurn(turn) {
      const model = observeModel(inspection, turn.channelId, onRequest => {
        if (script || compatible) return async () => { throw new Error("Model requires a reserved attempt"); };
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
      } else if (compatible) {
        bindModelAttempt(model, { scripted: false, create: () => openAICompatibleAttempt(compatible.baseUrl, compatible.model, compatibleKey, fetch,
          body => inspection.request(turn.channelId, body, turn.turnId), attachments ? id => {
            const value = storage.readManagedAttachment(id); return value.ok ? value.value?.metadata : undefined;
          } : undefined) });
      } else if (!options.providerFactory) bindModelAttempt(model, { scripted: false, create: () => {
        const next = openRouterAttempt(apiKey!, providerModel!.model, fetch, body => inspection.request(turn.channelId, body, turn.turnId),
          attachments ? { supported: imageInput, metadata(id) { const result = storage.readManagedAttachment(id); return result.ok ? result.value?.metadata : undefined; },
            read(metadata) { return attachments!.readForInference(turn.channelId, metadata.id); },
            verify(metadata, signal) { return attachments!.verifyForInference(turn.channelId, metadata.id, signal); } } : undefined);
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
    session, inspection, attachments, imageInput, storage: options.database ?? "memory",
    /** The session as local clients use it: acceptance also refreshes the inspector. */
    local: { agent: observed.agent, subscribe: session.subscribe },
    close() { session.reminders?.releaseTimer(); observed.stop(); attachments?.close(); const closed = storage.close(); if (tempMedia) rmSync(tempMedia, { recursive: true, force: true }); if (!closed.ok) throw new Error(`Cannot close session storage (${closed.error.code}): ${closed.error.message}`); },
  };
}
