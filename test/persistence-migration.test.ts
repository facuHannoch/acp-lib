import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StagedContinuationState } from "../src/persistence/registry.ts";
import {
  LegacyTranscriptMigrationError,
  migrateLegacyTranscript,
} from "../src/persistence/migration.ts";

const roots: string[] = [];
const NOW = new Date("2026-09-09T16:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy transcript migration", () => {
  test("retains the permissive v1 prefix and appends a canonical v2 authority boundary", async () => {
    const path = await legacyFixture(true);
    const original = await readFile(path);
    const lastNewline = original.lastIndexOf(0x0a);
    const expectedPrefix = original.subarray(0, lastNewline + 1);
    const result = await migrateLegacyTranscript(options(path));

    expect(result.status).toBe("migrated");
    expect(result.legacyBoundaryOffset).toBe(expectedPrefix.byteLength);
    expect(result.header).toMatchObject({
      v: 2,
      t: "header",
      event: "upgraded",
      seq: 1,
      transcriptId: "transcript-migration-1",
      agentSessionId: "agent-1",
      upgradedFrom: { version: 1, boundaryOffset: expectedPrefix.byteLength },
    });
    expect(result.checkpoint).toMatchObject({
      incarnationId: "incarnation-migration-1",
      stateRevision: 1,
      adapterId: "opencode",
      internalSessionId: "provider-1",
      internalSessionHistoryRevision: 0,
      boundary: { status: "settled", lastSettledOperationId: null },
      transcript: { transcriptId: "transcript-migration-1", generation: 1, coveredSequence: 1 },
    });

    const migrated = await readFile(path);
    expect(migrated.subarray(0, expectedPrefix.byteLength)).toEqual(expectedPrefix);
    expect(migrated.toString("utf8")).not.toContain("torn-final-line");
    const suffix = migrated.subarray(expectedPrefix.byteLength).toString("utf8").trim().split("\n").map(JSON.parse);
    expect(suffix.map((record) => [record.v, record.t, record.seq])).toEqual([
      [2, "header", 1],
      [2, "checkpoint", 2],
    ]);
  });

  test("an identical retry is mutation-idempotent and a conflicting seed is rejected", async () => {
    const path = await legacyFixture(false);
    const first = await migrateLegacyTranscript(options(path));
    const bytes = await readFile(path);
    const retry = await migrateLegacyTranscript(options(path));
    expect(retry.status).toBe("already_migrated");
    expect(retry.checkpoint.digest).toBe(first.checkpoint.digest);
    expect(await readFile(path)).toEqual(bytes);

    await expect(migrateLegacyTranscript({
      ...options(path),
      continuation: { ...continuation(), model: "different-model" },
    })).rejects.toBeInstanceOf(LegacyTranscriptMigrationError);
    expect(await readFile(path)).toEqual(bytes);
  });

  test("resumes an upgrade header whose initial checkpoint was not installed", async () => {
    const path = await legacyFixture(false);
    const first = await migrateLegacyTranscript(options(path));
    const content = await readFile(path);
    const checkpointNeedle = Buffer.from('{"v":2,"t":"checkpoint"');
    const checkpointOffset = content.indexOf(checkpointNeedle);
    expect(checkpointOffset).toBeGreaterThan(first.legacyBoundaryOffset);
    await truncate(path, checkpointOffset);

    const resumed = await migrateLegacyTranscript(options(path));
    expect(resumed.status).toBe("resumed");
    expect(resumed.checkpoint.digest).toBe(first.checkpoint.digest);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines.filter((line) => line.includes('"v":2')).length).toBe(2);
  });

  test("refuses unrelated v2 content instead of treating it as legacy presentation", async () => {
    const path = await legacyFixture(false);
    await writeFile(path, `${JSON.stringify({ v: 2, t: "message", text: "not an upgrade" })}\n`);
    await expect(migrateLegacyTranscript(options(path)))
      .rejects.toBeInstanceOf(LegacyTranscriptMigrationError);
  });
});

async function legacyFixture(torn: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acp-legacy-migration-"));
  roots.push(root);
  const path = join(root, "legacy.jsonl");
  const records = [
    JSON.stringify({ v: 1, t: "meta", event: "open", ts: 1, internalSessionId: "provider-old" }),
    "{malformed legacy line",
    JSON.stringify({ v: 1, t: "msg", role: "user", text: "hello", ts: 2 }),
    JSON.stringify({ v: 1, t: "future", ts: 3, value: true }),
  ];
  await writeFile(path, `${records.join("\n")}\n${torn ? "torn-final-line" : ""}`);
  return path;
}

function options(path: string) {
  return {
    path,
    agentSessionId: "agent-1",
    transcriptId: "transcript-migration-1",
    incarnationId: "incarnation-migration-1",
    continuation: continuation(),
    now: () => NOW,
  } as const;
}

function continuation(): StagedContinuationState {
  return {
    adapterId: "opencode",
    mode: "normal",
    internalSessionId: "provider-1",
    internalSessionActivatedAt: NOW.toISOString(),
    model: "anthropic/claude-sonnet-4-5",
    sessionConfiguration: {
      adapterId: "opencode",
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
