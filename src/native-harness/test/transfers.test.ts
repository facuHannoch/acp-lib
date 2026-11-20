import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransfers, TransferFault } from "../src/interfaces/protocol/transfers.ts";
import { HarnessClient } from "../src/client.ts";
import type { ClientTransport, RpcRequest, RpcResponse } from "../src/contracts/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "harness-transfers-test-"));
afterAll(() => { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); });
const fresh = () => mkdtempSync(join(root, "t-"));
const hash = "0".repeat(64);
const limits = { chunkBytes: 4, maxBytes: 64, idleMs: 60000 } as never;
const files = (directory: string) => readdirSync(directory).filter(name => name.startsWith(".transfer-"));

test("an upload whose file cannot be created frees the connection's one transfer slot", () => {
  const directory = fresh();
  const transfers = createTransfers(directory, limits);
  // Read-only directory: creating the transfer file fails (not when running as root).
  chmodSync(directory, 0o500);
  let refused = false;
  try { transfers.openUpload(8, hash); } catch (error) { refused = !(error instanceof TransferFault); }
  chmodSync(directory, 0o700);
  // Root ignores directory permissions, so the failure cannot be provoked there.
  if (process.getuid?.() === 0) { transfers.dispose(); return; }
  expect(refused).toBe(true);
  // The failed open did not leave the slot occupied.
  const id = transfers.openUpload(8, hash);
  expect(transfers.write(id, 0, Buffer.from("abcd").toString("base64"))).toBe(4);
  transfers.dispose();
  expect(files(directory)).toEqual([]);
});

test("a failed append ends the upload instead of leaving an offset that cannot be retried", () => {
  const directory = fresh();
  const transfers = createTransfers(directory, limits);
  const id = transfers.openUpload(8, hash);
  expect(transfers.write(id, 0, Buffer.from("abcd").toString("base64"))).toBe(4);
  // Make the file unwritable underneath the open transfer.
  const path = join(directory, files(directory)[0]!);
  rmSync(path); chmodSync(directory, 0o500);
  let failed = false;
  try { transfers.write(id, 4, Buffer.from("efgh").toString("base64")); } catch (error) { failed = !(error instanceof TransferFault); }
  chmodSync(directory, 0o700);
  // Root ignores directory permissions, so the failure cannot be provoked there.
  if (process.getuid?.() === 0) { transfers.dispose(); return; }
  expect(failed).toBe(true);
  // The transfer is gone: the same offset cannot be appended twice, and a new one can open.
  expect(() => transfers.write(id, 4, Buffer.from("efgh").toString("base64"))).toThrow("Unknown transfer");
  expect(typeof transfers.openUpload(8, hash)).toBe("string");
  transfers.dispose();
});

test("a download returns only the bytes it read and reports the end only at the announced length", () => {
  const directory = fresh();
  const transfers = createTransfers(directory, limits);
  const id = transfers.offer(new TextEncoder().encode("abcdefghij"), hash);
  expect(transfers.read(id, 0)).toEqual({ data: Buffer.from("abcd").toString("base64"), eof: false });
  expect(transfers.read(id, 8)).toEqual({ data: Buffer.from("ij").toString("base64"), eof: true });
  // The file loses its tail underneath the transfer: a short read is short, and is not the end.
  truncateSync(join(directory, files(directory)[0]!), 6);
  expect(transfers.read(id, 4)).toEqual({ data: Buffer.from("ef").toString("base64"), eof: false });
  expect(transfers.read(id, 6)).toEqual({ data: "", eof: false });
  transfers.dispose();
  expect(files(directory)).toEqual([]);
});

test("startup removes only transfer files whose process is gone", () => {
  const directory = fresh();
  const dead = Bun.spawnSync(["true"]).pid;
  // PID 1 exists and cannot be signalled by an unprivileged process (EPERM); as root the signal simply succeeds.
  for (const pid of [dead, 1, process.pid]) writeFileSync(join(directory, `.transfer-${pid}-left`), "x");
  writeFileSync(join(directory, "session.sqlite"), "x");
  createTransfers(directory, limits).dispose();
  expect(readdirSync(directory).sort()).toEqual([`.transfer-1-left`, `.transfer-${process.pid}-left`, "session.sqlite"].sort());
});

test("a download that stops making progress fails the export instead of reading the same offset again", async () => {
  for (const stalled of [{ data: "", eof: false }, { data: Buffer.from("too many bytes").toString("base64"), eof: false }]) {
    const requests: RpcRequest[] = [];
    let deliver!: (message: RpcResponse) => void;
    const transport: ClientTransport = { subscribe(listener) { deliver = listener as typeof deliver; return () => {}; }, onClose: () => () => {}, close() {},
      send(request) {
        requests.push(request);
        const result = request.method === "session/export" ? { bytes: 8, sha256: hash, transferId: "t" } : request.method === "transfer/read" ? stalled : {};
        queueMicrotask(() => deliver({ jsonrpc: "2.0", id: request.id, result }));
      } };
    const client = new HarnessClient(transport, 500);
    await expect(client.exportArchive()).rejects.toMatchObject({ code: "invalid_archive" });
    // One read, then the transfer was closed.
    expect(requests.map(request => request.method)).toEqual(["session/export", "transfer/read", "transfer/close"]);
    client.close();
  }
});
