import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDirectPersistence } from "../src/persistence/config.ts";
import { resolveSessionLogPaths } from "../src/persistence/paths.ts";

describe("session-log path resolution", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "acp-persistence-paths-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("omitted paths use separate transcript and audit directories", async () => {
    const persistence = resolved({ root, transcript: {}, auditLog: {} });
    expect(await resolveSessionLogPaths(persistence, "agent/session:1")).toEqual({
      transcriptPath: join(root, "transcripts", "agent%2Fsession%3A1.jsonl"),
      auditLogPath: join(root, "audit-logs", "agent%2Fsession%3A1.jsonl"),
    });
  });

  test("an existing directory derives the logical-session filename", async () => {
    const transcripts = join(root, "chosen");
    await mkdir(transcripts);
    const persistence = resolved({ root, transcript: { path: transcripts } });
    expect((await resolveSessionLogPaths(persistence, "agent/1")).transcriptPath)
      .toBe(join(transcripts, "agent%2F1.jsonl"));
  });

  test("an existing regular file and a nonexistent path are exact destinations", async () => {
    const existing = join(root, "existing.data");
    const missing = join(root, "missing.data");
    await writeFile(existing, "");

    expect((await resolveSessionLogPaths(
      resolved({ root, transcript: { path: existing } }),
      "agent",
    )).transcriptPath).toBe(existing);
    expect((await resolveSessionLogPaths(
      resolved({ root, transcript: { path: missing } }),
      "agent",
    )).transcriptPath).toBe(missing);
  });

  test("relative and tilde paths normalize before classification", async () => {
    const relativeDir = join(root, "relative");
    const homeDir = join(root, "home");
    await mkdir(relativeDir);
    await mkdir(join(homeDir, "logs"), { recursive: true });
    const environment = { env: {}, cwd: root, home: homeDir } as const;

    const relative = resolved({ root, transcript: { path: "relative" } }, environment);
    expect((await resolveSessionLogPaths(relative, "a", environment)).transcriptPath)
      .toBe(join(relativeDir, "a.jsonl"));

    const home = resolved({ root, transcript: { path: "~/logs" } }, environment);
    expect((await resolveSessionLogPaths(home, "a", environment)).transcriptPath)
      .toBe(join(homeDir, "logs", "a.jsonl"));
  });

  test("rejects direct and ancestor symbolic links", async () => {
    const realDir = join(root, "real");
    const linkedDir = join(root, "linked");
    await mkdir(realDir);
    await symlink(realDir, linkedDir);

    await expect(resolveSessionLogPaths(
      resolved({ root, transcript: { path: linkedDir } }),
      "agent",
    )).rejects.toThrow("symbolic link");
    await expect(resolveSessionLogPaths(
      resolved({ root, transcript: { path: join(linkedDir, "new.jsonl") } }),
      "agent",
    )).rejects.toThrow("symbolic link");
  });

  test("rejects transcript/audit aliases by normalized path or file identity", async () => {
    const same = join(root, "same.jsonl");
    await expect(resolveSessionLogPaths(
      resolved({ root, transcript: { path: same }, auditLog: { path: same } }),
      "agent",
    )).rejects.toThrow("different files");

    const first = join(root, "first.jsonl");
    const second = join(root, "second.jsonl");
    await writeFile(first, "");
    await link(first, second);
    await expect(resolveSessionLogPaths(
      resolved({ root, transcript: { path: first }, auditLog: { path: second } }),
      "agent",
    )).rejects.toThrow("different files");
  });

  test("disabled logs resolve to null and no filesystem object is created", async () => {
    const persistence = resolved({ root, transcript: false, auditLog: false });
    expect(await resolveSessionLogPaths(persistence, "agent")).toEqual({
      transcriptPath: null,
      auditLogPath: null,
    });
  });
});

function resolved(
  options: Parameters<typeof resolveDirectPersistence>[0],
  environment = { env: {}, cwd: "/", home: "/home/tester" } as const,
) {
  const result = resolveDirectPersistence(options, environment);
  if (result === false) throw new Error("test requires enabled persistence configuration");
  return result;
}
