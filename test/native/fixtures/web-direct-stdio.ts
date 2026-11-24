/** Test-only stdio assembly: the direct adapter still validates and pins the
 * supplied public peer, while a synthetic socket supplies deterministic bytes. */
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { createScriptedServer } from "../../../src/native-harness/src/testing.ts";
import { serveProtocolStdio } from "../../../src/native-harness/src/interfaces/protocol/stdio-server.ts";
import { fetchDirect } from "../../../src/native-harness/src/capabilities/tools/web/direct.ts";
import { DirectHttpError } from "../../../src/native-harness/src/capabilities/tools/web/direct-address.ts";
const homeIndex = process.argv.indexOf("--home");
if (homeIndex < 0 || !process.argv[homeIndex + 1]) throw Error("Fixture home is required");
const dependencies = {
  async resolve() { return ["8.8.8.8"]; },
  async connect(target: { address: string; port: number }) {
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) {
      const body = "Direct fixture text";
      this.push(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); this.push(null); done();
    } });
    Object.defineProperties(socket, { remoteAddress: { value: target.address }, remotePort: { value: target.port } });
    return socket as unknown as Socket;
  },
};
const { server } = createScriptedServer({ home: process.argv[homeIndex + 1], requests: process.env.HARNESS_TEST_REQUESTS,
  attempts: process.env.HARNESS_TEST_ATTEMPTS, async webHttp(url, signal, deadlineMs) {
    try { return { ok: true, content: await fetchDirect(url, deadlineMs, signal, dependencies), usage: {} }; }
    catch (error) { return { ok: false, code: error instanceof DirectHttpError ? error.code : "page_unavailable", message: "Fixture fetch failed", usage: {} }; }
  } });
const output = Bun.stdout.writer();
await serveProtocolStdio(server, Bun.stdin.stream(), async bytes => { output.write(bytes); await output.flush(); });
server.dispose(); await output.end();
