import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "../src/session-manager.ts";
import { TranscriptReader } from "../src/persistence/transcript-reader.ts";
import type { TranscriptPresentationItem } from "../src/persistence/presentation.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentSession presentation persistence", () => {
  test("reloads the committed live message/activity interleaving with stable ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-presentation-"));
    roots.push(root);
    const manager = await SessionManager.open({ root });
    const session = await manager.createAgentSession({
      adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/presentation-agent.ts")] },
      adapterId: "presentation-fixture",
      agentSessionId: "presentation-agent",
      creationId: "presentation-create",
      persistence: { transcript: { preset: "activity" } },
    });
    const recorded: TranscriptPresentationItem[] = [];
    session.subscribe((notification) => {
      if (notification.event.kind === "presentation_recorded") recorded.push(notification.event.item);
    });

    try {
      const result = await session.prompt("show the order");
      expect(result.messages).toEqual([
        { messageId: "assistant-a", text: "A before tool" },
        { messageId: "assistant-b", text: "B after tool" },
      ]);
    } finally {
      await session.stop();
    }

    const page = await new TranscriptReader(join(root, "transcripts", "presentation-agent.jsonl"))
      .readPresentationPage({ limit: 20 });
    expect(page.items.map((item) => item.kind === "activity"
      ? [item.kind, item.activityId]
      : [item.kind, item.kind === "message" ? item.text : item.text]))
      .toEqual([
        ["message", "show the order"],
        ["message", "A before tool"],
        ["activity", "tool-1"],
        ["message", "B after tool"],
      ]);

    const finalLive = new Map(recorded.map((item) => [item.id, item]));
    expect(page.items.map((item) => finalLive.get(item.id))).toEqual(page.items);
    // Every revision reports when its item began: the first revision's time, live and on reload.
    for (const item of page.items) {
      expect(item.startedAt).toBe(recorded.find((live) => live.id === item.id)!.timestamp);
      expect(item.startedAt).toBeLessThanOrEqual(item.updatedAt);
      expect(item.timestamp).toBe(item.updatedAt);
    }
    const tool = page.items.find((item) => item.kind === "activity");
    expect(tool).toMatchObject({ revision: expect.any(Number), status: "completed" });
    expect(tool!.position).toBeLessThan(tool!.recordSequence);
  }, 20_000);
});
