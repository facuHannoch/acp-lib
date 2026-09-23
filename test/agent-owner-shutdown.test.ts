import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, type AgentIdentityRuntime } from "../src/index.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures/stalling-prompt-agent.ts");
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("Agent owner shutdown", () => {
  test("stopping mid-prompt waits for finalization before the owner closes SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-agent-stop-active-"));
    directories.push(directory);
    let signalChunk!: () => void;
    const sawChunk = new Promise<void>((resolve) => { signalChunk = resolve; });
    let signalFinalization!: () => void;
    const finalizationStarted = new Promise<void>((resolve) => { signalFinalization = resolve; });
    let releaseFinalization!: () => void;
    const finalizationGate = new Promise<void>((resolve) => { releaseFinalization = resolve; });
    const identity: AgentIdentityRuntime = {
      async load() { return {}; },
      async update(input) {
        if (input.records.some((record) => record.kind === "message" && record.role === "assistant")) {
          signalFinalization();
          await finalizationGate;
        }
      },
    };
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { fixture: { command: ["bun", FIXTURE] } },
      defaultAdapterId: "fixture",
      identity,
    });
    const conversation = await agent.conversations.create();
    let backendClosed = false;
    const originalClose = agent.persistence.close.bind(agent.persistence);
    (agent.persistence as { close: () => Promise<void> }).close = async () => {
      backendClosed = true;
      await originalClose();
    };
    const prompt = conversation.prompt({
      text: "stop during this response",
      handlers: { onResponseChunk: () => signalChunk() },
    }).then(() => "completed", () => "failed");
    await sawChunk;

    const firstStop = conversation.stop();
    const secondStop = conversation.stop();
    expect(secondStop).toBe(firstStop);
    let stopped = false;
    void firstStop.then(() => { stopped = true; }, () => { stopped = true; });
    const closing = agent.close();
    try {
      await finalizationStarted;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stopped).toBe(false);
      expect(backendClosed).toBe(false);
    } finally {
      releaseFinalization();
    }
    await Promise.all([firstStop, secondStop, closing]);
    expect(await prompt).toBe("failed");
    expect(backendClosed).toBe(true);
  }, 20_000);
});
