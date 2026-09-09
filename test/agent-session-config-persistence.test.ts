import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession, type AgentSessionNotification } from "../src/agent-session.ts";
import { scanTranscriptContinuation } from "../src/persistence/transcript-scanner.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentSession persisted configuration", () => {
  test("serializes setConfig and checkpoints the selected restoration target", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-config-v2-"));
    roots.push(root);
    const session = await AgentSession.create({
      adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] },
      adapterId: "fake",
      agentSessionId: "config-agent-session",
      creationId: "config-incarnation",
      persistence: { root, transcript: { preset: "activity" } },
    });
    const notifications: AgentSessionNotification[] = [];
    session.subscribe((notification) => notifications.push(notification));

    expect(session.model).toBe("alpha");
    await session.setConfig("model", "beta");
    expect(session.model).toBe("beta");
    expect(session.state.phase).toBe("idle");
    await session.stop();

    const scan = await scanTranscriptContinuation(session.transcriptPath!);
    expect(scan.reduction.recovery).toEqual({ kind: "clean" });
    expect(scan.reduction.checkpoint.model).toBe("beta");
    expect(scan.reduction.checkpoint.sessionConfiguration.effective.model).toBe("beta");
    expect(scan.reduction.checkpoint.sessionConfiguration.restorationTargets).toMatchObject([
      { configId: "model", type: "select", value: "beta", ordinal: 0, source: "explicit_selection" },
    ]);

    const records = (await readFile(session.transcriptPath!, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.t === "operation").map((record) => [record.operationKind, record.event]))
      .toEqual([["set_config", "started"], ["set_config", "settled"]]);
    expect(records.filter((record) => record.t === "configuration")).toMatchObject([
      { event: "selected", configId: "model", value: "beta" },
    ]);
    const lifecycle = notifications.map((notification) => notification.event.kind)
      .filter((kind) => kind === "configuration_started" || kind === "configuration_completed");
    expect(lifecycle).toEqual(["configuration_started", "configuration_completed"]);
    expect(notifications.some((notification) =>
      notification.event.kind === "state_changed" && notification.event.state.phase === "configuring"))
      .toBe(true);
  }, 20_000);

  test("a rejected harness selection closes as failed without changing restoration state", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-config-v2-failure-"));
    roots.push(root);
    const session = await AgentSession.create({
      adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] },
      adapterId: "fake",
      agentSessionId: "config-failure-session",
      creationId: "config-failure-incarnation",
      persistence: { root, transcript: { preset: "activity" } },
    });

    await expect(session.setConfig("model", "reject")).rejects.toThrow("selection rejected");
    expect(session.model).toBe("alpha");
    await session.stop();

    const scan = await scanTranscriptContinuation(session.transcriptPath!);
    expect(scan.reduction.recovery).toEqual({ kind: "clean" });
    expect(scan.reduction.checkpoint.model).toBe("alpha");
    expect(scan.reduction.checkpoint.sessionConfiguration.restorationTargets).toEqual([]);
    const records = (await readFile(session.transcriptPath!, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.t === "operation").map((record) => record.event))
      .toEqual(["started", "failed"]);
  }, 20_000);
});
