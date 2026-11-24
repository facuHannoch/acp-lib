import { HarnessClient, createStdioTransport } from "../native-harness/src/client.ts";
import { prepareNativeLaunch, onceDispose } from "../launcher.ts";
import type { Logger } from "../logger.ts";
import { HarnessUnavailableError } from "./errors.ts";
import type { NativeConnection, NativeHarnessHostConfig } from "./host.ts";

const HARNESS_MAIN = new URL("../native-harness/src/interfaces/cli/main.ts", import.meta.url).pathname;

export interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => undefined); // observed by whoever awaits it; never an unhandled rejection
  return { promise, resolve, reject };
}

export async function launchNativeConnection(config: NativeHarnessHostConfig, log: Logger): Promise<NativeConnection> {
  const command = config.command ?? [process.execPath, HARNESS_MAIN, "serve", "--stdio", "--home", config.home];
  const launch = await prepareNativeLaunch(config.launcher, { command, env: config.env, cwd: config.cwd });
  const dispose = onceDispose(launch.dispose);
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    child = Bun.spawn(launch.command, { cwd: launch.spawnCwd, env: launch.spawnEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    await dispose();
    throw new HarnessUnavailableError(`the native harness could not be started: ${String(error)}`, { cause: error, code: "start_failed" });
  }
  void (async () => {
    // Diagnostics only: the protocol is on stdout.
    const text = await new Response(child.stderr).text().catch(() => "");
    if (text.trim()) log.warn("native_harness_stderr", { text: text.slice(-4000) });
  })();
  const transport = createStdioTransport({
    readable: child.stdout,
    exited: child.exited,
    async write(bytes) { child.stdin.write(bytes); await child.stdin.flush(); },
    async end() { await child.stdin.end(); },
  });
  const closed = deferred<void>();
  transport.onClose(() => closed.resolve());
  void child.exited.then(() => { closed.resolve(); void dispose(); });
  const client = new HarnessClient(transport, config.requestTimeoutMs ?? 30_000);
  return {
    client,
    closed: closed.promise,
    async kill() {
      client.close(); // closes the harness's input: it stops, recording running turns interrupted
      const forced = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await child.exited; } finally { clearTimeout(forced); }
    },
  };
}
