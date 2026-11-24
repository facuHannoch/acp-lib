import { join } from "node:path";
import { Agent } from "../../../src/agent.ts";
import type { AgentSessionId } from "../../../src/agent-ids.ts";
import { spawnHarness } from "../../../src/native-harness/test/helpers/stdio.ts";

const [, , directory, id, rawTime] = process.argv;
const home = join(directory!, "harness-home");
const child = spawnHarness({ home, reminderTime: Number(rawTime), fault: "fireDueReminders:1" });
const agent = await Agent.open({
  id: id as AgentSessionId,
  persistence: { kind: "sqlite", path: join(directory!, "agent.sqlite") },
  adapters: { main: { kind: "native" } },
  harness: {
    home,
    config: {
      version: 1, system: "Native integration test",
      model: { protocol: "scripted", script: join(directory!, "script.jsonl") },
      defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } },
    },
    ...{ connect: async () => ({
      client: child.client, closed: child.child.exited.then(() => undefined),
      async kill() { await child.close().catch(() => {}); },
    }) },
  },
});
try {
  await agent.nativeHarness!.start();
  throw new Error("Expected the harness fault to kill the child");
} catch (error) {
  const code = (error as { code?: string }).code;
  const harnessExit = await child.child.exited;
  if (code !== "transport_closed" || harnessExit !== 137) throw error;
  console.log(JSON.stringify({ code, harnessExit }));
}
await new Promise<void>(() => { setInterval(() => {}, 60_000); });
