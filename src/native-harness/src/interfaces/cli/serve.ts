import { createScriptedServer } from "../../testing.ts";
import { serveProtocolStdio } from "../protocol/stdio-server.ts";
import { homedir } from "node:os";
import { join } from "node:path";

/** `home` selects durable SQLite sessions; the default is ~/.harness.
 * HARNESS_TEST_FAULT, HARNESS_TEST_EFFECTS and HARNESS_TEST_REQUESTS support offline tests. */
export async function serve(home?: string) {
  const { server } = createScriptedServer({ home: home ?? join(homedir(), ".harness"), fault: process.env.HARNESS_TEST_FAULT, effects: process.env.HARNESS_TEST_EFFECTS,
    requests: process.env.HARNESS_TEST_REQUESTS });
  const output = Bun.stdout.writer();
  await serveProtocolStdio(server, Bun.stdin.stream(), async bytes => {
    output.write(bytes);
    await output.flush();
  });
  server.dispose();
  await output.end();
}
