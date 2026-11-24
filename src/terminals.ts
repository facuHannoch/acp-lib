/// <reference types="bun" />
// Client-side terminals (ACP `terminal/*`). The agent asks US to run a command and then
// polls for output; the tool call it emits carries only a `terminalId`, so without this
// the whole execute-tool path produces empty UI.
//
// We advertise `terminal` in client capabilities, so per spec we MUST implement all five
// methods. See https://agentclientprotocol.com/protocol/terminals.

import type { Logger } from "./logger.ts";
import { noopLogger } from "./logger.ts";
import type { TerminalExitStatus } from "./types.ts";

export interface CreateTerminalParams {
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Array<{ name: string; value: string }>;
  /** Exact environment for this terminal, supplied by the host. */
  terminalEnv?: Record<string, string>;
  /** Bytes of output to retain; older output is dropped from the FRONT. */
  outputByteLimit?: number | null;
}

export interface TerminalOutput {
  output: string;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
}

export interface TerminalRegistryOptions {
  /** Fallback cwd when the agent doesn't specify one. */
  cwd?: string;
  /** Base environment when no exact terminalEnv is supplied. Defaults to empty. */
  env?: Record<string, string>;
  /** Exact environment for every terminal unless overridden at creation. */
  terminalEnv?: Record<string, string>;
  logger?: Logger;
}

/** Thrown when the agent references a terminal that was released or never existed. */
export class UnknownTerminalError extends Error {
  constructor(terminalId: string) {
    super(`unknown terminalId: ${terminalId}`);
    this.name = "UnknownTerminalError";
  }
}

interface Chunk {
  text: string;
  bytes: number;
}

interface Entry {
  id: string;
  proc: ReturnType<typeof Bun.spawn>;
  chunks: Chunk[];
  /** Memoized `chunks.join("")`; nulled on every write. */
  joined: string | null;
  totalBytes: number;
  limit: number | null;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
  exited: Promise<TerminalExitStatus>;
  // Structural: Bun's and node:stream/web's reader types differ, and we only cancel.
  readers: Array<{ cancel(): Promise<unknown> }>;
}

/**
 * How long to keep draining output after the process exits. A killed shell can leave a
 * grandchild holding the pipe, so EOF may never come — waiting on it unboundedly would
 * hang `terminal/wait_for_exit` and with it the agent's whole turn.
 */
const DRAIN_GRACE_MS = 250;

/**
 * The shell used when the agent hands us a command LINE.
 *
 * NOT `$SHELL`: that is the user's INTERACTIVE shell, which may be fish or nushell, and
 * agents generate bash/POSIX syntax — `printf x >&2` is a syntax error in fish. Prefer
 * bash, because agents write bashisms (`[[ ]]`, arrays) and `/bin/sh` is dash on Debian
 * and Ubuntu, where those fail. Fall back to `/bin/sh`, which always exists.
 */
const SHELL = process.env.ACP_TERMINAL_SHELL || Bun.which("bash") || "/bin/sh";

/**
 * Turn a `terminal/create` request into an argv.
 *
 * The spec is ambiguous — "The command to execute" plus an optional "Array of command
 * arguments" — and agents read it both ways. `claude-code-acp` puts its ENTIRE Bash command
 * line in `command` and sends no `args` at all, so spawning `command` as an executable path
 * failed every shell tool call it made: `Executable not found in $PATH: "printf 'ran' >
 * shell.txt"`. Redirections, pipes and `&&` were unreachable, and so was a plain command
 * that merely carried its own arguments.
 *
 * So: with `args`, the agent has already done the splitting and its arguments are final —
 * spawn directly, because re-splitting would turn one argument containing a space into two.
 * Without them, `command` is a line for a shell. The two readings never overlap, and for a
 * bare program name they agree (`sh -c "ls"` and spawning `ls` do the same thing).
 *
 * The cost: a command line is subject to word splitting, so an agent sending an unquoted
 * executable path containing spaces and no `args` would break. That shape is much rarer
 * than the one this fixes, and quoting it here would corrupt every genuine command line.
 */
function toArgv(params: CreateTerminalParams): string[] {
  return params.args?.length ? [params.command, ...params.args] : [SHELL, "-c", params.command];
}

export class TerminalRegistry {
  private readonly terminals = new Map<string, Entry>();
  private seq = 0;
  private readonly log: Logger;

  constructor(private readonly options: TerminalRegistryOptions = {}) {
    this.log = options.logger ?? noopLogger;
  }

