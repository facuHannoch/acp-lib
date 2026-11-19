import { loadScriptedModel } from "../../capabilities/model/scripted.ts";
import { echoDefinition, executeEcho } from "../../capabilities/tools/echo.ts";
import { createSession } from "../../index.ts";

async function main() {
  const [path, ...prompt] = process.argv.slice(2);
  if (!path) throw new Error('Usage: bun run test:scenario <script.json> [prompt]');
  const scripted = await loadScriptedModel(path);
  const session = createSession({ systemPrompt: "You are a test assistant.", configureTurn: () => ({
    model: scripted.model, tools: [echoDefinition], executeTool: executeEcho,
  }) });
  let answer = "";
  const ended = new Promise<void>((resolve, reject) => session.subscribe(({ event }) => {
    if (event.type === "message_completed") answer = event.parts.map(part => part.text).join("");
    if (event.type === "turn_ended") event.outcome === "completed" ? resolve() : reject(new Error(event.error ?? event.outcome));
  }));
  session.start();
  const accepted = session.agent.send({ channelId: "test", participantId: "tester", text: prompt.join(" ") || "Echo hello" });
  if (!accepted.accepted) throw new Error(accepted.error);
  await ended;
  console.log(JSON.stringify({ answer, remainingResponses: scripted.remaining(), requests: scripted.requests(), entries: session.store.snapshot() }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
