import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
}

/** The development session exactly as `bun run start` runs it, without any
 * listener: storage, real or scripted inference, scenario tools and the
 * inspector's view. Opening executes nothing; the caller starts or resumes. */
export async function openDevelopment(options: DevelopmentOptions) {
  const { systemPrompt } = options;
  let scripts: { channels: Record<string, unknown>; fallback?: unknown } | undefined;
  if (options.script) {
    const loaded = await Bun.file(options.script).json() as Record<string, unknown>;
    scripts = loaded && typeof loaded === "object" && "channels" in loaded
      ? { channels: loaded.channels as Record<string, unknown>, fallback: loaded.default } : { channels: {}, fallback: loaded };
    for (const script of [...Object.values(scripts.channels), ...(scripts.fallback ? [scripts.fallback] : [])]) createScriptedModel(script);
  } else if (!options.provider) throw new Error("Development needs provider credentials or a script");

  // Compatible means the same prompt, the same model (or scripts) and the same tools.
  const compatibilityKey = createHash("sha256").update(JSON.stringify([systemPrompt,
    scripts ?? options.provider!.model, scenarioDefinitions.map(tool => tool.name)])).digest("hex");
  const adapter = options.database ? createSqliteStorageAdapter(options.database) : createMemoryStorageAdapter();
  if (options.database && !options.create && !existsSync(options.database))
    throw new Error(`No session database at ${options.database}. Pass --create to create it.`);
  const opened = adapter.open({ mode: options.database && !options.create ? "open" : "create", identity: { sessionId: "development", compatibilityKey } });
  if (!opened.ok) throw new Error(`Cannot open session storage (${opened.error.code}): ${opened.error.message}`);
  const storage = opened.value;

  const inspection = createInspection(systemPrompt, scenarioDefinitions);
  const dashboard = createDashboardWork(options.dashboardWait);
  const scripted = new Map<string, Model>();
  const session: PersistentSession = createSession({
    systemPrompt, storage,
    configureTurn(turn, notify) {
      const scenario = createScenarioTools(turn, dashboard, notify);
      const model = observeModel(inspection, turn.channelId, onRequest => {
        if (!scripts) {
          const provider = openRouter(options.provider!.apiKey, options.provider!.model, onRequest);
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
    close() { stopContext(); observed.stop(); storage.close(); },
  };
}
