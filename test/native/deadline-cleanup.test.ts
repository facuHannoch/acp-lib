import { expect, test } from "bun:test";

const fixture = new URL("./fixtures/deadline-cleanup.ts", import.meta.url).pathname;

for (const target of ["ledger", "recovery"] as const) {
  test(`native ${target} clears deadline timers on success, empty return, and failure`, async () => {
    const child = Bun.spawn([process.execPath, fixture, target], { stdout: "pipe", stderr: "inherit" });
    const stdout = child.stdout.getReader();
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        stdout.read(),
        new Promise<never>((_, reject) => {
          guard = setTimeout(() => reject(new Error(`${target} fixture did not finish its reads`)), 5_000);
        }),
      ]);
      clearTimeout(guard);
      expect(new TextDecoder().decode(ready.value).trim()).toBe("finished");
      const code = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          guard = setTimeout(() => reject(new Error(`${target} kept the child alive after its reads settled`)), 2_000);
        }),
      ]);
      expect(code).toBe(0);
    } finally {
      clearTimeout(guard);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
      stdout.releaseLock();
    }
  }, 10_000);
}
