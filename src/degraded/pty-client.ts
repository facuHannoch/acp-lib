// PtyClient — degraded-mode AgentClient. Drives an agent's INTERACTIVE CLI inside a pty
// (via PtyTransport) and scrapes the screen back into the same prompt()/onChunk contract
// AcpClient exposes, so the REPL and controller work against it unchanged.
//
// It has almost no INPUT surface: no capabilities, no sessions, no permission gating —
// those genuinely don't exist when you're screen-scraping. See SPEC.md "Degraded mode".
//
// Pipeline (SPEC.md "The parsing pipeline"):
//   raw pty bytes → EmulatorScreen (vt grid) → settle on idle → extractReply → PromptResult
// `extractReply` is the deterministic default; an injected `parser` (ScreenParser/SML)
// can replace it for messier TUIs without touching the transport/turn machinery.

import type { AgentClient, Bridgeable, BridgeOptions, InterruptOptions } from "../agent-client.ts";
import type { Adapter } from "../adapters.ts";
import { buildPtyCommand } from "../adapters.ts";
import type { ScreenParser } from "../parser/types.ts";
import type { PromptResult, PromptHandlers, Attachment } from "../types.ts";
import { noopLogger, type Logger } from "../logger.ts";
import { NotConnectedError } from "../errors.ts";
import { PtyTransport } from "./pty-transport.ts";
import { EmulatorScreen, compactLines } from "./emulator.ts";
import { extractReply } from "./extract.ts";

const ETX = "\x03"; // Ctrl-C
const ESC = "\x1b";

export interface PtyClientOptions {
  adapter: Adapter;
  execPrefix?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Optional smart parser (SML/heuristic). Absent → deterministic extractReply. */
  parser?: ScreenParser;
  /** ms of screen stability that counts as "settled" / turn complete. Default 800. */
  settleMs?: number;
  /**
   * ms to wait after typing the prompt before sending Enter. TUIs (e.g. codex) treat a
   * single `text+Enter` write as a paste and DON'T submit — Enter must be a separate
   * keypress after the text registers. Default 150.
   */
  submitDelayMs?: number;
  cols?: number;
  rows?: number;
  logger?: Logger;
}

interface Turn {
  sent: string;
  preLines: string[];
  handlers?: PromptHandlers;
  cancelled: boolean;
  resolve: (r: PromptResult) => void;
  settle: ReturnType<typeof setTimeout> | null;
}

export class PtyClient implements AgentClient, Bridgeable {
  private transport: PtyTransport | null = null;
  private screen: EmulatorScreen | null = null;
  private turn: Turn | null = null;
  // Raw pty-output subscribers (used by bridge() to mirror the pty to the user's screen).
  private rawListeners = new Set<(data: string) => void>();
  private readonly settleMs: number;
  private readonly submitDelayMs: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly log: Logger;

  constructor(private opts: PtyClientOptions) {
    this.settleMs = opts.settleMs ?? 800;
    this.submitDelayMs = opts.submitDelayMs ?? 150;
    this.cols = opts.cols ?? 100;
    this.rows = opts.rows ?? 30;
    this.log = opts.logger ?? noopLogger;
  }

  get isConnected(): boolean {
    return this.transport !== null;
  }

  /** Spawn the interactive CLI and wait for its banner/prompt to settle. */
  async start(): Promise<void> {
    if (this.transport) return;
    const command = buildPtyCommand(this.opts.adapter, this.opts.execPrefix);
    this.log.info("pty_connect", { command });

    this.screen = new EmulatorScreen({ cols: this.cols, rows: this.rows });
    const transport = new PtyTransport({
      command,
      cwd: this.opts.cwd,
      env: this.opts.env,
      cols: this.cols,
      rows: this.rows,
      onData: (data) => this.onData(data),
      onExit: (code) => {
        this.transport = null;
        this.log.warn("pty_exit", { code });
        void this.finishTurn("end_turn");
      },
    });
    await transport.start();
    this.transport = transport;

    // Drain the startup banner so the first prompt's response isn't polluted by it.
    await this.waitIdle();
    this.log.debug("pty_ready", {});
  }

  prompt(
    text: string,
    handlers?: PromptHandlers,
    _attachments?: Attachment[],
  ): Promise<PromptResult> {
    if (!this.transport || !this.screen) throw new NotConnectedError("PtyClient is not started");
    if (this.turn) throw new Error("PtyClient is busy with another turn");

    return new Promise<PromptResult>((resolve) => {
      void (async () => {
        const preLines = compactLines(await this.screen!.snapshot());
        this.turn = { sent: text, preLines, handlers, cancelled: false, resolve, settle: null };
        this.log.debug("pty_prompt", { chars: text.length });
        // Type the text, then send Enter as a SEPARATE keypress after a short delay —
        // a single text+Enter write looks like a paste to TUIs and won't submit.
        this.transport!.write(text);
        this.armSettle();
        setTimeout(() => {
          if (this.turn) {
            this.transport?.write("\r");
            this.armSettle();
          }
        }, this.submitDelayMs);
      })();
    });
  }

  interrupt(_options?: InterruptOptions): void {
    if (!this.turn) return;
    this.turn.cancelled = true;
    // ESC first (most TUIs treat it as cancel), then Ctrl-C as a fallback.
    this.transport?.write(ESC);
    this.transport?.write(ETX);
    this.log.debug("pty_interrupt", {});
  }

  async stop(): Promise<void> {
    const t = this.transport;
    this.transport = null;
    await this.finishTurn("cancelled");
    if (t) await t.stop();
    this.screen?.dispose();
    this.screen = null;
    this.log.info("pty_stopped", {});
  }

