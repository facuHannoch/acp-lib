import { createScriptedServer } from "../../testing.ts";
import { serveProtocolStdio } from "../protocol/stdio-server.ts";
import { homedir } from "node:os";
import { join } from "node:path";

/** `home` selects durable SQLite sessions; the default is ~/.harness.
 * HARNESS_TEST_* settings support deterministic offline process tests. */
export async function serve(home?: string) {
  const { server } = createScriptedServer({ home: home ?? join(homedir(), ".harness"), fault: process.env.HARNESS_TEST_FAULT, effects: process.env.HARNESS_TEST_EFFECTS,
    requests: process.env.HARNESS_TEST_REQUESTS, attempts: process.env.HARNESS_TEST_ATTEMPTS, snapshotLog: process.env.HARNESS_TEST_SNAPSHOT_LOG, stallChannel: process.env.HARNESS_TEST_STALL_CHANNEL, providerEndpoint: process.env.HARNESS_TEST_PROVIDER_ENDPOINT, webEndpoint: process.env.HARNESS_TEST_WEB_ENDPOINT,
    streamResponses: process.env.HARNESS_TEST_STREAM_RESPONSES === "1",
    reminderTime: process.env.HARNESS_TEST_REMINDER_TIME === undefined ? undefined : Number(process.env.HARNESS_TEST_REMINDER_TIME),
    modelTimeoutMs: process.env.HARNESS_TEST_MODEL_TIMEOUT_MS === undefined ? undefined : Number(process.env.HARNESS_TEST_MODEL_TIMEOUT_MS) });
  const output = Bun.stdout.writer();
  await serveProtocolStdio(server, Bun.stdin.stream(), async bytes => {
    output.write(bytes);
    await output.flush();
  });
  server.dispose();
  await output.end();
}
