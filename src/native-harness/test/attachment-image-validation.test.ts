import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageValidationAvailable, runImageTool, validateManagedImage } from "../src/capabilities/attachments/image-validation.ts";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4y8AARAwQCgAfrgP19hgqWQAAAABJRU5ErkJggg==", "base64");
const available = imageValidationAvailable();
test.skipIf(!available)("image validation decodes real PNG and refuses wrong format and corrupt bytes", async () => {
  const home = mkdtempSync(join(tmpdir(), "attachment-image-")), path = join(home, "image");
  const metadata = { id: "image", channel: "a", filename: "x", mediaType: "image/png", bytes: png.length, sha256: "0".repeat(64) };
  try {
    writeFileSync(path, png);
    await expect(validateManagedImage(path, metadata)).resolves.toBeUndefined();
    await expect(validateManagedImage(path, { ...metadata, mediaType: "image/jpeg" })).rejects.toThrow();
    writeFileSync(path, png.subarray(0, 30));
    await expect(validateManagedImage(path, metadata)).rejects.toThrow();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test.skipIf(!available)("timed out and cancelled image tools are killed and reaped", async () => {
  const home = mkdtempSync(join(tmpdir(), "attachment-image-child-"));
  try {
    for (const mode of ["timeout", "cancel"] as const) {
      const pidPath = join(home, mode);
      const program = `echo $$ > "$1"; trap '' TERM; while :; do :; done`;
      const controller = new AbortController();
      const task = runImageTool("/bin/sh", ["-c", program, "test", pidPath], new Uint8Array(), { signal: controller.signal, timeoutMs: mode === "timeout" ? 500 : 5000 });
      if (mode === "cancel") setTimeout(() => controller.abort(), 500);
      await expect(task).rejects.toThrow();
      const pid = Number(readFileSync(pidPath, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 10000);

 test.skipIf(!available)("image tool address space is bounded and oversized or malformed data fails closed", async () => {
  const input = randomBytes(512 * 1024 + 17);
  const digest = await runImageTool("python3", ["-c", "import sys,hashlib; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"], input);
  expect(digest.trim()).toBe(createHash("sha256").update(input).digest("hex"));
  const probe = await runImageTool("ffprobe", ["-v", "error", "-protocol_whitelist", "pipe", "-max_alloc", "268435456", "-f", "png_pipe", "-i", "pipe:0", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json"], png);
  expect(JSON.parse(probe).streams[0]).toMatchObject({ codec_name: "png", width: 2, height: 2 });
  const limit = await runImageTool("/bin/sh", ["-c", "ulimit -v"], new Uint8Array());
  expect(Number(limit.trim())).toBe(1048576);
  const exhausted = await runImageTool("python3", ["-c", "try:\n bytearray(2 * 1024**3)\nexcept MemoryError:\n print('bounded')\nelse:\n raise SystemExit(1)"], new Uint8Array());
  expect(exhausted.trim()).toBe("bounded");
  const home = mkdtempSync(join(tmpdir(), "attachment-image-adversarial-")), path = join(home, "image");
  try {
    const oversized = Buffer.from(png); oversized.writeUInt32BE(0x7fffffff, 16); oversized.writeUInt32BE(0x7fffffff, 20);
    for (const bytes of [oversized, Buffer.alloc(1024 * 1024, 0xff)]) {
      writeFileSync(path, bytes);
      await expect(validateManagedImage(path, { id: "x", channel: "a", filename: "x", mediaType: "image/png", bytes: bytes.length, sha256: "0".repeat(64) })).rejects.toThrow();
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 20000);
