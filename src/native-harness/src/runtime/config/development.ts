import { tmpdir } from "node:os";
import { join } from "node:path";

// Defaults belong to this development host, not to the reusable agent kernel.
export const systemPrompt2 = `You help a startup prepare its dashboard and launch.
Dashboard implementation uses dashboard_work(). Each call completes one of five steps.
Continue calling it until the dashboard is finished, unless new information changes what you should do.
Call dashboard_work at most once per inference. Consider updates from other participants before continuing work.
Report completed progress accurately. All channels refer to the same dashboard job.
You can use notify_channel to bring important updates to another channel's attention.
Notices are addressed to the agent on that channel, not directly to its human participant.
They wake idle channels or reach busy channels before their next inference.
When new information invalidates work happening elsewhere, notify the relevant channel.
Avoid repeating updates already communicated.`;

export const systemPrompt = `You are working on startop, and is left to work on the dashboard and the launch. Dashboard implementation uses dashboard_work(). Each call completes one of five steps. Working on the dashboard takes time, and we have little time so don't start right away.
There are different users, which hold different responsabilities.
You talk in one channel at a time, but multiple users / agents will be able to talk to you. If there is information that may be relevant to other users or to the work you are doing with other users, then you can use notify_channel.
`;

export function localConnection() {
  const directory = join(tmpdir(), `native-harness-${process.getuid?.() ?? "local"}`);
  return {
    socketPath: process.env.HARNESS_SOCKET ?? join(directory, "agent.sock"),
    // Custom paths are caller-managed; only the default directory is created.
    managedDirectory: process.env.HARNESS_SOCKET ? undefined : directory,
  };
}

export function agentConfiguration() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Set OPENROUTER_API_KEY before starting the agent.");
  return {
    apiKey,
    model: process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4.1-flash",
    inspectorPort: Number(process.env.HARNESS_INSPECTOR_PORT ?? 3000),
    webChatPort: Number(process.env.HARNESS_CHAT_PORT ?? 3001),
    ...localConnection(),
  };
}
