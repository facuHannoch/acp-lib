import { expect, test } from "bun:test";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { gzipSync } from "node:zlib";
import { fetchDirect } from "../src/capabilities/tools/web/direct.ts";
import type { DirectSocketTarget, DirectTransportDependencies } from "../src/capabilities/tools/web/direct-transport.ts";

const url = "https://www.public-site.com/directory?q=1";
const raw = (body: Buffer | string, headers = "Content-Type: text/plain\r\n", status = "200 OK") =>
  Buffer.concat([Buffer.from(`HTTP/1.1 ${status}\r\n${headers}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`), Buffer.from(body)]);

function fixture(route: (target: DirectSocketTarget, index: number) => { fragments?: Buffer[]; peer?: string } = () => ({ fragments: [raw("ok")] })) {
  const targets: DirectSocketTarget[] = [], writes: string[] = [], closed: boolean[] = [];
  const dns: string[] = [];
  const dependencies: DirectTransportDependencies = {
    async resolve(hostname) { dns.push(hostname); return ["8.8.8.8", "2606:4700::1111"]; },
    async connect(target) {
      const index = targets.push(target) - 1;
      const { fragments, peer } = route(target, index);
      const socket = new Duplex({
        read() {},
        write(chunk, _encoding, done) {
          writes.push(chunk.toString());
          if (fragments) {
            for (const piece of fragments) this.push(piece);
            this.push(null);
          }
          done();
        },
      }).once("close", () => { closed[index] = true; });
      Object.defineProperties(socket, { remoteAddress: { value: peer ?? target.address }, remotePort: { value: target.port } });
      return socket as unknown as Socket;
    },
  };
  const fetch = (input = url, signal = new AbortController().signal, timeout = 1000) =>
    fetchDirect(input, timeout, signal, dependencies);
  return { fetch, dependencies, targets, writes, closed, dns };
}

test("pins the actual socket peer before sending, preserves host and TLS identity", async () => {
  const f = fixture();
  expect(JSON.parse(await f.fetch())).toEqual({ url, text: "ok", title: null, truncated: false, coverage: "full" });
  expect(f.targets).toEqual([{ address: "8.8.8.8", family: 4, port: 443, hostname: "www.public-site.com", secure: true }]);
  expect(f.writes).toEqual(["GET /directory?q=1 HTTP/1.1\r\nHost: www.public-site.com\r\nAccept: text/plain, text/html\r\nAccept-Encoding: gzip, deflate, br\r\nConnection: close\r\n\r\n"]);
  const mismatch = fixture(() => ({ peer: "1.1.1.1" }));
  await expect(mismatch.fetch()).rejects.toMatchObject({ code: "blocked_destination" });
  expect(mismatch.writes).toEqual([]);
});

test("rejects mixed DNS and special-purpose addresses before connect", async () => {
  for (const forbidden of ["127.0.0.1", "100.64.0.1", "169.254.169.254", "192.0.2.1", "::ffff:8.8.8.8", "2001:db8::1", "fc00::1", "not-an-address"]) {
    const f = fixture();
    f.dependencies.resolve = async () => ["8.8.8.8", forbidden];
    await expect(f.fetch()).rejects.toMatchObject({ code: "blocked_destination" });
    expect(f.targets).toEqual([]);
  }
  for (const input of ["http://127.1", "http://0x7f.0.0.1", "https://user@public-site.com", "https://public-site.com/#"]) {
    const f = fixture();
    await expect(f.fetch(input)).rejects.toMatchObject({ code: "blocked_destination" });
    expect(f.dns).toEqual([]);
  }
});

