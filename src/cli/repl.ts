// Interactive REPL — pure presentation/UI over the AgentClient output contract.
// Depends ONLY on AgentClient (prompt + interrupt), so it works against AcpClient today
// and PtyClient (degraded mode) later, unchanged. The caller owns the client lifecycle
// (connect/stop); the REPL just drives the interaction.
//
// Keys:  ESC interrupts the in-flight turn · Ctrl-C interrupts a turn, or (when idle)
//        exits after a confirmation press.
//
// I/O convention: agent RESPONSE TEXT → stdout; chrome (prompts, labels, markers,
// spinner, status) → stderr. So `repl ... > transcript` captures just the conversation,
// and color is only emitted to a TTY (respecting NO_COLOR).
//
// Two input paths:
//   - interactive (TTY): a FRESH readline per line. readline is never alive while a turn
//     streams, so its cursor model can't desync and erase our output (it does:
//     _refreshLine → clearScreenDown with a stale row count). During a turn we read raw
//     stdin ourselves for ESC/Ctrl-C.
//   - piped (non-TTY): one flowing readline + queue. No erase risk (no cursor escapes),
//     and a fresh-per-line interface there would drop buffered lines.

import * as readline from "node:readline";
import type { AgentClient, ActivityEvent } from "../index.ts";
import { BOLD, CYAN, DIM, colorEnabled, paint } from "./colors.ts";

const ESC = 0x1b;
const ETX = 0x03; // Ctrl-C
const EXIT_CONFIRM_MS = 3000;

export interface ReplOptions {
  /** Show activity (thinking/tool) markers on stderr. Default true. */
  activity?: boolean;
  /** Show the "working…" spinner while waiting. Default true. */
  spinner?: boolean;
  /** Optional line printed (stderr) before the loop starts. Styled by the REPL. */
  intro?: string;
  /**
   * Handle a `/slash` command. Return true if handled (the loop continues without
   * prompting the agent); return false to treat the line as a normal prompt.
   * `/exit` and `/quit` are always handled by the REPL itself.
   *
   * Extension seam for consumers (e.g. the orchestration hub's direct mode): add
   * `/new`, `/model`, `/switch`, etc. without forking the REPL.
   */
  onSlashCommand?: (command: string, args: string[]) => boolean | Promise<boolean>;
}

