import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSessionFile, encodeSessionFile } from "../src/state/storage/session-file.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";

const max = 268435456;
const frame = (hex: string) => { const payload = Buffer.from(hex, "hex"), out = Buffer.alloc(14 + payload.length); out.write("HARNSESS"); out.writeUInt16BE(1, 8); out.writeUInt32BE(payload.length, 10); payload.copy(out, 14); return out; };
const failure = (fn: () => unknown, code: string) => { try { fn(); throw new Error("expected failure"); } catch (e) { expect(e).toMatchObject({ code }); } };

test("CBOR profile reads independent vectors and rejects invalid envelopes and values", () => {
  expect(decodeSessionFile(frame("a3616101616282f5f6616362c3a9"), max)).toEqual({ a: 1, b: [true, null], c: "é" });
  expect(decodeSessionFile(frame("f93e00"), max)).toBe(1.5);
  for (const hex of ["a2616101616102", "5f40ff", "c001", "f7", "fb7ff0000000000000", "a10100", "61ff", "0102", "9f01ff"]) failure(() => decodeSessionFile(frame(hex), max), "invalid_archive");
  const good = frame("a0");
  for (const bad of [Buffer.from("{}"), good.subarray(0, 13), Buffer.concat([good, Buffer.from([0])]), Buffer.from(good)]) {
    if (bad.length === good.length) bad[9] = 2;
    failure(() => decodeSessionFile(bad, max), "invalid_archive");
  }
  const huge = Buffer.from(good); huge.writeUInt32BE(0xffffffff, 10);
  failure(() => decodeSessionFile(huge, 10), "invalid_archive");
  failure(() => decodeSessionFile(good, 14), "transfer_limit");
  failure(() => encodeSessionFile({ n: Infinity }, max), "serialization_error");
  failure(() => encodeSessionFile({ n: 1 }, 14), "transfer_limit");
});

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: imported configuration is atomic, durable and optional for old sessions`, () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-config-"));
  try {
    const make = (name: string) => kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, name));
    const original = make("source"), opened = original.open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "k" } });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.importedConfig()).toMatchObject({ ok: true, value: undefined });
    const exported = opened.value.exportArchive(); if (!exported.ok) throw new Error(exported.error.message);
    opened.value.close();
    const config = { version: 1 as const, system: "exact", model: { protocol: "scripted" as const, script: "relative.json" } };
    const destination = make("dest");
    expect(destination.importSessionFile({ archive: exported.value, config: { ...config, model: { ...config.model, script: "  " } } }).ok).toBe(false);
    expect(destination.importSessionFile({ archive: exported.value, config }).ok).toBe(true);
    expect(destination.importSessionFile({ archive: exported.value, config }).ok).toBe(false);
    const restored = destination.open({ mode: "open", identity: { sessionId: "s", compatibilityKey: "k" } });
    if (!restored.ok) throw new Error(restored.error.message);
    const saved = restored.value.importedConfig(); expect(saved).toMatchObject({ ok: true, value: config });
    if (saved.ok && saved.value) saved.value.system = "modified";
    expect(restored.value.importedConfig()).toMatchObject({ ok: true, value: config });
    restored.value.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
