// Logger — an injected diagnostics sink. The library NEVER calls console.* directly;
// it logs through whatever the caller provides (or stays silent). This keeps the core
// quiet by default, which matters when it's embedded — e.g. recursed into an
// agent-as-tool. See SPEC.md "Core principles" (clean & embeddable).
//
// Structured by design: an `event` name + a `meta` bag, so callers can route to pino,
// JSON logs, etc. instead of parsing prose.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, meta?: Record<string, unknown>): void;
  info(event: string, meta?: Record<string, unknown>): void;
  warn(event: string, meta?: Record<string, unknown>): void;
  error(event: string, meta?: Record<string, unknown>): void;
}

/** Default sink — the library is silent unless given a real logger. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m", // grey
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

export interface ConsoleLoggerOptions {
  /** Minimum level to emit. Default "info". */
  minLevel?: LogLevel;
  /** Colorize output. Default: true when stderr is a TTY. */
  color?: boolean;
}

/**
 * A convenience console logger that writes diagnostics to STDERR (so stdout stays
 * reserved for real data, e.g. response text). Opt-in — the library never installs it.
 */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const min = LEVEL_ORDER[options.minLevel ?? "info"];
  const color = options.color ?? Boolean((process.stderr as any)?.isTTY);

  const emit = (level: LogLevel) => (event: string, meta?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < min) return;
    const tag = color ? `${COLOR[level]}${level}${RESET}` : level;
    const rest = meta && Object.keys(meta).length ? ` ${fmtMeta(meta)}` : "";
    process.stderr.write(`${tag} ${event}${rest}\n`);
  };

  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

function fmtMeta(meta: Record<string, unknown>): string {
  return Object.entries(meta)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}
