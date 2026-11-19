import { chat } from "./chat.ts";
import { start } from "./start.ts";
import { serve } from "./serve.ts";

async function main() {
  const [command, channelId, participantId, home, ...rest] = process.argv.slice(2);
  if (command === "start") return start();
  if (command === "serve" && channelId === "--stdio" && (!participantId || (participantId === "--home" && home && !rest.length))) {
    try { await serve(home); }
    catch (error) { console.error(String(error)); process.exit(1); }
    return;
  }
  if (command === "chat" && channelId && participantId) return chat(channelId, participantId);
  throw new Error("Usage: start | chat <channelId> <participantId> | serve --stdio [--home <directory>]");
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
