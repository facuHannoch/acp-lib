import { mkdir } from "node:fs/promises";
import { createAgent } from "../../kernel/agent.ts";
import { runTurn } from "../../kernel/loop.ts";
import { openRouter } from "../../capabilities/model/openrouter.ts";
import { currentTimeDefinition, executeCurrentTime } from "../../capabilities/tools/current-time.ts";
import { agentConfiguration, systemPrompt } from "../../runtime/config/development.ts";
import { createInspection } from "../inspector/state.ts";
import { observeAgent, observeModel, observeTool, observeTurn } from "../inspector/observe.ts";
import { serveInspector } from "../inspector/server.ts";
import { serveLocal } from "../protocol/local.ts";

export async function start() {
  const config = agentConfiguration();
  if (config.managedDirectory) await mkdir(config.managedDirectory, { recursive: true, mode: 0o700 });
  const inspection = createInspection(systemPrompt);
  const turn = observeTurn((messages, input) => {
    const model = observeModel(inspection, input.channelId, messages,
      (onRequest) => openRouter(config.apiKey, config.model, onRequest));
    const tool = observeTool(inspection, input.channelId, messages, executeCurrentTime);
    // Sender labels are conversation content; the consumer system prompt stays
    // verbatim. The participant ID is supplied by this local client, not verified.
    return runTurn(messages,
      `Participant: ${JSON.stringify(input.participantId)}\n\n${input.text}`,
      model, [currentTimeDefinition], tool);
  }, inspection);
  const agent = observeAgent(createAgent(systemPrompt, turn), inspection);

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
  const stop = () => { server.stop(true); inspector.stop(true); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
