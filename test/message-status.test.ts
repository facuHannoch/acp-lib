import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../src/index.ts";
import { MessageStatusTracker, type MessageStatusEvent } from "../src/message-status.ts";
import { nativeRig, reply } from "./native/support.ts";

const ECHO = resolve(import.meta.dir, "fixtures/echo-prompt-agent.ts");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean().catch(() => undefined);
});

describe("MessageStatusTracker", () => {
  test("moves forward only, reports skipped steps in order, and ignores ids it never accepted", () => {
    const events: MessageStatusEvent[] = [];
    const tracker = new MessageStatusTracker((event) => events.push(event));
    tracker.accept("m1");
    tracker.link("t1", ["m1", "notice-1"]);
    tracker.advance("m1", "delivered");
    tracker.advance("m1", "received");
    tracker.advance("notice-1", "seen");
    tracker.end("m1", "withdrawn");
    expect(events.map((e) => e.status)).toEqual(["queued", "received", "taken", "delivered"]);
    expect(events.at(-1)).toEqual({ kind: "message_status", id: "m1", status: "delivered", turnId: "t1" });
    expect(tracker.statusOf("notice-1")).toBeUndefined();
  });

  test("withdrawn only before a take; failed only before seen", () => {
    const tracker = new MessageStatusTracker(() => {});
    tracker.accept("a");
    tracker.end("a", "withdrawn");
    expect(tracker.statusOf("a")).toBe("withdrawn");
    tracker.advance("a", "seen");
    expect(tracker.statusOf("a")).toBe("withdrawn");
    tracker.accept("b");
    tracker.advance("b", "seen");
    tracker.end("b", "failed");
    expect(tracker.statusOf("b")).toBe("seen");
    tracker.accept("c");
    tracker.advance("c", "taken");
    tracker.end("c", "failed");
    expect(tracker.statusOf("c")).toBe("failed");
  });
});

describe("message status on conversations", () => {
  test("ACP: queued → received → taken → delivered at send, seen at the first output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-status-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { echo: { command: ["bun", ECHO] } },
      defaultAdapterId: "echo",
      conversationDefaults: { metering: { pricing: false } },
    });
    cleanups.push(() => agent.close());
    const conversation = await agent.conversations.create();
    const seen: MessageStatusEvent[] = [];
    conversation.subscribe(({ event }) => { if (event.kind === "message_status") seen.push(event); });
    const handle = conversation.prompt("hello");
    const result = await handle;
    expect(result.status).toBe("completed");
    const mine = seen.filter((e) => e.id === handle.id).map((e) => e.status);
    expect(mine).toEqual(["queued", "received", "taken", "delivered", "seen"]);
    expect(handle.status).toBe("seen");
  }, 30_000);

  test("native: the same sequence from the harness's milestones", async () => {
    const rig = await nativeRig();
    cleanups.push(() => rig.clean());
    rig.script([reply("Done.")]);
    const agent = await rig.open();
    const conversation = await agent.conversations.create();
    const seen: MessageStatusEvent[] = [];
    conversation.subscribe(({ event }) => { if (event.kind === "message_status") seen.push(event); });
    const handle = conversation.prompt("hello");
    await handle;
    const mine = seen.filter((e) => e.id === handle.id).map((e) => e.status);
    expect(mine).toEqual(["queued", "received", "taken", "delivered", "seen"]);
    expect(handle.status).toBe("seen");
  }, 30_000);

  test("a message withdrawn while it waits ends withdrawn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-status-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { echo: { command: ["bun", ECHO] } },
      defaultAdapterId: "echo",
      conversationDefaults: { metering: { pricing: false } },
    });
    cleanups.push(() => agent.close());
    const conversation = await agent.conversations.create();
    const first = conversation.prompt("one");
    const second = conversation.prompt({ text: "two", delivery: "queue" });
    expect(second.withdraw()).toBe(true);
    await Promise.allSettled([first, second]);
    expect(second.status).toBe("withdrawn");
    expect(first.status).toBe("seen");
  }, 30_000);
});
