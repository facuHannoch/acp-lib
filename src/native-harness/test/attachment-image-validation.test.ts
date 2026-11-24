import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runImageTool, validateManagedImage } from "../src/capabilities/attachments/image-validation.ts";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4y8AARAwQCgAfrgP19hgqWQAAAABJRU5ErkJggg==", "base64");
const available = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 && spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
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

test("timed out and cancelled image tools are killed and reaped", async () => {
  const home = mkdtempSync(join(tmpdir(), "attachment-image-child-"));
  try {
    for (const mode of ["timeout", "cancel"] as const) {
      const pidPath = join(home, mode);
      const program = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`;
      const controller = new AbortController();
      const task = runImageTool(process.execPath, ["-e", program], new Uint8Array(), { signal: controller.signal, timeoutMs: mode === "timeout" ? 500 : 5000 });
      if (mode === "cancel") setTimeout(() => controller.abort(), 500);
      await expect(task).rejects.toThrow();
      const pid = Number(readFileSync(pidPath, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 10000);
