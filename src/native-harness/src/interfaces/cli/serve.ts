import { createScriptedServer } from "../../testing.ts";
import { serveProtocolStdio } from "../protocol/stdio-server.ts";

export async function serve() {
  const { server } = createScriptedServer();
  const output = Bun.stdout.writer();
  await serveProtocolStdio(server, Bun.stdin.stream(), async bytes => {
    output.write(bytes);
    await output.flush();
  });
  await output.end();
}
