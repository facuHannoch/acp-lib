import { createScriptedServer } from "../../src/testing.ts";
import { exaServiceTransport } from "../../src/capabilities/tools/web/exa-transport.ts";
import { resolveServiceEgress } from "../../src/capabilities/tools/web/service-egress.ts";
import { serveProtocolStdio } from "../../src/interfaces/protocol/stdio-server.ts";

const origin = new URL(process.env.TEST_SERVICE_ORIGIN!);
if (origin.hostname !== "127.0.0.1" || origin.protocol !== "https:") throw Error("Expected loopback TLS fixture");
const { server } = createScriptedServer({
  home: process.argv[process.argv.indexOf("--home") + 1],
  webTransport: exaServiceTransport(resolveServiceEgress(process.env), origin.origin),
});
const output = Bun.stdout.writer();
await serveProtocolStdio(server, Bun.stdin.stream(), async bytes => { output.write(bytes); await output.flush(); });
await server.dispose();
await output.end();
