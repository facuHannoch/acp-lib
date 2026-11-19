import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSession } from "../../index.ts";
import type { Model } from "../../contracts/loop.ts";
import type { PersistentSession } from "../../contracts/session.ts";
import { buildSharedContext } from "../../capabilities/context/build.ts";
import { openRouter } from "../../capabilities/model/openrouter.ts";
import { createScriptedModel } from "../../capabilities/model/scripted.ts";
import { createDashboardWork } from "../../capabilities/tools/dashboard.ts";
import { createScenarioTools, scenarioDefinitions } from "../../capabilities/tools/scenario.ts";
import { createMemoryStorageAdapter } from "../../state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../../state/storage/sqlite.ts";
import { createInspection } from "../inspector/state.ts";
import { observeContext, observeModel, observeSession } from "../inspector/observe.ts";
import type { ManagedConfig } from "../../contracts/config-permissions.ts";
import { chooseManagedConfig } from "../../runtime/config/paths.ts";
import { resolveCredential, validateManagedConfig } from "../../runtime/config/managed.ts";

export interface DevelopmentOptions {
  systemPrompt: string;
  /** SQLite file for a durable session; memory when omitted. */
  database?: string;
  /** Create the database (it must not exist) instead of opening it. */
  create?: boolean;
  /** Provider credentials, or `script` for offline runs without a key. */
  provider?: { apiKey: string; model: string };
  /** A scripted-model file: one script, or `{ channels: { <id>: script }, default?: script }`. */
  script?: string;
  dashboardWait?: () => Promise<void>;
  /** Validated portable config selected by the development host. */
  managedConfig?: ManagedConfig;
  /** Provider injection and environment are useful for offline tests and hosts. */
  providerFactory?: (apiKey: string, model: string, onRequest?: (body: string) => void) => Model;
  environment?: Record<string, string | undefined>;
}

/** The development session exactly as `bun run start` runs it, without any
 * listener: storage, real or scripted inference, scenario tools and the
 * inspector's view. Opening executes nothing; the caller starts or resumes. */
