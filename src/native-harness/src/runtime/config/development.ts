import { tmpdir } from "node:os";
import { join } from "node:path";

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
