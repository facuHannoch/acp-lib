// A ready-made sink for the raw protocol traffic (`WireEntry`), for when an agent does
// something inexplicable and the structured logs aren't enough.
//
// The library never turns this on by itself: a wire log contains everything the agent said,
// including file contents and command output, so it is the caller's decision where that
// goes and for how long.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WireEntry } from "./types.ts";

export interface WireLogOptions {
  /**
   * Append ndjson here — one `WireEntry` per line, so `jq` works on it directly. Created
   * (with parent directories) and TRUNCATED on the first write, so a run's log is that
   * run's, not an accumulation of every run.
   */
  path?: string;
  /**
   * Also print a one-line-per-message summary. `true` and `"stderr"` mean stderr, which is
   * the right default — stdout usually carries the agent's streamed reply.
   */
  console?: boolean | "stderr" | "stdout";
  /**
   * Truncate a line longer than this before printing/writing (a file read or a terminal
   * dump can be megabytes). Default 4000 for the console, unlimited for the file.
   */
  maxLineBytes?: number;
}

const ARROW: Record<WireEntry["dir"], string> = { out: "→", in: "←", err: "!" };

// Hoisted: `clip` runs on every line of the protocol stream.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Build a `WireEntry` sink for `wire` on `AgentSession`/`AgentController`/`AcpClient`.
 *
 * Writes are chained rather than awaited by the caller: the tap sits in the middle of the
 * protocol stream, so blocking it on disk would stall the conversation. Ordering is
 * preserved because each append waits for the previous one.
 */
export function createWireLog(options: WireLogOptions = {}): (entry: WireEntry) => void {
  const target = options.console === "stdout" ? "stdout" : "stderr";
  const toConsole = options.console !== undefined && options.console !== false;
  const consoleMax = options.maxLineBytes ?? 4000;
  const fileMax = options.maxLineBytes;

  let chain: Promise<void> = Promise.resolve();
  let started = false;

  return (entry) => {
    if (toConsole) {
      const text = `${ARROW[entry.dir]} ${clip(entry.line, consoleMax)}\n`;
      if (target === "stdout") process.stdout.write(text);
      else process.stderr.write(text);
    }

    const path = options.path;
    if (!path) return;
    const line = `${JSON.stringify(
      fileMax == null ? entry : { ...entry, line: clip(entry.line, fileMax) },
    )}\n`;
    chain = chain
      .catch(() => {})
      .then(async () => {
        if (!started) {
          started = true;
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, "");
        }
        await appendFile(path, line, "utf8");
      });
  };
}

/** Clip on a code-point boundary and say how much was dropped. */
function clip(line: string, maxBytes: number): string {
  const bytes = encoder.encode(line);
  if (bytes.length <= maxBytes) return line;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return `${decoder.decode(bytes.subarray(0, end))}… [+${bytes.length - end}B]`;
}
