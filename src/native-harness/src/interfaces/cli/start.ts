import { createSharedContextStore } from "../../state/storage/shared-context.ts";
import { buildSharedContext } from "../../capabilities/context/build.ts";
import { mkdir } from "node:fs/promises";
import { createSession } from "../../index.ts";
import { openRouter } from "../../capabilities/model/openrouter.ts";
import { createDashboardWork } from "../../capabilities/tools/dashboard.ts";
import { createScenarioTools, scenarioDefinitions } from "../../capabilities/tools/scenario.ts";
import { agentConfiguration, systemPrompt } from "../../runtime/config/development.ts";
import { createInspection } from "../inspector/state.ts";
import { observeAgent, observeContext, observeModel, observeTurn } from "../inspector/observe.ts";
import { serveInspector } from "../inspector/server.ts";
import { createChannelHandler, serveLocal } from "../protocol/local.ts";
import { createChannelOutputs, publishChannelEvent } from "../protocol/output.ts";
import { serveWebChat } from "../web-chat/server.ts";

export async function start() {
  const config = agentConfiguration();
  if (config.managedDirectory) await mkdir(config.managedDirectory, { recursive: true, mode: 0o700 });
  const inspection = createInspection(systemPrompt, scenarioDefinitions);
  const store = createSharedContextStore();
  const stopObserving = observeContext(store, inspection,
    (entries) => buildSharedContext(entries, systemPrompt));
  const dashboard = createDashboardWork();
  const outputs = createChannelOutputs();
  const session = createSession({
    systemPrompt, store,
    wrapTurn: run => observeTurn(run, inspection),
    configureTurn(input, notify) {
      const scenario = createScenarioTools(input, dashboard, notify);
      const model = observeModel(inspection, input.channelId,
        onRequest => {
          const provider = openRouter(config.apiKey, config.model, onRequest);
          return (messages, tools) => { scenario.beginInference(); return provider(messages, tools); };
        }, input.turnId);
      return { model, tools: scenarioDefinitions, executeTool: scenario.execute };
    },
  });
  const stopOutput = session.subscribe(event => publishChannelEvent(outputs, event));
  const agent = observeAgent(session.agent, inspection);

  // Restrict the socket itself as well as the default parent directory.
  process.umask(0o077);
  const server = serveLocal(agent, config.socketPath, outputs);
  let inspector: ReturnType<typeof serveInspector> | undefined;
  let webChat: ReturnType<typeof serveWebChat>;
  try {
    const port = config.inspectorPort;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid HARNESS_INSPECTOR_PORT");
    if (!Number.isInteger(config.webChatPort) || config.webChatPort < 0 || config.webChatPort > 65535) throw new Error("Invalid HARNESS_CHAT_PORT");
    inspector = serveInspector(inspection, port);
    webChat = serveWebChat(createChannelHandler(agent, outputs), config.webChatPort);
  } catch (error) {
    // Startup is all-or-nothing: do not leave an agent listening if the inspector
    // could not bind its port and the command reports a startup failure.
    await server.stop(true);
    await inspector?.stop(true);
    throw error;
  }
  console.log(`Agent listening at ${config.socketPath}. Ctrl+C stops it and clears all history.`);
  console.log(`Context inspector: ${inspector.url}`);
  for (const url of webChat.urls) console.log(`Web chat pairing link: ${url}`);
  const stop = () => { stopObserving(); stopOutput(); server.stop(true); inspector?.stop(true); webChat.server.stop(true); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
