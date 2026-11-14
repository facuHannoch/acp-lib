import { chat } from "./chat.ts";
import { start } from "./start.ts";

async function main() {
  const [command, channelId, participantId] = process.argv.slice(2);
  if (command === "start") return start();
  if (command === "chat" && channelId && participantId) return chat(channelId, participantId);
  throw new Error("Usage: start | chat <channelId> <participantId>");
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