  // --- PTY-only surface (not on AgentClient) ------------------------------------

  /** The current emulated screen as text (what a human would see). */
  async readScreen(): Promise<string> {
    if (!this.screen) return "";
    return compactLines(await this.screen.snapshot()).join("\n");
  }

  /** Escape hatch: send raw keys (ESC, arrows, slash commands) into the pty. */
  sendKeys(raw: string): void {
    this.transport?.write(raw);
  }

  /** Resize the pty window — TUIs redraw to fit, which reduces scrape garbage. */
  resize(cols: number, rows: number): void {
    this.transport?.resize(cols, rows);
    this.screen?.resize(cols, rows);
  }

  // --- internals ----------------------------------------------------------------

  private onData(data: string): void {
    this.screen?.write(data);
    for (const listener of this.rawListeners) listener(data);
    if (this.turn) this.armSettle();
  }

  /**
   * Hand the pty directly to the user: mirror its output to `output` and forward
   * keystrokes from `input` until the exit byte (default Ctrl-], 0x1d). For tty-auth
   * (login) and as an escape hatch when scraping can't read a TUI (e.g. codex modals).
   */
  async bridge(options: BridgeOptions = {}): Promise<void> {
    if (!this.transport) throw new NotConnectedError("PtyClient is not started");
    if (this.turn) throw new Error("cannot bridge while a turn is in flight");

    const input = (options.input ?? process.stdin) as NodeJS.ReadStream & {
      setRawMode?: (raw: boolean) => void;
      isRaw?: boolean;
    };
    const output = options.output ?? process.stdout;
    const exitBytes = new Set(options.exitBytes ?? [0x1d, 0x03]); // Ctrl-], Ctrl-C
    const status = options.onStatus ?? ((m: string) => void process.stderr.write(m));
    const label = this.opts.adapter.displayName ?? "agent";

    // Size the pty to the user's REAL terminal so the TUI renders aligned (a fixed
    // 100×30 pty mis-wraps in a different terminal), then the SIGWINCH triggers a clean
    // full repaint. We do NOT dump the emulated screen — for full TUIs that overlaps the
    // live repaint and garbles it (Claude Code).
    const term = output as unknown as {
      columns?: number;
      rows?: number;
      on?: (ev: string, cb: () => void) => void;
      off?: (ev: string, cb: () => void) => void;
    };
    output.write("\x1b[2J\x1b[H"); // clear; the repaint below redraws the TUI fresh
    this.resize(term.columns ?? this.cols, term.rows ?? this.rows);
    status(`— bridge: driving ${label} directly · Ctrl-] or Ctrl-C to return —\r\n`);

    const mirror = (d: string) => void output.write(d);
    this.rawListeners.add(mirror);
    // Keep the TUI fitting if the user resizes the terminal while bridged.
    const onResize = () => this.resize(term.columns ?? this.cols, term.rows ?? this.rows);
    term.on?.("resize", onResize);

    const wasRaw = Boolean(input.isRaw);
    try {
      input.setRawMode?.(true);
    } catch {
      /* not a tty */
    }
    input.resume();

    await new Promise<void>((resolve) => {
      const onInput = (buf: Buffer) => {
        // Forward everything up to (but not including) the first exit byte, then stop.
        let i = 0;
        for (; i < buf.length; i++) if (exitBytes.has(buf[i]!)) break;
        if (i > 0) this.transport?.writeBytes(new Uint8Array(buf.subarray(0, i)));
        if (i < buf.length) {
          input.off("data", onInput);
          resolve();
          return;
        }
      };
      input.on("data", onInput);
    });

    term.off?.("resize", onResize);
    this.rawListeners.delete(mirror);
    try {
      if (!wasRaw) input.setRawMode?.(false);
    } catch {
      /* ignore */
    }
    input.pause();
    // Clear the agent's TUI so the REPL returns to a clean screen.
    output.write("\x1b[2J\x1b[H");
    status(`— bridge closed —\r\n`);
  }

  private armSettle(): void {
    const turn = this.turn;
    if (!turn) return;
    if (turn.settle) clearTimeout(turn.settle);
    turn.settle = setTimeout(() => void this.finishTurn("end_turn"), this.settleMs);
  }

  private async finishTurn(stopReason: string): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    if (turn.settle) clearTimeout(turn.settle);

    let text = "";
    if (this.screen) {
      const post = compactLines(await this.screen.snapshot());
      if (this.opts.parser) {
        const parsed = await this.opts.parser.parse(post.join("\n"), "result");
        text = parsed && "text" in parsed ? String(parsed.text ?? "") : "";
      } else {
        text = extractReply(post, turn.sent, turn.preLines);
      }
    }

    const status = turn.cancelled ? "cancelled" : "completed";
    if (text) turn.handlers?.onChunk?.(text);
    this.log[text.length === 0 && !turn.cancelled ? "warn" : "info"]("pty_turn_end", {
      status,
      chars: text.length,
    });
    turn.resolve({ text, stopReason, status, usage: null });
  }

  /** Resolve once the screen has been idle for settleMs (used to drain the banner). */
  private waitIdle(): Promise<void> {
    return new Promise((resolve) => {
      let lastLen = -1;
      const tick = async () => {
        const len = this.screen ? (await this.screen.snapshot()).join("").length : 0;
        if (len === lastLen) {
          resolve();
          return;
        }
        lastLen = len;
        setTimeout(tick, this.settleMs);
      };
      setTimeout(tick, this.settleMs);
    });
  }
}
