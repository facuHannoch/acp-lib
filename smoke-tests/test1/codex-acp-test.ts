#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTERS,
  AgentSession,
  createConsoleLogger,
  readTranscript,
} from "../../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const chatsDir = join(here, "chats");
const transcriptPath = join(chatsDir, `codex-acp-${Date.now()}.jsonl`);
const model = process.env.CODEX_ACP_MODEL ?? "gpt-5.4";

await mkdir(chatsDir, { recursive: true });

const prompt = process.argv.slice(2).join(" ").trim() || "Reply with exactly: transcript ok";

const session = await AgentSession.create({
  adapter: {
    ...ADAPTERS.codex,
    command: ["codex-acp", "-c", `model="${model}"`],
  },
  adapterId: "codex",
  cwd: process.cwd(),
  transcriptPath,
  defaultPermission: "cancel",
  logger: createConsoleLogger({ minLevel: "info" }),
});

let exitCode = 0;
try {
  const result = await session.prompt(prompt, {
    onChunk: (text) => process.stdout.write(text),
    onActivity: (event) => {
      if (event.kind === "tool") {
        process.stderr.write(`[tool:${event.title ?? event.toolKind}] `);
      }
    },
    onPermissionRequest: () => ({ outcome: "cancelled" }),
  });

  if (!result.text.endsWith("\n")) process.stdout.write("\n");
  process.stderr.write(`model=${model}\n`);
  process.stderr.write(`status=${result.status} stopReason=${result.stopReason}\n`);
  process.stderr.write(`transcriptPath=${transcriptPath}\n`);
  process.stderr.write(
    `messages=${JSON.stringify(await readTranscript(transcriptPath), null, 2)}\n`,
  );
} catch (err) {
  exitCode = 1;
  process.stderr.write(`error=${String(err)}\n`);
  process.stderr.write(`transcriptPath=${transcriptPath}\n`);
  process.stderr.write(
    `messages=${JSON.stringify(await readTranscript(transcriptPath), null, 2)}\n`,
  );
} finally {
  await session.stop();
}

process.exit(exitCode);