  /** Spawn a command and return its terminal id. Output accumulates until released. */
  create(params: CreateTerminalParams): string {
    const id = `term-${++this.seq}`;
    const exact = params.terminalEnv ?? this.options.terminalEnv;
    const env = exact === undefined
      ? { ...this.options.env, ...Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value])) }
      : { ...exact };

    const proc = Bun.spawn(toArgv(params), {
      cwd: params.cwd ?? this.options.cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const entry: Entry = {
      id,
      proc,
      chunks: [],
      joined: null,
      totalBytes: 0,
      limit: params.outputByteLimit ?? null,
      truncated: false,
      exitStatus: null,
      exited: Promise.resolve({ exitCode: null, signal: null }),
      readers: [],
    };

    // stdout and stderr are interleaved in arrival order — that's what a terminal is.
    const pumps = [
      this.pump(entry, proc.stdout as ReadableStream<Uint8Array>),
      this.pump(entry, proc.stderr as ReadableStream<Uint8Array>),
    ];

    entry.exited = (async () => {
      const code = await proc.exited;
      // Drain whatever was still buffered before reporting the exit status, so a caller
      // that waits for exit and then reads output never races the last few bytes.
      await Promise.race([Promise.allSettled(pumps), Bun.sleep(DRAIN_GRACE_MS)]);
      const status: TerminalExitStatus = {
        exitCode: proc.signalCode ? null : (code ?? null),
        signal: proc.signalCode ?? null,
      };
      entry.exitStatus = status;
      this.log.debug("terminal_exit", { terminalId: id, ...status });
      return status;
    })();
    void entry.exited.catch(() => {});

    this.terminals.set(id, entry);
    this.log.debug("terminal_create", { terminalId: id, command: params.command, args: params.args });
    return id;
  }

  /**
   * Current output and exit status. Fully synchronous — it reads a buffer the background
   * pumps fill, and never waits on the process. That matters beyond convenience: this is
   * called while dispatching session updates, so an await here would let one wedged
   * command stall every subsequent update on the connection.
   */
  output(terminalId: string): TerminalOutput {
    const entry = this.require(terminalId);
    // Joining is O(buffered bytes) and a live terminal is read once per update that
    // references it, so hold the result until the next write.
    entry.joined ??= entry.chunks.map((c) => c.text).join("");
    return {
      output: entry.joined,
      truncated: entry.truncated,
      exitStatus: entry.exitStatus,
    };
  }

  /** Resolve once the command exits. */
  waitForExit(terminalId: string): Promise<TerminalExitStatus> {
    return this.require(terminalId).exited;
  }

  /** Kill the command but keep the id valid, so output stays readable. */
  kill(terminalId: string): void {
    const entry = this.require(terminalId);
    try {
      entry.proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }

  /** Kill and forget. The id becomes invalid for every other method. */
  release(terminalId: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) return;
    this.terminals.delete(terminalId);
    try {
      entry.proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    // Cancel explicitly: a surviving grandchild can hold the pipes open indefinitely.
    for (const reader of entry.readers) void reader.cancel().catch(() => {});
    entry.readers = [];
    this.log.debug("terminal_release", { terminalId });
  }

  /** Tear everything down (client stop). */
  releaseAll(): void {
    for (const id of [...this.terminals.keys()]) this.release(id);
  }

  /** True while the id is still ours to read — used to enrich tool-call content. */
  has(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  private require(terminalId: string): Entry {
    const entry = this.terminals.get(terminalId);
    if (!entry) throw new UnknownTerminalError(terminalId);
    return entry;
  }

  private async pump(entry: Entry, stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    entry.readers.push(reader);
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.append(entry, dec.decode(value, { stream: true }));
      }
      const tail = dec.decode();
      if (tail) this.append(entry, tail);
    } catch (err) {
      this.log.debug("terminal_read_failed", { terminalId: entry.id, error: String(err) });
    }
  }

  private append(entry: Entry, text: string): void {
    if (!text) return;
    entry.joined = null;
    entry.chunks.push({ text, bytes: Buffer.byteLength(text, "utf8") });
    entry.totalBytes += Buffer.byteLength(text, "utf8");
    this.trim(entry);
  }

  /**
   * Enforce outputByteLimit by dropping from the FRONT, whole chunks first, then a
   * character-boundary cut inside the oldest surviving chunk (per spec: truncation must
   * not split a character, even if that leaves us slightly under the limit).
   */
  private trim(entry: Entry): void {
    const limit = entry.limit;
    if (limit == null || limit < 0) return;
    while (entry.totalBytes > limit && entry.chunks.length > 0) {
      const first = entry.chunks[0]!;
      if (entry.totalBytes - first.bytes >= limit) {
        entry.chunks.shift();
        entry.totalBytes -= first.bytes;
        entry.truncated = true;
        continue;
      }
      const drop = entry.totalBytes - limit;
      const cut = charBoundaryCut(first.text, drop);
      const kept = first.text.slice(cut);
      const keptBytes = Buffer.byteLength(kept, "utf8");
      entry.totalBytes -= first.bytes - keptBytes;
      entry.truncated = true;
      if (kept) {
        entry.chunks[0] = { text: kept, bytes: keptBytes };
      } else {
        entry.chunks.shift();
      }
      break;
    }
  }
}

/**
 * Smallest index such that dropping `text[0..index)` sheds at least `dropBytes` bytes,
 * landing on a code-point boundary.
 */
function charBoundaryCut(text: string, dropBytes: number): number {
  let shed = 0;
  let i = 0;
  while (i < text.length && shed < dropBytes) {
    const code = text.codePointAt(i)!;
    const width = code > 0xffff ? 2 : 1;
    shed += Buffer.byteLength(text.slice(i, i + width), "utf8");
    i += width;
  }
  return i;
}
