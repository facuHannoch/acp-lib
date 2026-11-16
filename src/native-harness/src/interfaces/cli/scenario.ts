import { loadScriptedModel } from "../../capabilities/model/scripted.ts";
import { buildContext } from "../../capabilities/context/build.ts";
import { echoDefinition, executeEcho } from "../../capabilities/tools/echo.ts";
import { createSharedContextStore } from "../../state/storage/shared-context.ts";
import { createChannelScheduler } from "../../kernel/channels.ts";
import { runTurn } from "../../kernel/loop.ts";

async function main() {
  const [path, ...prompt] = process.argv.slice(2);
  if (!path) throw new Error('Usage: bun run test:scenario <script.json> [prompt]');
  const scripted = await loadScriptedModel(path);
  const store = createSharedContextStore();
  const agent = createChannelScheduler(store, (input, mailbox) => runTurn({
    drainNotices: mailbox.drain, finish: mailbox.finish,
    append(message) { store.append({ channelId: input.channelId, turnId: input.turnId, from: message.role === "tool" ? "tool" : "agent", message }); },
    build: () => buildContext(store.snapshot(), "You are a test assistant.", input),
  }, scripted.model, [echoDefinition], executeEcho));
  const answer = await agent.send({ channelId: "test", participantId: "tester", text: prompt.join(" ") || "Echo hello" });
  console.log(JSON.stringify({ answer, remainingResponses: scripted.remaining(), requests: scripted.requests(), entries: store.snapshot() }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