export async function runRepl(
  client: AgentClient,
  options: ReplOptions = {},
): Promise<void> {
  const color = colorEnabled(process.stderr);
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const err = (s: string) => process.stderr.write(s);
  // Response text: stdout when piped (clean transcript), but the SAME stream as chrome
  // (stderr) when interactive — mixing stdout+stderr on one TTY reorders under Bun's
  // independent buffering and scrambles the cursor (erasing output). Interactive callers
  // who redirect stdout fall to the piped path (isTTY false), so this never hides output.
  const out = (s: string) => (interactive ? process.stderr : process.stdout).write(s);
  const prompt = paint(color, `${BOLD}${CYAN}`, "you ›") + " ";

  if (options.intro) err(paint(color, DIM, options.intro) + "\n");

  let busy = false;

  // ---- handle one accepted line; returns true to keep looping, false to exit ----
  const handleLine = async (line: string): Promise<boolean> => {
    if (line === "/exit" || line === "/quit") return false;
    if (line.startsWith("/") && options.onSlashCommand) {
      const [command = "", ...rest] = line.slice(1).split(/\s+/);
      try {
        if (await options.onSlashCommand(command, rest)) return true;
      } catch (e) {
        // A failing command (e.g. /load on a session with no rollout) must not crash the REPL.
        err(paint(color, DIM, `(/${command} failed: ${String(e)})`) + "\n");
        return true;
      }
      // not handled → fall through and send it as a normal prompt
    }
    await runTurn(line);
    return true;
  };

  try {
    if (interactive) await runInteractive(prompt, handleLine);
    else await runPiped(prompt, handleLine);
  } finally {
    if (interactive && process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* not a settable tty */
      }
    }
    err("\n"); // leave the shell on a clean line (avoids zsh's reverse %/# marker)
  }

  // ---- interactive: fresh readline per line + raw input during the turn ----------
  async function runInteractive(
    promptStr: string,
    onLine: (line: string) => Promise<boolean>,
  ): Promise<void> {
    let exitArmed = false;
    let exitTimer: ReturnType<typeof setTimeout> | null = null;
    const disarm = () => {
      exitArmed = false;
      if (exitTimer) {
        clearTimeout(exitTimer);
        exitTimer = null;
      }
    };

    for (;;) {
      const ev = await readOneLine(promptStr);
      if (ev.type === "eof") break;
      if (ev.type === "sigint") {
        if (exitArmed) break; // confirmed → exit
        exitArmed = true;
        err(paint(color, DIM, "(press Ctrl-C again to exit, or type /exit)") + "\n");
        exitTimer = setTimeout(() => (exitArmed = false), EXIT_CONFIRM_MS);
        continue;
      }
      disarm();
      const line = ev.value.trim();
      if (!line) continue;
      if (!(await onLine(line))) break;
    }
  }

  // ---- piped: one flowing readline + queue (no TTY, no spinner, no raw) -----------
  async function runPiped(
    promptStr: string,
    onLine: (line: string) => Promise<boolean>,
  ): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.setPrompt(promptStr);
    const lines: string[] = [];
    let waiter: (() => void) | null = null;
    let closed = false;
    const wake = () => {
      waiter?.();
      waiter = null;
    };
    rl.on("line", (l) => {
      lines.push(l);
      wake();
    });
    rl.on("close", () => {
      closed = true;
      wake();
    });

    rl.prompt();
    try {
      for (;;) {
        while (lines.length === 0 && !closed) await new Promise<void>((r) => (waiter = r));
        if (lines.length === 0 && closed) break;
        const line = lines.shift()!.trim();
        if (!line) {
          rl.prompt();
          continue;
        }
        if (!(await onLine(line))) break;
        rl.prompt();
      }
    } finally {
      rl.close();
    }
  }

  // ---- one turn ------------------------------------------------------------------
  async function runTurn(text: string): Promise<void> {
    let wroteLabel = false;
    let lastMarker = "";
    let sawActivity = false;
    const spinner =
      interactive && options.spinner !== false ? startSpinner(color) : null;

    // Take over raw stdin for ESC/Ctrl-C while the turn streams (interactive only).
    let onData: ((d: Buffer) => void) | null = null;
    if (interactive) {
      try {
        process.stdin.setRawMode(true);
      } catch {
        /* ignore */
      }
      onData = (d: Buffer) => {
        for (const b of d) if (b === ESC || b === ETX) client.interrupt();
      };
      process.stdin.on("data", onData);
      process.stdin.resume();
    }

    const onChunk = (t: string) => {
      if (!wroteLabel) {
        spinner?.stop();
        if (sawActivity) err("\n");
        err(paint(color, BOLD, "agent ›") + " ");
        wroteLabel = true;
      }
      out(t); // response text (no color)
    };

    const onActivity =
      options.activity !== false
        ? (e: ActivityEvent) => {
            const marker = activityMarker(e);
            if (!marker || marker === lastMarker) return; // collapse consecutive repeats
            lastMarker = marker;
            if (!sawActivity) spinner?.stop(); // first activity replaces the spinner
            sawActivity = true;
            err(paint(color, DIM, `[${marker}]`) + " ");
          }
        : undefined;

    busy = true;
    try {
      const result = await client.prompt(text, { onChunk, onActivity });
      spinner?.stop();

      if (wroteLabel) {
        if (!result.text.endsWith("\n")) out("\n");
      } else {
        if (sawActivity) err("\n");
        if (result.status === "completed") {
          err(paint(color, DIM, "(no response — if this persists, the agent may need auth: try /login)") + "\n");
        }
      }
      if (result.status !== "completed") {
        err(paint(color, DIM, `(${result.status}: ${result.stopReason})`) + "\n");
      }
    } catch (e) {
      spinner?.stop();
      if (wroteLabel) out("\n");
      err(paint(color, DIM, `(error: ${String(e)})`) + "\n");
    } finally {
      busy = false;
      if (onData) {
        process.stdin.removeListener("data", onData);
        try {
          process.stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// One line via a throwaway readline interface (interactive path).
type LineEvent = { type: "line"; value: string } | { type: "sigint" } | { type: "eof" };
function readOneLine(promptStr: string): Promise<LineEvent> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let done = false;
    const finish = (ev: LineEvent) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(ev);
    };
    rl.on("line", (l) => finish({ type: "line", value: l }));
    rl.on("SIGINT", () => finish({ type: "sigint" }));
    rl.on("close", () => finish({ type: "eof" }));
    rl.setPrompt(promptStr);
    rl.prompt();
  });
}

interface Spinner {
  stop(): void;
}

function startSpinner(color: boolean): Spinner {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let stopped = false;
  const render = () =>
    process.stderr.write(
      "\r" + paint(color, DIM, `${frames[i++ % frames.length]} working… (ESC to interrupt)`),
    );
  render();
  const id = setInterval(render, 90);
  return {
    stop() {
      // Idempotent: a second stop() must NOT re-emit the clear, or it would erase the
      // response that was already written on this line after the first stop().
      if (stopped) return;
      stopped = true;
      clearInterval(id);
      process.stderr.write("\r\x1b[K"); // carriage return + clear spinner line
    },
  };
}

function activityMarker(e: ActivityEvent): string | null {
  switch (e.kind) {
    case "thinking":
      return "thinking";
    case "tool":
      return `tool:${e.title ?? e.toolKind}`;
    case "plan":
      return "plan";
    default:
      return null; // tool_update is too noisy to surface
  }
}