export async function openDevelopment(options: DevelopmentOptions) {
  const adapter = options.database ? createSqliteStorageAdapter(options.database) : createMemoryStorageAdapter();
  if (options.database && !options.create && !existsSync(options.database))
    throw new Error(`No session database at ${options.database}. Pass --create to create it.`);
  let managedConfig = options.managedConfig;
  let hadSaved = false, hasSidecar = false;
  if (options.database && !options.create) {
    const saved = adapter.readSavedConfig();
    if (!saved.ok) throw new Error(`Cannot read saved config (${saved.error.code}): ${saved.error.message}`);
    hadSaved = saved.value !== undefined;
    const sidecar = join(dirname(options.database), "config.json"); hasSidecar = existsSync(sidecar);
    const inline = managedConfig ?? (options.script ? { version: 1, system: options.systemPrompt, model: { protocol: "scripted", script: options.script },
      defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } } } : undefined);
    if (inline || saved.value || hasSidecar) managedConfig = chooseManagedConfig({ mode: "open", sidecar, inline, saved: saved.value });
  }
  const useLegacyCredential = !!options.provider && !hadSaved && !hasSidecar && !options.managedConfig;
  if (!managedConfig && options.script) managedConfig = validateManagedConfig({ version: 1, system: options.systemPrompt,
    model: { protocol: "scripted", script: options.script }, defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow", tools: {} } } });
  if (!managedConfig && options.provider) managedConfig = validateManagedConfig({ version: 1, system: options.systemPrompt,
    model: { protocol: "openrouter", model: options.provider.model, apiKeyEnv: "OPENROUTER_API_KEY" }, defaultPolicy: "__legacy_allow",
    policies: { __legacy_allow: { fallback: "allow", tools: {} } } });
  const systemPrompt = managedConfig?.system ?? options.systemPrompt;
  const scriptPath = managedConfig?.model.protocol === "scripted" ? managedConfig.model.script : undefined;
  const providerModel = managedConfig?.model.protocol === "openrouter" ? managedConfig.model : undefined;
  const apiKey = providerModel ? (useLegacyCredential ? options.provider!.apiKey : resolveCredential(providerModel, options.environment ?? process.env)) : undefined;
  if (providerModel && !apiKey) throw new Error(`config.model.apiKeyEnv: environment variable ${providerModel.apiKeyEnv} is missing or empty`);
  let scripts: { channels: Record<string, unknown>; fallback?: unknown } | undefined;
  if (scriptPath) {
    const loaded = await Bun.file(scriptPath).json() as Record<string, unknown>;
    scripts = loaded && typeof loaded === "object" && "channels" in loaded
      ? { channels: loaded.channels as Record<string, unknown>, fallback: loaded.default } : { channels: {}, fallback: loaded };
    for (const script of [...Object.values(scripts.channels), ...(scripts.fallback ? [scripts.fallback] : [])]) createScriptedModel(script);
  } else if (!providerModel) throw new Error("Development needs provider credentials or a script");

  // Compatible means the same prompt, the same model (or scripts) and the same tools.
  const compatibility = managedConfig && scriptPath
    ? [systemPrompt, await Bun.file(scriptPath).json()]
    : [systemPrompt, providerModel!.model, scenarioDefinitions.map(tool => tool.name)];
  const compatibilityKey = createHash("sha256").update(JSON.stringify(compatibility)).digest("hex");
  const opened = adapter.open({ mode: options.database && !options.create ? "open" : "create", identity: { sessionId: "development", compatibilityKey }, config: managedConfig });
  if (!opened.ok) throw new Error(`Cannot open session storage (${opened.error.code}): ${opened.error.message}`);
  const storage = opened.value;
  if (managedConfig) {
    const saved = storage.saveConfig(managedConfig);
    if (!saved.ok && saved.error.code !== "incompatible") { storage.close(); throw new Error(`Cannot save config: ${saved.error.message}`); }
  }

  const inspection = createInspection(systemPrompt, scenarioDefinitions);
  const dashboard = createDashboardWork(options.dashboardWait);
  const scripted = new Map<string, Model>();
  const session: PersistentSession = createSession({
    systemPrompt, storage,
    configureTurn(turn, notify) {
      const scenario = createScenarioTools(turn, dashboard, notify);
      const model = observeModel(inspection, turn.channelId, onRequest => {
        if (!scripts) {
          const provider = (options.providerFactory ?? openRouter)(apiKey!, providerModel!.model, onRequest);
          return (messages, tools, signal) => { scenario.beginInference(); return provider(messages, tools, signal); };
        }
        let channel = scripted.get(turn.channelId);
        if (!channel) {
          const script = scripts.channels[turn.channelId] ?? scripts.fallback;
          if (!script) throw new Error(`No script for channel ${turn.channelId}`);
          // Continue each channel's script after the responses already recorded for it.
          const consumed = session.snapshot().timeline.filter(entry => entry.channelId === turn.channelId && entry.message.role === "assistant").length;
          channel = createScriptedModel(script, consumed).model; scripted.set(turn.channelId, channel);
        }
        const next = channel;
        return (messages, tools, signal) => { scenario.beginInference(); onRequest(JSON.stringify({ messages, tools })); return next(messages, tools, signal); };
      }, turn.turnId);
      return { model, tools: scenarioDefinitions, executeTool: scenario.execute };
    },
  });
  // Both observers read storage at attach, so a reopened session's timeline,
  // lifecycle and pending input are in the inspector before any new message.
  const stopContext = observeContext(session.store, inspection, entries => buildSharedContext(entries, systemPrompt, session.snapshot().turns));
  const observed = observeSession(session, inspection, options.database ?? "memory");
  return {
    session, inspection, storage: options.database ?? "memory",
    /** The session as local clients use it: acceptance also refreshes the inspector. */
    local: { agent: observed.agent, subscribe: session.subscribe },
    close() { stopContext(); observed.stop(); const closed = storage.close(); if (!closed.ok) throw new Error(`Cannot close session storage (${closed.error.code}): ${closed.error.message}`); },
  };
}
