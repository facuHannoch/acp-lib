// Minimal ANSI helpers shared across CLI files. Not part of the library surface.
export const DIM = "\x1b[90m";
export const BOLD = "\x1b[1m";
export const CYAN = "\x1b[36m";
export const RESET = "\x1b[0m";

/** Whether to emit color for a stream: a TTY and NO_COLOR not set (https://no-color.org). */
export function colorEnabled(stream: { isTTY?: boolean }): boolean {
  return Boolean(stream.isTTY) && process.env.NO_COLOR === undefined;
}

/** Wrap text in an ANSI code when enabled; otherwise return it untouched. */
export function paint(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${RESET}` : text;
}
