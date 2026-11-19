import { mkdir } from "node:fs/promises";
import { agentConfiguration, localConnection, systemPrompt } from "../../runtime/config/development.ts";
import { serveInspector } from "../inspector/server.ts";
import { createChannelHandler, serveLocal } from "../protocol/local.ts";
import { createChannelOutputs, publishChannelEvent } from "../protocol/output.ts";
import { serveWebChat } from "../web-chat/server.ts";
import { openDevelopment } from "./development.ts";

export interface StartOptions { database?: string; create?: boolean; resume?: boolean; script?: string }

export async function start(options: StartOptions = {}) {
  // A scripted run is offline: it needs no provider key.
  const config = options.script ? { ...localConnection(), apiKey: "", model: "",
    inspectorPort: Number(process.env.HARNESS_INSPECTOR_PORT ?? 3000), webChatPort: Number(process.env.HARNESS_CHAT_PORT ?? 3001) } : agentConfiguration();
  if (config.managedDirectory) await mkdir(config.managedDirectory, { recursive: true, mode: 0o700 });
  const development = await openDevelopment({ systemPrompt, database: options.database, create: options.create, script: options.script,
    provider: options.script ? undefined : { apiKey: config.apiKey, model: config.model } });
  const { session, inspection, local } = development;
  const outputs = createChannelOutputs();
  const stopOutput = session.subscribe(event => publishChannelEvent(outputs, event));

  // Restrict the socket itself as well as the default parent directory.
  process.umask(0o077);
  const server = serveLocal(local, config.socketPath, outputs, session);
  let inspector: ReturnType<typeof serveInspector> | undefined;
  let webChat: ReturnType<typeof serveWebChat>;
  try {
    const port = config.inspectorPort;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid HARNESS_INSPECTOR_PORT");
    if (!Number.isInteger(config.webChatPort) || config.webChatPort < 0 || config.webChatPort > 65535) throw new Error("Invalid HARNESS_CHAT_PORT");
    inspector = serveInspector(inspection, port);
    // Lifecycle control stays on the owner's Unix socket; the LAN chat gets messages only.
    webChat = serveWebChat(createChannelHandler(local, outputs), config.webChatPort);
  } catch (error) {
    // Startup is all-or-nothing: do not leave an agent listening if the inspector
    // could not bind its port and the command reports a startup failure.
    await server.stop(true);
    await inspector?.stop(true);
    development.close();
    throw error;
  }
  const status = session.status();
  console.log(`Agent listening at ${config.socketPath}. Session storage: ${development.storage}.`);
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
  console.log(development.storage === "memory" ? "Ctrl+C stops the agent and loses all history."
    : "Ctrl+C stops the agent: running turns are recorded as interrupted. Run `bun run suspend` first to pause cleanly.");
  const stop = () => {
    // Stop is immediate and is not suspension; a cleanly suspended session keeps its checkpoints.
    session.stop("Agent process stopped");
    stopOutput(); server.stop(true); inspector?.stop(true); webChat.server.stop(true);
    development.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
