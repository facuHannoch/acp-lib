// PtyClient — degraded-mode AgentClient. Drives an agent's INTERACTIVE CLI inside a pty
// (via PtyTransport) and scrapes the screen back into the same prompt()/onChunk contract
// AcpClient exposes, so the REPL and controller work against it unchanged.
//
// It has almost no INPUT surface: no capabilities, no sessions, no permission gating —
// those genuinely don't exist when you're screen-scraping. See SPEC.md "Degraded mode".
//
// Pipeline (naive default): raw pty bytes → strip ANSI → accumulate → settle on idle →
// emit response. A smart `parser` (ScreenParser/SML) can be injected to replace the
// naive extraction later; the transport/turn machinery stays the same.

import type { AgentClient, InterruptOptions } from "../agent-client.ts";
import type { Adapter } from "../adapters.ts";
import { buildPtyCommand } from "../adapters.ts";
import type { ScreenParser } from "../parser/types.ts";
import type { PromptResult, PromptHandlers, Attachment } from "../types.ts";
import { noopLogger, type Logger } from "../logger.ts";
import { NotConnectedError } from "../errors.ts";
import { PtyTransport } from "./pty-transport.ts";

const ETX = "\x03"; // Ctrl-C
const ESC = "\x1b";

export interface PtyClientOptions {
  adapter: Adapter;
  execPrefix?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Optional smart parser (SML/heuristic). Absent → naive strip-and-settle extraction. */
  parser?: ScreenParser;
  /** ms of screen stability that counts as "settled" / turn complete. Default 700. */
  settleMs?: number;
  cols?: number;
  rows?: number;
  logger?: Logger;
}

interface Turn {
  sent: string;
  raw: string;
  emitted: number; // chars of clean RESPONSE already pushed to onChunk
  pastEcho: boolean;
  handlers?: PromptHandlers;
  cancelled: boolean;
  resolve: (r: PromptResult) => void;
  settle: ReturnType<typeof setTimeout> | null;
}

export class PtyClient implements AgentClient {
  private transport: PtyTransport | null = null;
  private screen = ""; // rolling clean buffer (for readScreen)
  private turn: Turn | null = null;
  private readonly settleMs: number;
  private readonly log: Logger;

  constructor(private opts: PtyClientOptions) {
    this.settleMs = opts.settleMs ?? 700;
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

    const transport = new PtyTransport({
      command,
      cwd: this.opts.cwd,
      env: this.opts.env,
      cols: this.opts.cols,
      rows: this.opts.rows,
      onData: (data) => this.onData(data),
      onExit: (code) => {
        this.transport = null;
        this.log.warn("pty_exit", { code });
        // A turn in flight when the pty dies resolves with whatever we have.
        this.finishTurn("end_turn");
      },
    });
    await transport.start();
    this.transport = transport;

    // Drain the startup banner so the first prompt's response isn't polluted by it.
    await this.waitIdle();
    this.log.debug("pty_ready", { screenChars: this.screen.length });
  }

