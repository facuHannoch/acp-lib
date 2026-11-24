import { expect, test } from "bun:test";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { fetchDirect } from "../src/capabilities/tools/web/direct.ts";
import { dialDirect, readPinnedResponse } from "../src/capabilities/tools/web/direct-transport.ts";

const cert = readFileSync(new URL("./fixtures/web-direct/server.crt", import.meta.url), "utf8");
const key = readFileSync(new URL("./fixtures/web-direct/server.key", import.meta.url), "utf8");
const hostname = "direct-fixture.example";

async function listen(server: Server) {
  const sockets = new Set<Socket>();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await ready;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  return {
    port: address.port,
    async close() {
      const closed = once(server, "close");
      server.close();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

const target = (port: number, secure = false) => ({
  port, secure, hostname, address: "127.0.0.1", family: 4 as const,
});

test("production dial verifies the original TLS name and presents it via SNI", async () => {
  const names: Array<string | false> = [];
  const listener = await listen(createTlsServer({ key, cert }, socket => {
    names.push((socket as TLSSocket & { servername: string | false }).servername);
    socket.on("data", data => {
      const request = data.toString();
      if (request.startsWith("GET /probe HTTP/1.1\r\n") && request.includes(`Host: ${hostname}\r\n`)) {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\necho");
      }
    });
  }));
  const signal = AbortSignal.timeout(3000);
  try {
    const socket = await dialDirect(target(listener.port, true), signal, cert);
    try {
      const response = await readPinnedResponse(socket, new URL(`https://${hostname}/probe`), signal);
      const pieces: Buffer[] = [];
      for await (const chunk of response.body) pieces.push(chunk);
      expect(response.statusCode).toBe(200);
      expect(Buffer.concat(pieces).toString()).toBe("echo");
      expect(names).toEqual([hostname]);
    } finally { socket.destroy(); }
    await expect(dialDirect({ ...target(listener.port, true), hostname: "wrong-fixture.example" }, signal, cert)).rejects.toBeInstanceOf(Error);
  } finally { await listener.close(); }
});

test("production dial cancels and closes a TCP connection awaiting TLS", async () => {
  const server = createServer();
  const listener = await listen(server);
  const control = new AbortController();
  try {
    const connected = once(server, "connection", { signal: AbortSignal.timeout(3000) });
    const result = dialDirect(target(listener.port, true), control.signal, cert);
    const [peer] = await connected as [Socket];
    const closed = once(peer, "close", { signal: AbortSignal.timeout(3000) });
    peer.resume();
    const reason = new Error("fixture cancelled");
    control.abort(reason);
    await expect(result).rejects.toBe(reason);
    await closed;
  } finally { await listener.close(); }
});

test("redirect DNS and real mismatched sockets are fenced before HTTP writes", async () => {
  let bytes = 0;
  const listener = await listen(createServer(socket => socket.on("data", chunk => { bytes += chunk.length; })));
  const signal = AbortSignal.timeout(3000);
  try {
    let connects = 0;
    const dependencies = {
      resolve: async () => ["8.8.8.8"],
      connect: async () => {
        connects++;
        return dialDirect(target(listener.port), signal);
      },
    };
    const source = "http://public-fixture.com";
    await expect(fetchDirect(source, 3000, signal, dependencies)).rejects.toMatchObject({ code: "blocked_destination" });
    expect(connects).toBe(1);
    expect(bytes).toBe(0);
    await expect(fetchDirect(`http://127.0.0.1:${listener.port}`, 3000, signal, dependencies)).rejects.toMatchObject({ code: "blocked_destination" });
    expect(connects).toBe(1);

    const names: string[] = [];
    const redirect = {
      async resolve(name: string) { names.push(name); return ["8.8.8.8"]; },
      async connect(pin: { address: string; port: number }, stop: AbortSignal) {
        if (names.length > 1) return dialDirect(target(listener.port), stop);
        const socket = new Duplex({
          read() {},
          write(_chunk, _encoding, done) {
            this.push("HTTP/1.1 302 Found\r\nLocation: http://redirected-fixture.com/next\r\nContent-Length: 0\r\n\r\n");
            done();
          },
        });
        Object.defineProperties(socket, { remoteAddress: { value: pin.address }, remotePort: { value: pin.port } });
        return socket as unknown as Socket;
      },
    };
    await expect(fetchDirect(source, 3000, signal, redirect)).rejects.toMatchObject({ code: "blocked_destination" });
    expect(names).toEqual(["public-fixture.com", "redirected-fixture.com"]);
    expect(bytes).toBe(0);
  } finally { await listener.close(); }
});
