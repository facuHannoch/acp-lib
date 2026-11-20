import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DurableErrorCode, TransferLimits } from "../../contracts/protocol.ts";
import { decodeSessionFile, encodeSessionFile } from "../../state/storage/session-file.ts";

export const TRANSFER_LIMITS: TransferLimits = { chunkBytes: 524288, maxBytes: 268435456, idleMs: 60000 };
export class TransferFault extends Error {
  constructor(readonly code: DurableErrorCode, message: string) { super(message); }
}
const PREFIX = ".transfer-";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Hash the complete session-file envelope, including its header. */
export function encodeArchive(archive: unknown, maxBytes: number) {
  const bytes = encodeSessionFile(archive, maxBytes);
  return { bytes, sha256: sha256(bytes) };
}
export function decodeArchive(bytes: Uint8Array, maxBytes = TRANSFER_LIMITS.maxBytes): unknown {
  return decodeSessionFile(bytes, maxBytes);
}

/** Write beside the destination, then publish with a hard link, which refuses
 * an existing file. No partial or replaced archive is ever visible at `path`. */
export function writeArchiveFile(path: string, bytes: Uint8Array) {
  if (existsSync(path)) throw new TransferFault("already_exists", `A file already exists at ${path}`);
  const draft = `${path}.draft-${randomUUID()}`;
  try {
    writeFileSync(draft, bytes, { flag: "wx" });
    try { linkSync(draft, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TransferFault("already_exists", `A file already exists at ${path}`);
      throw error;
    }
  } finally { rmSync(draft, { force: true }); }
}
export function readArchiveFile(path: string, maxBytes: number): Uint8Array {
  let size: number;
  try { size = statSync(path).size; } catch { throw new TransferFault("not_found", `No archive at ${path}`); }
  if (size > maxBytes) {
    const header = Buffer.alloc(14), fd = openSync(path, "r"); let n: number;
    try { n = readSync(fd, header, 0, 14, 0); } finally { closeSync(fd); }
    if (n !== 14 || header.subarray(0, 8).toString() !== "HARNSESS" || header.readUInt16BE(8) !== 1 || size !== 14 + header.readUInt32BE(10))
      throw new TransferFault("invalid_archive", "Invalid session file header or length");
    throw new TransferFault("transfer_limit", `Archive is ${size} bytes; the limit is ${maxBytes}`);
  }
  return readFileSync(path);
}

/** One bounded transfer for one connection, backed by a temporary file so an
 * archive never has to fit a frame or stay in memory between requests. The
 * file is removed when the transfer is closed, consumed, idle too long, or the
 * connection ends; files left by a killed process are removed at startup. */
export function createTransfers(directory: string, limits: TransferLimits = TRANSFER_LIMITS) {
  mkdirSync(directory, { recursive: true });
  // The directory may be shared with other live servers: remove only files
  // whose owning process no longer exists.
  for (const name of readdirSync(directory)) {
    const pid = Number(/^\.transfer-(\d+)-/.exec(name)?.[1]);
    if (!pid || pid === process.pid) continue;
    // Only "no such process" proves the owner is gone. EPERM means it exists
    // and merely cannot be signalled from here, so its file is left alone.
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(join(directory, name), { force: true }); }
  }
  let open: { id: string; path: string; upload: boolean; bytes: number; sha256: string; received: number; timer?: ReturnType<typeof setTimeout> } | undefined;
  function close() {
    if (!open) return;
    // Free the slot first: a failing unlink must not leave the connection
    // unable to open another transfer.
    const { path, timer } = open;
    open = undefined; clearTimeout(timer);
    rmSync(path, { force: true });
  }
  function begin(upload: boolean, bytes: number, digest: string) {
    if (open) throw new TransferFault("transfer_limit", "Only one transfer may be open per connection");
    const id = randomUUID();
    open = { id, path: join(directory, `${PREFIX}${process.pid}-${id}`), upload, bytes, sha256: digest, received: 0 };
    return open;
  }
  function use(id: unknown, upload: boolean) {
    if (!open || open.id !== id || open.upload !== upload) throw new TransferFault("not_found", "Unknown transfer");
    clearTimeout(open.timer);
    open.timer = setTimeout(close, limits.idleMs);
    return open;
  }
  return {
    limits,
    /** Announce an upload of `bytes` bytes with the given SHA-256. */
    openUpload(bytes: unknown, digest: unknown) {
      if (!Number.isSafeInteger(bytes) || (bytes as number) < 1 || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
        throw new TransferFault("invalid_archive", "Expected a positive byte length and a lowercase hex SHA-256");
      if ((bytes as number) > limits.maxBytes) throw new TransferFault("transfer_limit", `Archive is ${bytes} bytes; the limit is ${limits.maxBytes}`);
      const transfer = begin(true, bytes as number, digest);
      // The slot is taken: if its file cannot be created, free it again.
      try { writeFileSync(transfer.path, new Uint8Array(0), { flag: "wx" }); }
      catch (error) { close(); throw error; }
      return use(transfer.id, true).id;
    },
    write(id: unknown, offset: unknown, data: unknown) {
      const transfer = use(id, true);
      if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new TransferFault("transfer_limit", "Chunk must be base64");
      const chunk = Buffer.from(data, "base64");
      // Sequential, bounded and never past the announced length; a refused chunk writes nothing.
      if (offset !== transfer.received || !chunk.length || chunk.length > limits.chunkBytes || transfer.received + chunk.length > transfer.bytes)
        throw new TransferFault("transfer_limit", `Expected at most ${limits.chunkBytes} bytes at offset ${transfer.received} of ${transfer.bytes}`);
      // A failed append may have written part of the chunk, so this offset can
      // no longer be retried safely: the transfer ends and its file is removed.
      try { appendFileSync(transfer.path, chunk); }
      catch (error) { close(); throw error; }
      transfer.received += chunk.length;
      return transfer.received;
    },
    /** Take a finished upload. The transfer ends here whether or not the bytes are usable. */
    consume(id: unknown): Uint8Array {
      const transfer = use(id, true);
      try {
        if (transfer.received !== transfer.bytes) throw new TransferFault("invalid_archive", `Upload has ${transfer.received} of ${transfer.bytes} bytes`);
        const bytes = readFileSync(transfer.path);
        if (sha256(bytes) !== transfer.sha256) throw new TransferFault("invalid_archive", "Uploaded bytes do not match the announced SHA-256");
        return bytes;
      } finally { close(); }
    },
    /** Offer bytes for download; nothing is written if another transfer is open. */
    offer(bytes: Uint8Array, digest: string) {
      const transfer = begin(false, bytes.length, digest);
      try { writeFileSync(transfer.path, bytes, { flag: "wx" }); }
      catch (error) { close(); throw error; }
      return use(transfer.id, false).id;
    },
    read(id: unknown, offset: unknown) {
      const transfer = use(id, false);
      if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > transfer.bytes) throw new TransferFault("transfer_limit", "Offset is outside the transfer");
      const chunk = Buffer.alloc(Math.min(limits.chunkBytes, transfer.bytes - (offset as number)));
      let count: number;
      try {
        const file = openSync(transfer.path, "r");
        try { count = readSync(file, chunk, 0, chunk.length, offset as number); } finally { closeSync(file); }
      } catch (error) { close(); throw error; }
      // Send only what was read; the end is the announced length, not a short read.
      return { data: chunk.subarray(0, count).toString("base64"), eof: (offset as number) + count >= transfer.bytes };
    },
    close(id: unknown) { if (!open || open.id !== id) throw new TransferFault("not_found", "Unknown transfer"); close(); },
    dispose: close,
  };
}
