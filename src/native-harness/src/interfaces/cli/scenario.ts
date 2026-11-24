import { loadScenario } from "../../capabilities/model/scenario-file.ts";
import { scenarioAttempt } from "../../capabilities/model/scenario-attempt.ts";
import { bindModelAttempt } from "../../capabilities/model/attempt.ts";
import type { ModelRequest } from "../../contracts/model-execution.ts";
import { echoDefinition, executeEcho } from "../../capabilities/tools/testing/echo.ts";
import { createSession } from "../../index.ts";

async function main() {
  const args = process.argv.slice(2);
  const timelineTools = args[0] === "--timeline-tools";
  const [path, ...prompt] = timelineTools ? args.slice(1) : args;
  if (!path) throw new Error('Usage: bun run test:scenario [--timeline-tools] <script.jsonl> [prompt]');
  const scenario = await loadScenario(path);
  const requests: ModelRequest[] = [];
  let position = 0;
  const model = bindModelAttempt(async () => { throw new Error("Scripted model requires a reserved attempt"); }, {
    scripted: true, create: step => scenarioAttempt(scenario, "test", step!, request => {
      position = step! + 1;
      if (process.env.HARNESS_CAPTURE_SCRIPT_REQUESTS === "1") requests.push(structuredClone(request));
    }),
  });
  const session = createSession({ timelineTools, systemPrompt: "You are a test assistant.", configureTurn: () => ({
    model, tools: [echoDefinition], executeTool: executeEcho,
  }) });
  let answer = "";
  const ended = new Promise<void>((resolve, reject) => session.subscribe(({ event }) => {
    if (event.type === "message_completed") answer = (event.parts ?? []).map(part => part.text).join("");
    if (event.type === "turn_ended") event.outcome === "completed" ? resolve() : reject(new Error(event.error ?? event.outcome));
  }));
  session.start();
  const accepted = session.agent.send({ channelId: "test", participantId: "tester", text: prompt.join(" ") || "Echo hello" });
  if (!accepted.accepted) throw new Error(accepted.error);
  await ended;
  console.log(JSON.stringify({ answer, remainingResponses: Math.max(0, (scenario.channelModels.get("test") ?? scenario.defaultModels).length - position), requests, entries: session.store.snapshot() }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
