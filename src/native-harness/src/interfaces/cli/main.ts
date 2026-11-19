import { chat } from "./chat.ts";
import { start } from "./start.ts";
import { serve } from "./serve.ts";
import { controlLocal } from "../protocol/local.ts";
import { localConnection } from "../../runtime/config/development.ts";

const USAGE = "Usage: start [--db <path> [--create]] [--resume] [--script <path>] | chat <channelId> <participantId> | suspend | resume | status | serve --stdio [--home <directory>]";

function startOptions(args: string[]) {
  const options: { database?: string; create?: boolean; resume?: boolean; script?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[i + 1];
    if (flag === "--create") options.create = true;
    else if (flag === "--resume") options.resume = true;
    else if ((flag === "--db" || flag === "--script") && value && !value.startsWith("--")) { options[flag === "--db" ? "database" : "script"] = value; i++; }
    else throw new Error(USAGE);
  }
  if (options.create && !options.database) throw new Error("--create needs --db <path>");
  return options;
}

async function main() {
  const [command, channelId, participantId, home, ...rest] = process.argv.slice(2);
  if (command === "start") return start(startOptions(process.argv.slice(3)));
  if ((command === "suspend" || command === "resume" || command === "status") && !channelId) {
    console.log(JSON.stringify(await controlLocal(localConnection().socketPath, command), null, 2));
    return;
  }
  if (command === "serve" && channelId === "--stdio" && (!participantId || (participantId === "--home" && home && !rest.length))) {
    try { await serve(home); }
    catch (error) { console.error(String(error)); process.exit(1); }
    return;
  }
  if (command === "chat" && channelId && participantId) return chat(channelId, participantId);
  throw new Error(USAGE);
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
