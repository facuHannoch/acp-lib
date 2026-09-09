import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/session-manager.ts";
import { FileSessionStore, type SessionRecord } from "../src/session-store.ts";
import { migrateLegacyTranscript } from "../src/persistence/migration.ts";
import type { StagedContinuationState } from "../src/persistence/registry.ts";

const roots: string[] = [];
const NOW = new Date("2026-09-09T18:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy registry import", () => {
  test("imports only transcript-backed authority and reports every other row", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-legacy-registry-"));
    roots.push(root);
    const legacy = new FileSessionStore(join(root, "legacy"));
    const manager = await SessionManager.open({ root: join(root, "managed") });

    const importable = await migratedLegacyRow(root, "importable", "fake");
    const mismatch = await migratedLegacyRow(root, "mismatch", "different-adapter", "fake");
    await legacy.save(importable);
    await legacy.save(mismatch);
    await legacy.save(row("missing", join(root, "does-not-exist.jsonl"), "fake"));

    const result = await manager.importLegacySessions(legacy);
    expect(result).toMatchObject({ imported: 1, alreadyImported: 0, conflicts: 1, skipped: 1 });
    expect(result.entries).toEqual([
      { agentSessionId: "importable", status: "imported" },
      {
        agentSessionId: "mismatch",
        status: "conflict",
        reason: "transcript_identity_mismatch",
        detail: "legacy routing fields disagree with transcript continuation authority",
      },
      {
        agentSessionId: "missing",
        status: "skipped",
        reason: "missing_transcript",
        detail: `transcript does not exist: ${join(root, "does-not-exist.jsonl")}`,
      },
    ]);

    const imported = await manager.getAgentSessionInfo("importable");
    expect(imported).toMatchObject({
      agentSessionId: "importable",
      incarnationId: "inc-importable",
      adapterId: "fake",
      transcriptAvailable: true,
      lifecycle: "active",
    });
    expect(await manager.getAgentSessionInfo("mismatch")).toBeNull();
  });

  test("repeated and concurrent imports recognize the same persisted incarnation", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-legacy-registry-idempotent-"));
    roots.push(root);
    const legacy = new FileSessionStore(join(root, "legacy"));
    await legacy.save(await migratedLegacyRow(root, "same", "fake"));
    const a = await SessionManager.open({ root: join(root, "managed") });
    const b = await SessionManager.open({ root: join(root, "managed") });

    const [left, right] = await Promise.all([
      a.importLegacySessions(legacy),
      b.importLegacySessions(legacy),
    ]);
    expect(left.imported + right.imported).toBe(1);
    expect(left.alreadyImported + right.alreadyImported).toBe(1);
    const retry = await a.importLegacySessions(legacy);
    expect(retry).toMatchObject({ imported: 0, alreadyImported: 1, conflicts: 0, skipped: 0 });
  });

  test("does not overwrite another incarnation of the same logical ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-legacy-registry-conflict-"));
    roots.push(root);
    const first = new FileSessionStore(join(root, "legacy-a"));
    const second = new FileSessionStore(join(root, "legacy-b"));
    const manager = await SessionManager.open({ root: join(root, "managed") });
    await first.save(await migratedLegacyRow(join(root, "a"), "stable", "fake", "fake", "inc-a"));
    await second.save(await migratedLegacyRow(join(root, "b"), "stable", "fake", "fake", "inc-b"));
    expect((await manager.importLegacySessions(first)).imported).toBe(1);
    const conflict = await manager.importLegacySessions(second);
    expect(conflict.entries).toMatchObject([
      { agentSessionId: "stable", status: "conflict", reason: "target_identity_conflict" },
    ]);
    expect((await manager.getAgentSessionInfo("stable"))?.incarnationId).toBe("inc-a");
  });
});

async function migratedLegacyRow(
  root: string,
  id: string,
  legacyAdapter: string,
  checkpointAdapter = legacyAdapter,
  incarnationId = `inc-${id}`,
): Promise<SessionRecord> {
  await mkdir(root, { recursive: true });
  const path = join(root, `${id}.jsonl`);
  await writeFile(path, `${JSON.stringify({ v: 1, t: "msg", role: "user", text: id, ts: NOW.getTime() })}\n`);
  await migrateLegacyTranscript({
    path,
    agentSessionId: id,
    transcriptId: `transcript-${incarnationId}`,
    incarnationId,
    continuation: continuation(checkpointAdapter, `provider-${id}`),
    now: () => NOW,
  });
  return row(id, path, legacyAdapter);
}

function row(id: string, transcriptPath: string, adapter: string): SessionRecord {
  return {
    agentSessionId: id,
    internalSessionId: `provider-${id}`,
    adapter,
    mode: "normal",
    title: `Legacy ${id}`,
    transcriptPath,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function continuation(adapterId: string, internalSessionId: string): StagedContinuationState {
  return {
    adapterId,
    mode: "normal",
    internalSessionId,
    internalSessionActivatedAt: NOW.toISOString(),
    model: "model-1",
    sessionConfiguration: {
      adapterId,
      effective: {},
      restorationTargets: [],
      announcedConfigIds: [],
      schemaDigest: null,
      observedAt: NOW.toISOString(),
      restorationFidelity: "exact",
      omittedConfigIds: [],
    },
    protocol: { name: "acp", version: 1 },
  };
}
