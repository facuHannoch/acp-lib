import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentSession,
  AgentSessionPromptBlockedError,
  ContinuationUnavailableError,
  type AgentSessionNotification,
} from "../src/agent-session.ts";
import { scanTranscriptContinuation } from "../src/persistence/transcript-scanner.ts";
import { FileSessionLogWriter } from "../src/persistence/session-log-writer.ts";
import { migrateLegacyTranscript } from "../src/persistence/migration.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentSession persisted configuration", () => {
  test("ordinary open loads a provider thread from an explicitly migrated mixed transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-config-v1-migrated-"));
    roots.push(root);
    const agentSessionId = "config-migrated-session";
    const transcriptPath = join(root, "transcripts", `${agentSessionId}.jsonl`);
    await mkdir(join(root, "transcripts"), { recursive: true });
    await writeFile(transcriptPath, `${JSON.stringify({
      v: 1, t: "msg", role: "user", text: "legacy question", ts: Date.now() - 1_000,
    })}\n`);
    const now = new Date();
    await migrateLegacyTranscript({
      path: transcriptPath,
      agentSessionId,
      transcriptId: "config-migrated-transcript",
      incarnationId: "config-migrated-incarnation",
      continuation: {
        adapterId: "fake",
        mode: "normal",
        internalSessionId: "config-session",
        internalSessionActivatedAt: now.toISOString(),
        model: "alpha",
        sessionConfiguration: {
          adapterId: "fake",
          effective: {},
          restorationTargets: [],
          announcedConfigIds: [],
          schemaDigest: null,
          observedAt: now.toISOString(),
          restorationFidelity: "exact",
          omittedConfigIds: [],
        },
        protocol: { name: "acp", version: 1 },
      },
      now: () => now,
    });

    const opened = await AgentSession.open({
      adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] },
      adapterId: "fake",
      agentSessionId,
      persistence: { root },
    });
    expect(opened.continuation.outcome).toEqual({
      kind: "loaded",
      activeInternalSessionId: "config-session",
    });
    expect(opened.recovery).toEqual({ kind: "clean" });
    expect(opened.session.agentSessionId).toBe(agentSessionId);
    await opened.session.stop();
  }, 20_000);

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

  test("open loads transcript authority and reapplies restoration targets before returning", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-config-v2-open-"));
    roots.push(root);
    const adapter = { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] };
    const created = await AgentSession.create({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-open-session",
      creationId: "config-open-incarnation",
      persistence: { root, transcript: { preset: "activity" } },
    });
    await created.setConfig("model", "beta");
    // A thread is selected for a later open only once a turn has completed on it.
    await created.prompt("establish the recorded thread");
    const transcriptPath = created.transcriptPath!;
    await created.stop();

    const opened = await AgentSession.open({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-open-session",
      persistence: { root, transcript: { preset: "activity" } },
    });
    expect(opened.continuation.outcome).toEqual({
      kind: "loaded",
      activeInternalSessionId: "config-session",
    });
    expect(opened.continuation.recordedThreadAvailability).toBe("available");
    expect(opened.recovery).toEqual({ kind: "clean" });
    expect(opened.configuration).toEqual({ kind: "matched" });
    expect(opened.promptability).toEqual({ promptable: true, blockers: [] });
    expect(opened.session.model).toBe("beta");
    expect(opened.session.agentSessionId).toBe("config-open-session");
    await opened.session.stop();

    const scan = await scanTranscriptContinuation(transcriptPath);
    expect(scan.reduction.recovery).toEqual({ kind: "clean" });
    expect(scan.reduction.checkpoint.sessionConfiguration.restorationTargets).toMatchObject([
      { configId: "model", value: "beta", source: "explicit_selection" },
    ]);
    const records = (await readFile(transcriptPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.t === "configuration").map((record) => record.event))
      .toEqual(["selected", "restored"]);
  }, 20_000);

  test("open reports an unavailable recorded thread and releases transcript ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-config-v2-missing-"));
    roots.push(root);
    const adapter = { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] };
    const created = await AgentSession.create({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-missing-session",
      creationId: "config-missing-incarnation",
      persistence: { root },
    });
    await created.prompt("establish the recorded thread");
    await created.stop();

    let failure: unknown;
    try {
      await AgentSession.open({
        adapter,
        adapterId: "fake",
        agentSessionId: "config-missing-session",
        persistence: { root },
        env: { ...process.env, FAIL_LOAD: "1" } as Record<string, string>,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ContinuationUnavailableError);
    expect((failure as ContinuationUnavailableError).continuation).toMatchObject({
      recordedThreadAvailability: "unavailable",
      attempts: [{ strategy: "load_internal_session", status: "failed" }],
      outcome: { kind: "unavailable" },
    });

    const reopened = await AgentSession.open({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-missing-session",
      persistence: { root },
    });
    await reopened.session.stop();
  }, 20_000);

  test("ordered continuation falls back to a consumer reconstruction after load fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-config-v2-reconstruct-"));
    roots.push(root);
    const adapter = { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] };
    const created = await AgentSession.create({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-reconstruct-session",
      creationId: "config-reconstruct-incarnation",
      persistence: { root },
    });
    await created.setConfig("model", "beta");
    await created.prompt("establish the recorded thread");
    const transcriptPath = created.transcriptPath!;
    await created.stop();

    const opened = await AgentSession.open({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-reconstruct-session",
      persistence: { root },
      env: {
        ...process.env,
        FAIL_LOAD: "1",
        NEW_SESSION_ID: "reconstructed-session",
      } as Record<string, string>,
      continuation: {
        strategies: [
          { kind: "load_internal_session" },
          {
            kind: "new_from_consumer_continuation",
            continuationId: "consumer-summary-1",
            continuation: "Continue the persisted configuration test.",
          },
        ],
      },
    });
    expect(opened.continuation).toMatchObject({
      recordedThreadAvailability: "unavailable",
      attempts: [
        { strategy: "load_internal_session", status: "failed" },
        { strategy: "new_from_consumer_continuation", status: "succeeded" },
      ],
      outcome: {
        kind: "reconstructed",
        source: "consumer",
        activeInternalSessionId: "reconstructed-session",
      },
    });
    expect(opened.configuration).toEqual({ kind: "matched" });
    expect(opened.session.model).toBe("beta");
    expect(opened.promptability).toEqual({ promptable: true, blockers: [] });
    await opened.session.stop();

    const scan = await scanTranscriptContinuation(transcriptPath);
    expect(scan.reduction.checkpoint.internalSessionId).toBe("reconstructed-session");
    expect(scan.reduction.checkpoint.internalSessionHistoryRevision).toBe(1);
    expect(scan.reduction.internalSessionHistory).toMatchObject([{
      internalSessionId: "config-session",
      adapterId: "fake",
      sessionConfiguration: {
        restorationTargets: [{ configId: "model", value: "beta" }],
      },
      transition: { kind: "replacement" },
    }]);
    const records = (await readFile(transcriptPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.t === "transition").map((record) => [record.kind, record.event]))
      .toEqual([
        ["replacement", "started"],
        ["replacement", "target_created"],
        ["replacement", "target_activated"],
        ["replacement", "completed"],
      ]);
    expect(records.filter((record) => record.t === "operation").at(-2)).toMatchObject({
      operationKind: "switch_seed",
      event: "started",
    });
  }, 20_000);

  test("an explicit transcript builder reconstructs onto a different adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-config-v2-switch-"));
    roots.push(root);
    const adapter = { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] };
    const created = await AgentSession.create({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-switch-session",
      creationId: "config-switch-incarnation",
      persistence: { root },
    });
    await created.setConfig("model", "beta");
    await created.prompt("establish the recorded thread");
    const transcriptPath = created.transcriptPath!;
    await created.stop();

    let builderContext: { recordedAdapterId: string; targetAdapterId: string; transcriptPath: string } | null = null;
    const opened = await AgentSession.open({
      adapter,
      adapterId: "other",
      agentSessionId: "config-switch-session",
      persistence: { root },
      env: { ...process.env, NEW_SESSION_ID: "switched-session" } as Record<string, string>,
      continuation: {
        strategies: [{
          kind: "new_from_transcript",
          strategyId: "test-builder-v1",
          buildContinuation: async (context) => {
            builderContext = {
              recordedAdapterId: context.checkpoint.adapterId,
              targetAdapterId: context.targetAdapterId,
              transcriptPath: context.transcript.path,
            };
            return { continuation: "Continue from the transcript-backed test history." };
          },
        }],
      },
    });
    expect(builderContext).toEqual({
      recordedAdapterId: "fake",
      targetAdapterId: "other",
      transcriptPath,
    });
    expect(opened.continuation).toMatchObject({
      recordedThreadAvailability: "not_checked",
      attempts: [{ strategy: "new_from_transcript", status: "succeeded" }],
      outcome: {
        kind: "reconstructed",
        source: "transcript",
        activeInternalSessionId: "switched-session",
      },
    });
    // Configuration identifiers do not cross adapter boundaries without an explicit
    // mapping. The new adapter's announced default becomes effective instead.
    expect(opened.session.model).toBe("alpha");
    await opened.session.stop();

    const scan = await scanTranscriptContinuation(transcriptPath);
    expect(scan.reduction.checkpoint.adapterId).toBe("other");
    expect(scan.reduction.checkpoint.internalSessionId).toBe("switched-session");
    expect(scan.reduction.checkpoint.sessionConfiguration.restorationTargets).toEqual([]);
    expect(scan.reduction.internalSessionHistory.at(-1)).toMatchObject({
      internalSessionId: "config-session",
      adapterId: "fake",
      transition: { kind: "switch" },
    });
  }, 20_000);

  test("open returns an uncertain session but blocks provider mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-config-v2-uncertain-"));
    roots.push(root);
    const adapter = { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] };
    const created = await AgentSession.create({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-uncertain-session",
      creationId: "config-uncertain-incarnation",
      persistence: { root },
    });
    const transcriptPath = created.transcriptPath!;
    await created.stop();
    const scan = await scanTranscriptContinuation(transcriptPath);
    const { writer } = await FileSessionLogWriter.resumeTranscript({ path: transcriptPath });
    await writer.append({
      v: 2,
      t: "operation",
      transcriptId: scan.header.transcriptId,
      generation: scan.header.generation,
      agentSessionId: scan.header.agentSessionId,
      seq: writer.nextSequence,
      ts: Date.now(),
      operationId: "crashed-operation",
      operationKind: "prompt",
      event: "started",
      stateRevision: scan.reduction.checkpoint.stateRevision + 1,
    }, { durable: true });
    await writer.close();

    const opened = await AgentSession.open({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-uncertain-session",
      persistence: { root },
    });
    expect(opened.recovery).toMatchObject({
      kind: "uncertain",
      operationId: "crashed-operation",
    });
    expect(opened.promptability).toEqual({
      promptable: false,
      blockers: ["recovery_required"],
    });
    await expect(opened.session.prompt("must not dispatch"))
      .rejects.toBeInstanceOf(AgentSessionPromptBlockedError);
    const notifications: AgentSessionNotification[] = [];
    opened.session.subscribe((notification) => notifications.push(notification));
    const resolution = await opened.session.resolveRecovery({ strategy: "accept_harness_state" });
    expect(resolution).toMatchObject({
      previous: { kind: "uncertain", operationId: "crashed-operation" },
      recovery: { kind: "clean" },
    });
    expect(opened.session.promptability).toEqual({ promptable: true, blockers: [] });
    expect(notifications.some((notification) => notification.event.kind === "recovery_resolved")).toBe(true);
    await opened.session.stop();

    const reopened = await AgentSession.open({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-uncertain-session",
      persistence: { root },
    });
    expect(reopened.recovery).toEqual({ kind: "clean" });
    await reopened.session.stop();
  }, 20_000);

  test("recovery can explicitly replace the uncertain thread with supplied continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-config-v2-recovery-replace-"));
    roots.push(root);
    const adapter = { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] };
    const created = await AgentSession.create({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-recovery-replace-session",
      creationId: "config-recovery-replace-incarnation",
      persistence: { root },
    });
    await created.prompt("establish the recorded thread");
    const transcriptPath = created.transcriptPath!;
    await created.stop();
    const scan = await scanTranscriptContinuation(transcriptPath);
    const { writer } = await FileSessionLogWriter.resumeTranscript({ path: transcriptPath });
    await writer.append({
      v: 2,
      t: "operation",
      transcriptId: scan.header.transcriptId,
      generation: scan.header.generation,
      agentSessionId: scan.header.agentSessionId,
      seq: writer.nextSequence,
      ts: Date.now(),
      operationId: "uncertain-before-replacement",
      operationKind: "prompt",
      event: "started",
      stateRevision: scan.reduction.checkpoint.stateRevision + 1,
    }, { durable: true });
    await writer.close();

    const opened = await AgentSession.open({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-recovery-replace-session",
      persistence: { root },
      env: { ...process.env, NEW_SESSION_ID: "recovery-replacement" } as Record<string, string>,
    });
    const result = await opened.session.resolveRecovery({
      strategy: "start_new_internal_session",
      continuation: "Continue after the uncertain operation without repeating its side effects.",
    });
    expect(result).toMatchObject({
      previous: { kind: "uncertain", operationId: "uncertain-before-replacement" },
      recovery: { kind: "clean" },
      handoff: {
        fromInternalSessionId: "config-session",
        toInternalSessionId: "recovery-replacement",
      },
    });
    expect(opened.session.internalSessionId).toBe("recovery-replacement");
    expect(opened.session.promptability).toEqual({ promptable: true, blockers: [] });
    await opened.session.stop();

    const finalScan = await scanTranscriptContinuation(transcriptPath);
    expect(finalScan.reduction.recovery).toEqual({ kind: "clean" });
    expect(finalScan.reduction.checkpoint.internalSessionId).toBe("recovery-replacement");
    expect(finalScan.reduction.internalSessionHistory.at(-1)?.transition.kind).toBe("handoff");
  }, 20_000);

  test("a disappeared restoration target is reported and blocks prompting", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-config-v2-mismatch-"));
    roots.push(root);
    const adapter = { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] };
    const created = await AgentSession.create({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-mismatch-session",
      creationId: "config-mismatch-incarnation",
      persistence: { root },
    });
    await created.setConfig("model", "beta");
    await created.prompt("establish the recorded thread");
    await created.stop();

    const opened = await AgentSession.open({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-mismatch-session",
      persistence: { root },
      env: { ...process.env, OMIT_CONFIG: "1" } as Record<string, string>,
    });
    expect(opened.configuration).toEqual({
      kind: "mismatch",
      configIds: ["model"],
      reasons: ["configuration_option_missing"],
    });
    expect(opened.promptability).toEqual({
      promptable: false,
      blockers: ["configuration_mismatch"],
    });
    await expect(opened.session.prompt("must not dispatch"))
      .rejects.toBeInstanceOf(AgentSessionPromptBlockedError);
    await opened.session.stop();
  }, 20_000);

  test("accept_effective durably clears a mismatch without mutating the harness", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-config-v2-accept-"));
    roots.push(root);
    const adapter = { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] };
    const created = await AgentSession.create({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-accept-session",
      creationId: "config-accept-incarnation",
      persistence: { root },
    });
    await created.setConfig("model", "beta");
    await created.prompt("establish the recorded thread");
    const transcriptPath = created.transcriptPath!;
    await created.stop();
    const opened = await AgentSession.open({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-accept-session",
      persistence: { root },
      env: { ...process.env, OMIT_CONFIG: "1" } as Record<string, string>,
    });

    const result = await opened.session.resolveConfigurationMismatch({ strategy: "accept_effective" });
    expect(result).toEqual({ configuration: { kind: "matched" }, appliedConfigIds: [] });
    expect(opened.session.promptability).toEqual({ promptable: true, blockers: [] });
    await opened.session.stop();
    const scan = await scanTranscriptContinuation(transcriptPath);
    expect(scan.reduction.checkpoint.sessionConfiguration.restorationTargets).toEqual([]);
    const records = (await readFile(transcriptPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.t === "configuration").at(-1)?.event).toBe("resolved");
  }, 20_000);

  test("replacement resolution checkpoints every applied selection and replaces old targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-config-v2-replace-"));
    roots.push(root);
    const adapter = { command: ["bun", resolve(import.meta.dir, "fixtures/config-agent.ts")] };
    const created = await AgentSession.create({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-replace-session",
      creationId: "config-replace-incarnation",
      persistence: { root },
    });
    await created.setConfig("model", "beta");
    await created.prompt("establish the recorded thread");
    const transcriptPath = created.transcriptPath!;
    await created.stop();
    const opened = await AgentSession.open({
      adapter,
      adapterId: "fake",
      agentSessionId: "config-replace-session",
      persistence: { root },
      env: { ...process.env, REJECT_FIRST_LOADED_BETA: "1" } as Record<string, string>,
    });
    expect(opened.configuration.kind).toBe("mismatch");

    const result = await opened.session.resolveConfigurationMismatch({
      strategy: "replace_restoration_targets",
      selections: [{ configId: "model", value: "beta" }],
    });
    expect(result).toEqual({
      configuration: { kind: "matched" },
      appliedConfigIds: ["model"],
    });
    expect(opened.session.model).toBe("beta");
    expect(opened.session.promptability).toEqual({ promptable: true, blockers: [] });
    await opened.session.stop();

    const scan = await scanTranscriptContinuation(transcriptPath);
    expect(scan.reduction.checkpoint.sessionConfiguration.restorationTargets).toMatchObject([
      { configId: "model", value: "beta", ordinal: 0, source: "explicit_selection" },
    ]);
    const records = (await readFile(transcriptPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.t === "operation").map((record) => record.event))
      // setConfig, the turn that records the thread, the rejected reload, and the replacement.
      .toEqual(["started", "settled", "started", "settled", "started", "failed", "started", "settled"]);
    expect(records.filter((record) => record.t === "configuration").map((record) => record.event))
      .toEqual(["selected", "selected", "resolved"]);
  }, 20_000);
});
