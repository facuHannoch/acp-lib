/// <reference types="bun" />
// The ONLY module in degraded mode that spawns a process. Uses Bun's NATIVE pseudo-
// terminal API (Bun.spawn({ terminal }), Bun ≥ 1.3.5) — no node-pty (broken under Bun)
// and no external `script` binary. The agent's interactive CLI runs in a real pty, and
// `terminal.write/resize` drive it. See .res/test.md "degraded mode PTY".
//
// Layout mirrors transport/acp-transport.ts: one class, start/stop, a write path, and
// event callbacks. Everything above stays pty-plumbing-agnostic.

import { ProcessCrashError } from "../errors.ts";
import { onceDispose, type PreparedLaunch } from "../launcher.ts";

export interface PtyTransportOptions {
  /** Exact host-side process launch, already resolved by the caller's launcher. */
  launch?: PreparedLaunch;
  /** @deprecated Pass launch. */
  command?: string[];
  /** @deprecated Pass launch.spawnCwd. */
  cwd?: string;
  /** @deprecated Pass launch.spawnEnv. Legacy values overlay process.env. */
  env?: Record<string, string>;
  cols?: number;
  rows?: number;

  /** A chunk of raw terminal bytes (decoded to string, ANSI still embedded) arrived. */
  onData?: (data: string) => void;
  /** The pty process exited. */
  onExit?: (code: number | null) => void;
}

/** Minimal shape of Bun's native terminal handle (not yet in @types/bun). */
interface BunTerminal {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
  unref(): void;
}

export class PtyTransport {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private terminal: BunTerminal | null = null;
  private stopping = false;
  private readonly disposeLaunch: () => Promise<void>;
  private readonly launch: PreparedLaunch;

  constructor(private opts: PtyTransportOptions) {
    if (opts.launch) {
      this.launch = opts.launch;
    } else {
      if (!opts.command?.length) throw new Error("PtyTransport requires launch or command");
      this.launch = {
        command: opts.command,
        spawnCwd: opts.cwd,
        spawnEnv: {
          ...(process.env as Record<string, string>),
          ...(opts.env ?? {}),
          TERM: opts.env?.TERM ?? "xterm-color",
        },
      };
    }
    this.disposeLaunch = onceDispose(this.launch.dispose);
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const dec = new TextDecoder();

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(this.launch.command, {
        cwd: this.launch.spawnCwd,
        env: this.launch.spawnEnv,
        terminal: {
          cols: this.opts.cols ?? 80,
          rows: this.opts.rows ?? 24,
          data: (_term: unknown, data: Uint8Array) => {
            const text = dec.decode(data, { stream: true });
            if (text) this.opts.onData?.(text);
          },
        },
      } as Parameters<typeof Bun.spawn>[1]);
    } catch (error) {
      await this.disposeLaunch().catch(() => {});
      throw error;
    }

    this.proc = proc;
    this.terminal = (proc as unknown as { terminal: BunTerminal }).terminal ?? null;

    proc.exited
      .then(async (code) => {
        if (this.proc === proc && !this.stopping) {
          this.proc = null;
          this.terminal = null;
          await this.disposeLaunch().catch(() => {});
          this.opts.onExit?.(code ?? null);
        }
      }, async () => {
        if (this.proc === proc && !this.stopping) {
          this.proc = null;
          this.terminal = null;
          await this.disposeLaunch().catch(() => {});
          this.opts.onExit?.(null);
        }
      })
      .catch(() => {});
  }

  /** Write to the pty (keystrokes, prompt text, control chars). */
  write(data: string): void {
    if (!this.terminal) throw new ProcessCrashError(null, "pty transport not started");
    this.terminal.write(data);
  }

  /** Write raw bytes verbatim — used by the bridge to forward keystrokes unmangled. */
  writeBytes(data: Uint8Array): void {
    if (!this.terminal) throw new ProcessCrashError(null, "pty transport not started");
    this.terminal.write(data);
  }

  /** Resize the pty window (TUIs redraw to fit; correct dims reduce scrape garbage). */
  resize(cols: number, rows: number): void {
    this.terminal?.resize(cols, rows);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    const terminal = this.terminal;
    this.proc = null;
    this.terminal = null;
    try {
      proc?.kill("SIGTERM");
    } catch {
      /* already exited */
    }
    // The native pty handle keeps Bun's event loop alive until closed — without this the
    // process hangs after the child is killed. close() also releases the pty master fd.
    try {
      terminal?.close();
    } catch {
      /* already closed */
    }
    // SIGKILL after a short grace in case the child ignores SIGTERM (TUIs in raw mode).
    if (proc) {
      const killed = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
      ]);
      if (!killed) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* gone */
        }
        await proc.exited.catch(() => {});
      }
    }
    await this.disposeLaunch();
  }

  get running(): boolean {
    return this.proc !== null;
  }
}
