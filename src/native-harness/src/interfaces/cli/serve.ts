import { createScriptedServer } from "../../testing.ts";
import { serveProtocolStdio } from "../protocol/stdio-server.ts";

/** `home` selects durable SQLite sessions; without it sessions are in memory.
 * HARNESS_TEST_FAULT and HARNESS_TEST_EFFECTS drive offline crash scenarios. */
export async function serve(home?: string) {
  const { server } = createScriptedServer({ home, fault: process.env.HARNESS_TEST_FAULT, effects: process.env.HARNESS_TEST_EFFECTS });
  const output = Bun.stdout.writer();
  await serveProtocolStdio(server, Bun.stdin.stream(), async bytes => {
    output.write(bytes);
    await output.flush();
  });
  server.dispose();
  await output.end();
}
