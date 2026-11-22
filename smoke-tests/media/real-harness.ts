#!/usr/bin/env bun
// Synthetic inputs only. Every file a path probe may edit lives below a generated temporary directory.
import { mkdtemp, mkdir, writeFile, readFile, symlink, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { AcpClient } from "../../src/client.ts";
import { ADAPTERS } from "../../src/adapters.ts";
import type { ClientPrompt } from "../../src/agent-client.ts";
import type { PromptHandlers } from "../../src/types.ts";

const adapterId = process.argv[2] ?? "claude";
if (!["claude", "codex", "opencode", "grok"].includes(adapterId)) throw new Error("choose claude, codex, opencode, or grok");
const root = await mkdtemp(join(tmpdir(), `acp-media-real-${adapterId}-`));
const cwd = join(root, "workspace");
const outsideBase = process.env.ACP_MEDIA_OUTSIDE_ROOT;
if (outsideBase) await mkdir(outsideBase, { recursive: true });
const outside = outsideBase ? await mkdtemp(join(outsideBase, `acp-media-${adapterId}-`)) : join(root, "outside");
await mkdir(cwd); if (!outsideBase) await mkdir(outside);
const report: Record<string, any> = { adapterId, timestamp: new Date().toISOString(), cases: [], syntheticFilesOnly: true, outsideTemporaryDirectory: Boolean(outsideBase) };
const output = process.env.ACP_MEDIA_RESULT ?? join(import.meta.dir, "measurements", `${new Date().toISOString().slice(0, 10)}-${adapterId}.json`);

async function runTurn(client: AcpClient, name: string, input: ClientPrompt, expect?: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hard: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  try {
    timer = setTimeout(() => client.interrupt(), 45_000);
    const result = await Promise.race([client.prompt(input), new Promise<never>((_resolve, reject) => {
      hard = setTimeout(() => reject(new Error("probe exceeded 55 seconds")), 55_000);
    })]);
    const entry = { name, status: result.status, ...(/^(un)?declared-/.test(name) ? {} : { text: result.text.slice(0, 2000) }), elapsedMs: Date.now() - started,
      ...(expect ? { semanticMatch: result.text.toLowerCase().includes(expect.toLowerCase()) } : {}) };
    report.cases.push(entry); console.log(JSON.stringify(entry)); return entry;
  } catch (error) {
    if (String(error).includes("exceeded 55 seconds")) await client.stop();
    const entry = { name, error: String(error).slice(0, 1200), elapsedMs: Date.now() - started };
    report.cases.push(entry); console.log(JSON.stringify(entry)); return entry;
  } finally { clearTimeout(timer); clearTimeout(hard); }
}
function client(directories = false) {
  return new AcpClient({ adapter: ADAPTERS[adapterId as "claude" | "codex" | "opencode" | "grok"], cwd,
    ...(directories ? { additionalDirectories: [outside] } : {}), permissions: { default: "ask" } });
}
async function initialize(client: AcpClient) {
  const caps = await client.connect();
  await client.startSession();
  if (process.env.ACP_MEDIA_MODEL) await client.setConfig("model", process.env.ACP_MEDIA_MODEL);
  report.model = client.configOptions.get("model")?.currentValue;
  return caps;
}
const permissions: Record<string, unknown>[] = [];
const handlers: PromptHandlers = { onPermissionRequest: (request) => {
  const serialized = JSON.stringify(request.raw ?? request);
  const scoped = serialized.includes(root) || serialized.includes(outside);
  const allow = scoped ? request.options.find((option) => option.kind === "allow_once") : undefined;
  permissions.push({ title: request.title, scoped, granted: Boolean(allow) });
  return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
} };
try {
  if (process.env.ACP_MEDIA_PROBES !== "paths") {
  const media = client();
  try {
    const caps = await initialize(media); report.capabilities = caps.agent; report.agentInfo = caps.agentInfo;
    console.log(JSON.stringify({ capabilities: report.capabilities, agentInfo: report.agentInfo }));
    if (caps.agent.promptCapabilities.image) await runTurn(media, "image-copy", { parts: [
      { kind: "text", text: "What is the dominant color of this image? Answer with one color word only. Do not use tools." },
      { kind: "image", data: redPng(), mimeType: "image/png", mode: "copy" },
    ] }, "red");
    else report.cases.push({ name: "image-copy", unsupported: true });
    if (caps.agent.promptCapabilities.audio) await runTurn(media, "audio-copy", { parts: [
      { kind: "text", text: "Describe this audio in one short sentence. Do not use tools." },
      { kind: "audio", data: silentWav(), mimeType: "audio/wav", mode: "copy" },
    ] });
    else report.cases.push({ name: "audio-copy", unsupported: true });
    if (caps.agent.promptCapabilities.embeddedContext) {
      await runTurn(media, "text-file-copy", { parts: [
        { kind: "text", text: "Return the uppercase marker in this embedded text file. Do not use tools." },
        { kind: "file", data: new TextEncoder().encode("ACPMEDIA_TEXT_CHECK"), name: "notes.txt", mimeType: "text/plain", mode: "copy" },
      ] }, "ACPMEDIA_TEXT_CHECK");
      await runTurn(media, "binary-file-copy", { parts: [
        { kind: "text", text: "Return the uppercase marker printed in this attached PDF. If it was not supplied, say UNAVAILABLE. Do not use tools." },
        { kind: "file", data: markerPdf(), name: "marker.pdf", mimeType: "application/pdf", mode: "copy" },
      ] }, "ACPMEDIA_BLOB_CHECK");
    } else { report.cases.push({ name: "text-file-copy", unsupported: true }, { name: "binary-file-copy", unsupported: true }); }
    const pointer = join(cwd, "pointer.txt"); await writeFile(pointer, "ACPMEDIA_POINTER_CHECK\n");
    await runTurn(media, "file-link", { handlers, parts: [
      { kind: "text", text: "Read the linked synthetic file using your tools and return its uppercase marker. Do not modify it." },
      { kind: "file", path: pointer, mode: "link", mimeType: "text/plain" },
    ] }, "ACPMEDIA_POINTER_CHECK");
  } catch (error) { report.initializationError = String(error).slice(0, 1200); }
  finally { await media.stop(); }
  }

  for (const declared of [false, true]) {
    const paths = client(declared);
    try {
      await initialize(paths);
      for (const indirect of [false, true]) {
        const name = `${declared ? "declared" : "undeclared"}-${indirect ? "symlink" : "direct"}`;
        if (process.env.ACP_MEDIA_CASE && process.env.ACP_MEDIA_CASE !== name) continue;
        const target = join(outside, `${name}.txt`);
        const pointer = indirect ? join(cwd, `${name}.txt`) : target;
        const seed = `SEED_${crypto.randomUUID()}`;
        const change = `EDIT_${name}`;
        await writeFile(target, `${seed}\n`);
        if (indirect) await symlink(target, pointer);
        const entry = await runTurn(paths, name, { handlers, parts: [
          { kind: "text", text: `This is a synthetic sandbox probe. Read ${pointer}, then append exactly one line '${change}' to that file. Return the original first line. Work only on this test file; do not inspect or modify anything else.` },
          { kind: "file", path: pointer, mode: "link", mimeType: "text/plain" },
        ] }, seed);
        Object.assign(entry, { modified: (await readFile(target, "utf8")).includes(change),
          pointerModified: (await readFile(pointer, "utf8")).includes(change), symlinkPreserved: (await lstat(pointer)).isSymbolicLink(), declared, symlink: indirect });
      }
    } catch (error) { report.cases.push({ name: `paths-${declared}`, error: String(error).slice(0, 1200) }); }
    finally { await paths.stop(); }
  }
} finally {
  report.permissions = permissions;
  await mkdir(join(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  await rm(root, { recursive: true, force: true });
  if (outsideBase) await rm(outside, { recursive: true, force: true });
  console.log(`Report: ${output}`);
}

function redPng(): Uint8Array {
  const crc = (bytes: Uint8Array) => { let n = 0xffffffff; for (const byte of bytes) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), out.length - 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(16 * 65); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const i = y * 65 + 1 + x * 4; pixels[i] = 255; pixels[i + 3] = 255; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", new Uint8Array())]);
}
function silentWav(): Uint8Array {
  const wav = Buffer.alloc(44 + 3200); wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(3200, 40); return wav;
}
function markerPdf(): Uint8Array {
  const stream = "BT /F1 12 Tf 20 40 Td (ACPMEDIA_BLOB_CHECK) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0]; for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return new TextEncoder().encode(pdf);
}
