import { createSharedContextStore } from "../../state/storage/shared-context.ts";
import { buildContext, buildSharedContext } from "../../capabilities/context/build.ts";
import { mkdir } from "node:fs/promises";
import { createChannelScheduler } from "../../kernel/channels.ts";
import { runTurn } from "../../kernel/loop.ts";
import { openRouter } from "../../capabilities/model/openrouter.ts";
import { currentTimeDefinition, executeCurrentTime } from "../../capabilities/tools/current-time.ts";
import { agentConfiguration, systemPrompt } from "../../runtime/config/development.ts";
import { createInspection } from "../inspector/state.ts";
import { observeAgent, observeContext, observeModel, observeTurn } from "../inspector/observe.ts";
import { serveInspector } from "../inspector/server.ts";
import { serveLocal } from "../protocol/local.ts";

export async function start() {
  const config = agentConfiguration();
  if (config.managedDirectory) await mkdir(config.managedDirectory, { recursive: true, mode: 0o700 });
  const inspection = createInspection(systemPrompt, [currentTimeDefinition]);
  const store = createSharedContextStore();
  const stopObserving = observeContext(store, inspection,
    (entries) => buildSharedContext(entries, systemPrompt));
  const turn = observeTurn((input) => {
    const model = observeModel(inspection, input.channelId,
      (onRequest) => openRouter(config.apiKey, config.model, onRequest), input.turnId);
    return runTurn({
      append(message) {
        store.append({ channelId: input.channelId, turnId: input.turnId,
          from: message.role === "tool" ? "tool" : "agent", message });
      },
      // Read immediately before each inference, including calls after tool use.
      build: () => buildContext(store.snapshot(), systemPrompt, input),
    }, model, [currentTimeDefinition], executeCurrentTime);
  }, inspection);
  const agent = observeAgent(createChannelScheduler(store, turn), inspection);

  // Restrict the socket itself as well as the default parent directory.
  process.umask(0o077);
  const server = serveLocal(agent, config.socketPath);
  let inspector: ReturnType<typeof serveInspector>;
  try {
    const port = config.inspectorPort;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid HARNESS_INSPECTOR_PORT");
    inspector = serveInspector(inspection, port);
  } catch (error) {
    // Startup is all-or-nothing: do not leave an agent listening if the inspector
    // could not bind its port and the command reports a startup failure.
    await server.stop(true);
    throw error;
  }
  console.log(`Agent listening at ${config.socketPath}. Ctrl+C stops it and clears all history.`);
  console.log(`Context inspector: ${inspector.url}`);
  const stop = () => { stopObserving(); server.stop(true); inspector.stop(true); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
