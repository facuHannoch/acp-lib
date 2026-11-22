import { resolve } from "node:path";
import type { NativeFunctionsConfig } from "../../src/native/functions.ts";
import { createRehearsal } from "./rehearsal.ts";

const handlers: NativeFunctionsConfig = {
  defaultDeadlineMs: 5000,
  tools: {
    quiet: {
      description: "Record a simulated work step after a bounded wait.",
      parameters: { type: "object", properties: { delayMs: { type: "integer", minimum: 0, maximum: 2000 } },
        required: ["delayMs"], additionalProperties: false },
      async handler({ delayMs }, { signal }) {
        const ms = Number(delayMs);
        if (!Number.isInteger(ms) || ms < 0 || ms > 2000) throw new Error("Invalid test delay");
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
          const abort = () => { cleanup(); reject(signal.reason); };
          const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        return { recorded: true };
      },
    },
  },
};

export function createTimedRehearsal(fixture: string, deadlineMs: number) {
  return createRehearsal(resolve(fixture), {
    deadlineMs, cleanupMs: 2000, functions: handlers,
    policies: { rehearsal: { fallback: "deny", tools: { quiet: "allow", notify_channel: "allow" } } },
    exactConsumption: true,
  });
}

async function main() {
  const [fixture, timeout = "180000", ...extra] = process.argv.slice(2);
  if (!fixture || extra.length) throw new Error("Usage: bun run test/native/rehearsal-cli.ts <fixture.jsonl> [deadline-ms]");
  const run = await createTimedRehearsal(fixture, Number(timeout));
  try {
    const summary = await run.run();
    if (run.exits.length !== run.children.length || run.exits.some(code => code !== 0)) throw new Error("Harness did not exit cleanly");
    console.log(JSON.stringify({ ...summary, childExits: run.exits }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: String(error), childExits: run.exits }));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main().catch(error => { console.error(String(error)); process.exitCode = 1; });
