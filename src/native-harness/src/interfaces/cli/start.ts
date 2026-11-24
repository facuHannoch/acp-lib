import { mkdir, readFile } from "node:fs/promises";
import { agentConfiguration, localConnection } from "../../runtime/config/development.ts";
import { serveInspector } from "../inspector/server.ts";
import { createChannelHandler, serveLocal } from "../protocol/local.ts";
import { createChannelOutputs, publishChannelEvent } from "../protocol/output.ts";
import { serveWebChat } from "../web-chat/server.ts";
import { loadInstructions } from "../../capabilities/context/load-instructions.ts";
import { openDevelopment } from "./development.ts";
import { bindLocalSocket, bindWebPort } from "./listeners.ts";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createSqliteStorageAdapter } from "../../state/storage/sqlite.ts";
import { chooseManagedConfig, managedSessionPaths } from "../../runtime/config/paths.ts";

export interface StartOptions { database?: string; sessionId?: string; create?: boolean; resume?: boolean; script?: string; instructions?: string; debug?: boolean; debugTools?: boolean; timelineTools?: boolean }

export async function start(options: StartOptions = {}) {
  if (options.database !== undefined && options.sessionId !== undefined)
    throw new Error("Choose either --db <path> or --session <id>");
  const generated = options.database === undefined && options.sessionId === undefined;
  const sessionId = options.database === undefined ? options.sessionId ?? crypto.randomUUID() : undefined;
  const managed = sessionId === undefined ? undefined : managedSessionPaths(sessionId, join(homedir(), ".harness", "sessions"));
  const database = options.database ?? managed!.database;
  const create = generated || !!options.create;
  if (!create && !existsSync(database)) throw new Error(`No session database at ${database}. Pass --create to create it.`);

  const instructions = options.instructions === undefined ? undefined : await readFile(options.instructions, "utf8");
  const systemPrompt = instructions ?? loadInstructions(options.script ? "agent-demo" : "agent");
  let managedConfig;
  if (options.script) managedConfig = { version: 1 as const, system: systemPrompt,
    model: { protocol: "scripted" as const, script: resolve(options.script) }, defaultPolicy: "__legacy_allow",
    policies: { __legacy_allow: { fallback: "allow" as const, tools: {} } } };
  if (create && !managedConfig) {
    const sidecar = join(dirname(database), "config.json");
    if (existsSync(sidecar)) managedConfig = chooseManagedConfig({ mode: "create", sidecar });
  }
  if (!create) {
    const saved = createSqliteStorageAdapter(database).readSavedConfig();
    const sidecar = join(dirname(database), "config.json");
    if (existsSync(sidecar) || managedConfig || (saved.ok && saved.value))
      managedConfig = chooseManagedConfig({ mode: "open", sidecar, inline: managedConfig, saved: saved.ok ? saved.value : undefined });
  }
  const script = managedConfig ? (managedConfig.model.protocol === "scripted" ? managedConfig.model.script : undefined) : options.script;
  // Managed OpenRouter resolves its named credential inside openDevelopment;
  // scripted runs do not need a provider key at all.
  const config = (script || managedConfig) ? { ...localConnection(), apiKey: "", model: "",
    inspectorPort: Number(process.env.HARNESS_INSPECTOR_PORT ?? 3000), webChatPort: Number(process.env.HARNESS_CHAT_PORT ?? 3001) } : agentConfiguration();
  if (config.managedDirectory) await mkdir(config.managedDirectory, { recursive: true, mode: 0o700 });
  if (managed && create) await mkdir(managed.directory, { recursive: true, mode: 0o700 });
  const development = await openDevelopment({ systemPrompt, database, ...(managed ? { mediaRoot: join(managed.directory, "media") } : {}), sessionId, create, script, managedConfig, instructions,
    debugTools: options.debug || options.debugTools,
    timelineTools: options.timelineTools,
    debugInstructions: options.debug && instructions === undefined ? loadInstructions("agent-demo") : undefined,
    provider: script || managedConfig ? undefined : { apiKey: config.apiKey, model: config.model } });
  const { session, inspection, local } = development;
  const outputs = createChannelOutputs();
  const stopOutput = session.subscribe(event => publishChannelEvent(outputs, event));

  // Restrict the socket itself as well as the default parent directory.
  process.umask(0o077);
  let server: ReturnType<typeof serveLocal> | undefined;
  let inspector: ReturnType<typeof serveInspector> | undefined;
  let webChat: ReturnType<typeof serveWebChat>;
  try {
    const port = config.inspectorPort;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid HARNESS_INSPECTOR_PORT");
    if (!Number.isInteger(config.webChatPort) || config.webChatPort < 0 || config.webChatPort > 65535) throw new Error("Invalid HARNESS_CHAT_PORT");
    server = await bindLocalSocket(config.socketPath, () => serveLocal(local, config.socketPath, outputs, session));
    inspector = bindWebPort(port, "HARNESS_INSPECTOR_PORT", chosen => serveInspector(inspection, chosen));
    // Lifecycle control stays on the owner's Unix socket; the LAN chat gets messages only.
    const handleChat = createChannelHandler(local, outputs);
    webChat = bindWebPort(config.webChatPort, "HARNESS_CHAT_PORT", chosen => serveWebChat(handleChat, chosen, undefined,
      { attachments: development.attachments, ensureChannel(id) { const result = session.channels.create({ channelId: id }); if (!result.ok) throw new Error(result.error.message); } }));
  } catch (error) {
    // Startup is all-or-nothing: do not leave an agent listening if the inspector
    // could not bind its port and the command reports a startup failure.
    for (const cleanup of [stopOutput, () => server?.stop(true), () => inspector?.stop(true), () => development.close()]) {
      try { await cleanup(); } catch { /* Preserve the original startup failure. */ }
    }
    throw error;
  }
  const status = session.status();
  console.log(`Agent listening at ${config.socketPath}. Session ID: ${status.sessionId}. Session storage: ${development.storage}.`);
  console.log(`Context inspector: ${inspector.url}`);
  for (const url of webChat.urls) console.log(`Web chat pairing link: ${url}`);
  // Opening never resumes. A suspended session stays paused, and inspectable, until asked.
  if (status.lifecycle === "suspended" && !options.resume) console.log("Session is suspended and paused. Run `bun run resume` to continue it.");
  else if (status.lifecycle === "suspended") {
    const resumed = session.resume();
    console.log(resumed.ok ? "Resumed the suspended session." : `Cannot resume (${resumed.error.code}): ${resumed.error.message}. The session stays suspended.`);
  } else {
    const interrupted = status.channels.filter(channel => channel.unresolvedInterruption);
    if (interrupted.length) console.log(`Turns left unfinished by a previous run are marked interrupted on: ${interrupted.map(channel => channel.channelId).join(", ")}. They are not retried.`);
    session.start();
  }
  console.log("Ctrl+C stops the agent: running turns are recorded as interrupted. Run `bun run suspend` first to pause cleanly.");
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    // Stop is immediate and is not suspension; a cleanly suspended session keeps its checkpoints.
    try {
      session.stop("Agent process stopped");
      stopOutput();
      await Promise.allSettled([server?.stop(true), inspector?.stop(true), webChat.server.stop(true)]);
    } finally {
      await development.close();
    }
  })();
  const onSignal = () => { void stop().catch(() => {
    console.error("Failed to close the development session.");
    process.exitCode = 1;
  }); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}
