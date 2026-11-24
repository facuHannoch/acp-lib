export interface McpStdioLaunch {
  command: string;
  args: readonly string[];
  cwd?: string;
  env: Readonly<Record<string, string>>;
}

// Stderr is drained without retaining remote output or mixing it with JSON-RPC.
export function spawnMcpStdio(config: McpStdioLaunch) {
  const child = Bun.spawn([config.command, ...config.args], {
    cwd: config.cwd, env: { ...config.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const drain = child.stderr.pipeTo(new WritableStream()).catch(() => {});
  let closed: Promise<void> | undefined;
  return {
    stdout: child.stdout,
    async write(frame: Uint8Array) {
      child.stdin.write(frame);
      await child.stdin.flush();
    },
    close() {
      return closed ??= (async () => {
        child.kill("SIGKILL");
        await child.exited;
        await drain;
      })();
    },
  };
}