test("revalidates redirects, preserves initial attribution, and refuses downgrade", async () => {
  const redirect = (location: string) => raw("", `Location: ${location}\r\n`, "302 Found");
  const f = fixture((_target, i) => ({ fragments: [i ? raw("new location") : redirect("https://different-site.com/next")] }));
  expect(JSON.parse(await f.fetch())).toMatchObject({ url, text: "new location" });
  expect(f.dns).toEqual(["www.public-site.com", "different-site.com"]);
  const rebound = fixture(() => ({ fragments: [redirect("/next")] }));
  let lookups = 0;
  rebound.dependencies.resolve = async () => ++lookups === 1 ? ["8.8.8.8"] : ["10.0.0.1"];
  await expect(rebound.fetch()).rejects.toMatchObject({ code: "blocked_destination" });
  expect(rebound.writes).toHaveLength(1);
  const downgrade = fixture(() => ({ fragments: [redirect("http://different-site.com")] }));
  await expect(downgrade.fetch()).rejects.toMatchObject({ code: "blocked_destination" });
  expect(downgrade.writes).toHaveLength(1);
});

test("limits compressed and decompressed bodies, and returns bounded Unicode JSON", async () => {
  const tooBig = fixture(() => ({ fragments: [raw(Buffer.alloc(2 * 1024 * 1024 + 1, 65))] }));
  await expect(tooBig.fetch()).rejects.toMatchObject({ code: "response_too_large" });
  const inflated = fixture(() => ({ fragments: [raw(gzipSync(Buffer.alloc(4 * 1024 * 1024 + 1, 65)), "Content-Type: text/plain\r\nContent-Encoding: gzip\r\n")] }));
  await expect(inflated.fetch()).rejects.toMatchObject({ code: "response_too_large" });
  const clipped = fixture(() => ({ fragments: [raw("😀".repeat(2000))] }));
  const result = await clipped.fetch();
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(2048);
  expect(JSON.parse(result)).toMatchObject({ url, truncated: true });
  expect(JSON.parse(result).text).toMatch(/^(?:😀)+$/u);
});

test("reads framed chunks, extracts HTML, and rejects invalid framing", async () => {
  const html = "<head><title>Hello &amp; friends</title></head><p>World</p><script>ignoreMe()</script>";
  const chunked = Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n${html.length.toString(16)}\r\n${html}\r\n0\r\nX-Trailer: yes\r\n\r\n`);
  const f = fixture(() => ({ fragments: [...chunked].map(byte => Buffer.of(byte)) }));
  expect(JSON.parse(await f.fetch())).toMatchObject({ title: "Hello & friends", text: "World", coverage: "unknown" });
  const broken = fixture(() => ({ fragments: [raw("hello").subarray(0, -1)] }));
  await expect(broken.fetch()).rejects.toMatchObject({ code: "page_unavailable" });
});

test("interrupts DNS, connect and body, and distinguishes deadline", async () => {
  const pending = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  for (const stage of ["resolve", "connect", "body"]) {
    const f = fixture(() => ({}));
    const control = new AbortController();
    if (stage === "resolve") f.dependencies.resolve = (_hostname, signal) => pending(signal);
    if (stage === "connect") f.dependencies.connect = (_target, signal) => pending(signal);
    const result = f.fetch(url, control.signal);
    setTimeout(() => control.abort(), 5);
    await expect(result).rejects.toMatchObject({ code: "tool_interrupted" });
    if (stage === "body") expect(f.closed).toEqual([true]);
  }
  await expect(fixture(() => ({})).fetch(url, undefined, 5)).rejects.toMatchObject({ code: "tool_timeout" });
});

test("pins an IPv6 literal and rejects the seventh request", async () => {
  const ipv6 = fixture(() => ({ fragments: [raw("v6")], peer: "2606:4700:0:0:0:0:0:1111" }));
  const source = "http://[2606:4700::1111]:8080/v6";
  expect(JSON.parse(await ipv6.fetch(source))).toMatchObject({ url: source, text: "v6" });
  expect(ipv6.dns).toEqual([]);
  expect(ipv6.targets).toEqual([{ address: "2606:4700::1111", family: 6, port: 8080, hostname: "2606:4700::1111", secure: false }]);
  expect(ipv6.writes[0]).toContain("Host: [2606:4700::1111]:8080\r\n");

  const redirects = fixture((_target, index) => ({ fragments: [raw("", `Location: /hop-${index}\r\n`, "302 Found")] }));
  await expect(redirects.fetch()).rejects.toMatchObject({ code: "blocked_destination" });
  expect(redirects.writes).toHaveLength(6);
  expect(redirects.closed).toEqual(Array(6).fill(true));
});
