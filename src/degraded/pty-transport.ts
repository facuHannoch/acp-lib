/// <reference types="bun" />
// The ONLY module in degraded mode that spawns a process. node-pty is unusable under
// Bun (the child is SIGHUP'd instantly; the read path never fires), so instead the OS
// `script` utility owns the pty and we drive plain Bun.spawn pipes — the exact same
// pipe mechanism AcpTransport uses for stdio. See .res/test.md "degraded mode PTY".
//
// Layout intentionally mirrors transport/acp-transport.ts: one class, start/stop, a
// write path, and event callbacks. Everything above stays pty-plumbing-agnostic.

import { ProcessCrashError } from "../errors.ts";

export interface PtyTransportOptions {
  /** The interactive command to run inside the pty, e.g. ["codex"] (already exec-prefixed). */
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;

  /** A chunk of raw terminal bytes (decoded to string, ANSI still embedded) arrived. */
  onData?: (data: string) => void;
  /** The pty process exited. */
  onExit?: (code: number | null) => void;
}

/** Quote one argv token for the single shell string `script -c` expects. */
function shellQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

export class PtyTransport {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly enc = new TextEncoder();
  private stopping = false;

  constructor(private opts: PtyTransportOptions) {}

  async start(): Promise<void> {
    if (this.proc) return;

    // `script -qfec "<cmd>" /dev/null`: -q quiet, -f flush on write, -e return child's
    // exit code, -c run this command. /dev/null discards the typescript log; the child's
    // pty output still streams to script's stdout, which we pipe.
    const inner = this.opts.command.map(shellQuote).join(" ");
    const argv = ["script", "-qfec", inner, "/dev/null"];

    const stdinTransform = new TransformStream<Uint8Array, Uint8Array>();
    const proc = Bun.spawn(argv, {
      cwd: this.opts.cwd,
      env: {
        ...process.env,
        ...(this.opts.env ?? {}),
        TERM: this.opts.env?.TERM ?? "xterm-color",
        // Best-effort: hint a fixed window so CLIs don't probe ioctls we can't answer.
        COLUMNS: String(this.opts.cols ?? 80),
        LINES: String(this.opts.rows ?? 24),
      },
      stdin: stdinTransform.readable,
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    this.writer = stdinTransform.writable.getWriter();

    this.pump(proc.stdout as ReadableStream<Uint8Array>);

    proc.exited
      .then((code) => {
        if (this.proc === proc && !this.stopping) {
          this.proc = null;
          this.writer = null;
          this.opts.onExit?.(code ?? null);
        }
      })
      .catch(() => {});
  }

  /** Write raw bytes to the pty (keystrokes, prompt text, control chars). */
  write(data: string): void {
    if (!this.writer) throw new ProcessCrashError(null, "pty transport not started");
    void this.writer.write(this.enc.encode(data));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    this.proc = null;
    this.writer = null;
    if (!proc) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already exited */
    }
  }

  get running(): boolean {
    return this.proc !== null;
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = dec.decode(value, { stream: true });
      if (text) this.opts.onData?.(text);
    }
  }
}
