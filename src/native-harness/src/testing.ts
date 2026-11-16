import { createSession } from "./index.ts";
import { createScriptedModel } from "./capabilities/model/scripted.ts";
import { echoDefinition, executeEcho } from "./capabilities/tools/echo.ts";
import { createProtocolServer } from "./interfaces/protocol/server.ts";
import { HarnessClient, createInProcessTransport } from "./client.ts";

/** Real in-memory execution, scripted per channel, exposed through the client. */
export function createInProcessHarness() {
  const models = new Map<string, ReturnType<typeof createScriptedModel>>();
  const server = createProtocolServer(async config => {
    const script: unknown = await Bun.file(config.model.script).json();
    createScriptedModel(script); // Validate before session creation is acknowledged.
    return createSession({ systemPrompt: config.system, configureTurn(input) {
      let scripted = models.get(input.channelId);
      if (!scripted) { scripted = createScriptedModel(script); models.set(input.channelId, scripted); }
      return { model: scripted.model, tools: [echoDefinition], executeTool: executeEcho };
    } });
  });
  const client = new HarnessClient(createInProcessTransport(server));
  return { client, models, server, close: () => client.close() };
}
