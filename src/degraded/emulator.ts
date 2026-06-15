// EmulatorScreen — stage 1 of the degraded pipeline: raw pty bytes → a virtual screen
// grid (what a human would actually SEE), via @xterm/headless. Stripping ANSI is not
// enough for redraw-in-place TUIs (codex/kimi): they reposition the cursor and repaint,
// so the bytes overlap into garbage. Feeding them through a real vt emulator and reading
// the resulting cell grid is the only way to recover legible text. See SPEC.md
// "Emulate, don't strip".
//
// @xterm/headless is a dev/runtime dep of the degraded subpath ONLY — the core never
// imports it. It works under Bun (verified rendering a real codex turn).

import { Terminal } from "@xterm/headless";

export interface EmulatorOptions {
  cols?: number;
  rows?: number;
  /** Lines of scrollback to retain (long replies scroll out of the viewport). */
  scrollback?: number;
}

export class EmulatorScreen {
  private term: Terminal;
  // xterm's write() is async (drains on a callback); chain writes so a snapshot can wait
  // for everything fed so far to be applied to the grid.
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: EmulatorOptions = {}) {
    this.term = new Terminal({
      cols: opts.cols ?? 100,
      rows: opts.rows ?? 30,
      scrollback: opts.scrollback ?? 1000,
      allowProposedApi: true,
    });
  }

  /** Feed a chunk of raw terminal bytes. */
  write(data: Uint8Array | string): void {
    this.chain = this.chain.then(
      () => new Promise<void>((resolve) => this.term.write(data, () => resolve())),
    );
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /**
   * The full screen as text — viewport + scrollback, one line per row, right-trimmed.
   * Waits for all pending writes to drain so the grid reflects everything fed so far.
   */
  async snapshot(): Promise<string[]> {
    await this.chain;
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines;
  }

  dispose(): void {
    this.term.dispose();
  }
}

/** Collapse runs of blank lines and trim — a readable rendering of a grid snapshot. */
export function compactLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line === "" && out[out.length - 1] === "") continue;
    out.push(line);
  }
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}
