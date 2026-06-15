// Interactive REPL — pure presentation/UI over the AgentClient output contract.
// Depends ONLY on AgentClient (prompt + interrupt), so it works against AcpClient today
// and PtyClient (degraded mode) later, unchanged. The caller owns the client lifecycle
// (connect/stop); the REPL just drives the interaction.

import * as readline from "node:readline/promises";
import type { AgentClient } from "../index.ts";
import { BOLD, CYAN, DIM, RESET } from "./colors.ts";

export interface ReplOptions {
  /** Show activity (thinking/tool) markers on stderr. */
  verbose?: boolean;
  /** Optional line printed (stderr) before the loop starts. */
  intro?: string;
}

export async function runRepl(
  client: AgentClient,
  options: ReplOptions = {},
): Promise<void> {
  if (options.intro) process.stderr.write(options.intro + "\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const PROMPT = `${BOLD}${CYAN}you ›${RESET} `;
  let busy = false;

  // Ctrl-C interrupts an in-flight turn; when idle it ends the session.
  const onSigint = () => {
    if (busy) {
      client.interrupt();
      process.stderr.write(`${DIM} ^C interrupted${RESET}\n`);
    } else {
      rl.close();
    }
  };
  process.on("SIGINT", onSigint);

  // Async-iterator loop: yields every line and applies backpressure while a turn runs,
  // so piped input (non-TTY) isn't dropped between turns.
  rl.setPrompt(PROMPT);
  rl.prompt();
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        rl.prompt();
        continue;
      }
      if (line === "/exit" || line === "/quit") break;

      busy = true;
      process.stdout.write(`${BOLD}agent ›${RESET} `);
      const result = await client.prompt(line, {
        onChunk: (t) => process.stdout.write(t),
        onActivity: options.verbose
          ? (e) => process.stderr.write(`${DIM}[${e.kind}]${RESET}`)
          : undefined,
      });
      busy = false;

      if (!result.text.endsWith("\n")) process.stdout.write("\n");
      if (result.status !== "completed") {
        process.stderr.write(`${DIM}(${result.status}: ${result.stopReason})${RESET}\n`);
      }
      rl.prompt();
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
  }
}
