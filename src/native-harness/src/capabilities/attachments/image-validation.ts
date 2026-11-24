import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type { AttachmentMetadata } from "../../contracts/attachments.ts";
import { ATTACHMENT_LIMITS } from "../../contracts/attachments.ts";
import { UploadError } from "./upload.ts";

const formats: Record<string, { demuxer: string; codec: string }> = {
  "image/png": { demuxer: "png_pipe", codec: "png" },
  "image/jpeg": { demuxer: "jpeg_pipe", codec: "mjpeg" },
  "image/webp": { demuxer: "webp_pipe", codec: "webp" },
};
const toolEnvironment = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" });
const toolOptions = { timeout: 3000, stdio: "ignore" as const, killSignal: "SIGKILL" as const, env: toolEnvironment() };
/** Availability is per session: do not infer support from a model name. */
export function imageValidationAvailable(): boolean {
  return spawnSync("ffprobe", ["-version"], toolOptions).status === 0 && spawnSync("ffmpeg", ["-version"], toolOptions).status === 0;
}

/** Always wait for close after killing a timed-out, cancelled or overproducing
 * child. Neither command receives a filename or a network-capable protocol. */
export function runImageTool(command: string, args: readonly string[], input: Uint8Array,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new UploadError("invalid_attachment", "Image validation cancelled")); return; }
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env: toolEnvironment() });
    const output: Buffer[] = []; let size = 0, failure: string | undefined;
    const stop = (reason: string) => { failure ??= reason; child.kill("SIGKILL"); };
    const timeout = setTimeout(() => stop("Image validation timed out"), options.timeoutMs ?? 15000);
    const abort = () => stop("Image validation cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on("error", () => { failure ??= "Image validator is unavailable"; });
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) stop("Image validator output exceeded limit"); else output.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) stop("Image validator output exceeded limit"); });
    child.stdin.on("error", () => { /* A failed decoder may close its input early. */ });
    child.on("close", code => {
      clearTimeout(timeout); options.signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(new UploadError("invalid_attachment", failure ?? "Image decoding failed"));
      else resolve(Buffer.concat(output).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

/** Probe dimensions before decoding. Only the three fixed demuxers are used;
 * data arrives on stdin and the protocol whitelist permits only that pipe. */
export async function validateManagedImage(path: string, metadata: AttachmentMetadata, signal?: AbortSignal): Promise<void> {
  const format = formats[metadata.mediaType];
  if (!format) throw new UploadError("invalid_attachment", "Only PNG, JPEG and WebP images are supported");
  const data = readFileSync(path);
  if (data.length !== metadata.bytes || data.length > ATTACHMENT_LIMITS.fileBytes) throw new UploadError("invalid_attachment", "Invalid image length");
  const common = ["-v", "error", "-protocol_whitelist", "pipe", "-max_alloc", "268435456", "-f", format.demuxer, "-i", "pipe:0"];
  const result = await runImageTool("ffprobe", [...common, "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json"], data, { signal });
  let stream: { codec_name?: unknown; width?: unknown; height?: unknown } | undefined;
  try { stream = JSON.parse(result).streams?.[0]; } catch { throw new UploadError("invalid_attachment", "Invalid image probe result"); }
  const width = stream?.width, height = stream?.height;
  if (stream?.codec_name !== format.codec || typeof width !== "number" || typeof height !== "number"
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > ATTACHMENT_LIMITS.imageSide || height > ATTACHMENT_LIMITS.imageSide || width * height > ATTACHMENT_LIMITS.imagePixels)
    throw new UploadError("invalid_attachment", "Image type or dimensions are invalid");
  await runImageTool("ffmpeg", ["-v", "error", "-xerror", "-err_detect", "explode", "-threads", "1", ...common.slice(2), "-frames:v", "1", "-f", "null", "-"], data, { signal });
}