  prompt(
    text: string,
    handlers?: PromptHandlers,
    _attachments?: Attachment[],
  ): Promise<PromptResult> {
    if (!this.transport) throw new NotConnectedError("PtyClient is not started");
    if (this.turn) throw new Error("PtyClient is busy with another turn");

    return new Promise<PromptResult>((resolve) => {
      this.turn = {
        sent: text,
        raw: "",
        emitted: 0,
        pastEcho: false,
        handlers,
        cancelled: false,
        resolve,
        settle: null,
      };
      this.log.debug("pty_prompt", { chars: text.length });
      this.transport!.write(text + "\r");
      this.armSettle();
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
    this.finishTurn("cancelled");
    if (t) await t.stop();
    this.log.info("pty_stopped", {});
  }

  // --- PTY-only surface (not on AgentClient) ------------------------------------

  /** The current rolling clean screen text. */
  readScreen(): string {
    return this.screen;
  }

  /** Escape hatch: send raw keys (ESC, arrows, slash commands) into the pty. */
  sendKeys(raw: string): void {
    this.transport?.write(raw);
  }

  /** Resize the pty window — TUIs redraw to fit, which reduces scrape garbage. */
  resize(cols: number, rows: number): void {
    this.transport?.resize(cols, rows);
  }

  // --- internals ----------------------------------------------------------------

  private onData(data: string): void {
    const clean = stripAnsi(data);
    this.screen = (this.screen + clean).slice(-8192); // bounded rolling buffer

    const turn = this.turn;
    if (!turn) return;

    turn.raw += clean;
    if (!this.opts.parser) this.emitNaive(turn);
    this.armSettle();
  }

  /** Naive extraction: drop the echoed input line, stream everything after it. */
  private emitNaive(turn: Turn): void {
    const response = stripEcho(turn.raw, turn.sent);
    if (response == null) return; // echo not seen yet → still chrome
    turn.pastEcho = true;
    if (response.length > turn.emitted) {
      const delta = response.slice(turn.emitted);
      turn.emitted = response.length;
      turn.handlers?.onChunk?.(delta);
    }
  }

  private armSettle(): void {
    const turn = this.turn;
    if (!turn) return;
    if (turn.settle) clearTimeout(turn.settle);
    turn.settle = setTimeout(() => this.finishTurn("end_turn"), this.settleMs);
  }

  private finishTurn(stopReason: string): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    if (turn.settle) clearTimeout(turn.settle);

    let text = stripEcho(turn.raw, turn.sent) ?? "";
    text = trimPromptTail(text);
    const status = turn.cancelled ? "cancelled" : "completed";
    this.log[text.length === 0 && !turn.cancelled ? "warn" : "info"]("pty_turn_end", {
      status,
      chars: text.length,
    });
    turn.resolve({ text, stopReason, status, usage: null });
  }

  /** Resolve once the screen has been idle for settleMs (used to drain the banner). */
  private waitIdle(): Promise<void> {
    return new Promise((resolve) => {
      let lastLen = this.screen.length;
      let timer: ReturnType<typeof setTimeout>;
      const id = setInterval(() => {
        if (this.screen.length !== lastLen) lastLen = this.screen.length;
      }, 80);
      const arm = () => {
        timer = setTimeout(() => {
          if (this.screen.length === lastLen) {
            clearInterval(id);
            resolve();
          } else {
            arm();
          }
        }, this.settleMs);
      };
      arm();
    });
  }
}

// --- naive parsing helpers ------------------------------------------------------

/** Strip ANSI/VT escapes and normalize CR. Keeps \n and \t. Good enough for a first cut. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC ... BEL/ST
    .replace(/\x1b[\[\]][0-9;?]*[ -/]*[@-~]/g, "") // CSI / DCS-ish
    .replace(/\x1b[()][AB0-2]/g, "") // charset designations
    .replace(/\x1b[=>]/g, "") // keypad mode
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") // stray control chars
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
}

/**
 * Given clean turn text, return everything AFTER the echoed input line, or null if the
 * echo hasn't appeared yet. The pty echoes "<sent>\n" before the agent responds.
 */
export function stripEcho(clean: string, sent: string): string | null {
  const needle = sent.trim();
  if (!needle) return clean.replace(/^\n+/, "");
  const at = clean.indexOf(needle);
  if (at < 0) return null;
  const nl = clean.indexOf("\n", at + needle.length);
  if (nl < 0) return null; // echoed but no newline yet
  return clean.slice(nl + 1);
}

/** Best-effort: drop a trailing re-rendered prompt line (last line with no newline). */
export function trimPromptTail(text: string): string {
  const trimmed = text.replace(/\s+$/, "");
  const lastNl = trimmed.lastIndexOf("\n");
  const tail = trimmed.slice(lastNl + 1);
  // A short tail that looks like a shell/agent prompt (ends in $, #, >, ›) is chrome.
  if (tail.length <= 80 && /[$#>›»❯]\s*$/.test(tail)) {
    return lastNl < 0 ? "" : trimmed.slice(0, lastNl).replace(/\s+$/, "");
  }
  return trimmed;
}
