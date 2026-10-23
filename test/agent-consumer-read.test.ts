import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Agent,
  reconcileConversationTimeline,
  type ConversationRecord,
  type ConversationTimelineItem,
  type NewConversationRecord,
} from "../src/index.ts";

const FIXTURE = resolve(import.meta.dir, "../smoke-tests/test5-operations/operations-agent.ts");
const PRESENTATION_FIXTURE = resolve(import.meta.dir, "fixtures/presentation-agent.ts");
const agents: Agent[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Agent consumer transcript workflow", () => {
  test("reloads assistant messages at their first streamed position around tool activity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-consumer-interleaving-"));
    directories.push(directory);
    const path = join(directory, "agent.sqlite");
    const configuration = {
      persistence: { kind: "sqlite" as const, path },
      adapters: { fixture: { command: ["bun", PRESENTATION_FIXTURE] } },
      defaultAdapterId: "fixture",
    };
    const agent = await Agent.open(configuration);
    agents.push(agent);
    const conversation = await agent.conversations.create();
    const result = await conversation.prompt("show the order");
    expect(result.messages.map((message) => message.text)).toEqual(["A before tool", "B after tool"]);

    await agent.close();
    agents.splice(agents.indexOf(agent), 1);
    const reopened = await Agent.open(configuration);
    agents.push(reopened);
    const records = (await reopened.persistence.records.list(conversation.id, { limit: 100 })).records;
    // Every record of the turn, its tool call included, says which operation it belongs to.
    const turnRecords = records.filter((record) => ["message", "tool_call", "thinking"].includes(record.kind));
    expect(turnRecords.length).toBeGreaterThan(3);
    expect(new Set(turnRecords.map((record) => record.operationId))).toEqual(new Set([result.operationId]));
    const byOperation = (await reopened.persistence.records.list(conversation.id, { operationId: result.operationId })).records;
    expect(byOperation.map((record) => record.recordId)).toEqual(
      records.filter((record) => record.operationId === result.operationId).map((record) => record.recordId),
    );
    const items = reconcileConversationTimeline([], records)
      .filter((item) => item.kind === "message" || item.kind === "tool_call");
    expect(items.map((item) => item.kind === "message"
      ? [item.kind, item.current.content]
      : [item.kind, item.current.toolCallId])).toEqual([
      ["message", "show the order"],
      ["message", "A before tool"],
      ["tool_call", "tool-1"],
      ["message", "B after tool"],
    ]);
    expect(items[1]?.revisions.length).toBeGreaterThan(1);
    expect(items[1]?.firstSequence).toBeLessThan(items[2]!.firstSequence);
    expect(items[1]?.current).toMatchObject({ status: "completed", logicalMessageId: `message:${result.operationId}:assistant:1` });
    // A message's time is when it began; its last revision's time is kept separately.
    expect(items[1]).toMatchObject({
      startedAt: items[1]!.revisions[0]!.timestamp,
      updatedAt: items[1]!.revisions.at(-1)!.timestamp,
    });
    expect(items[1]!.current.timestamp).toBe(items[1]!.updatedAt);
    // A is recorded completed when the tool call begins, not when the turn ends.
    const aCompleted = items[1]!.revisions.find((revision) => revision.kind === "message" && revision.status === "completed")!;
    expect(aCompleted.sequence).toBeLessThan(items[2]!.firstSequence);
    expect(items[1]!.updatedAt <= items[3]!.startedAt).toBe(true);
    const firstAssistantSequence = items[1]!.firstSequence;
    expect((await reopened.persistence.messages.list(conversation.id, {
      throughSequence: firstAssistantSequence,
    })).messages.at(-1)).toMatchObject({ content: "A", status: "in_progress" });
    expect((await reopened.persistence.messages.list(conversation.id, {
      afterSequence: firstAssistantSequence,
    })).messages.map((message) => message.content)).toEqual(["A before tool", "B after tool"]);
    expect((await reopened.persistence.messages.list(conversation.id)).messages.map((message) => message.content))
      .toEqual(["show the order", "A before tool", "B after tool"]);
  }, 20_000);

  test("a tool call ends the message before it when the agent sends no message ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-consumer-no-ids-"));
    directories.push(directory);
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { fixture: { command: ["bun", PRESENTATION_FIXTURE, "no-ids"] } },
      defaultAdapterId: "fixture",
    });
    agents.push(agent);
    const conversation = await agent.conversations.create();
    const result = await conversation.prompt("show the order");
    expect(result.messages.map((message) => message.text)).toEqual(["A before tool", "B after tool"]);

    const records = (await agent.persistence.records.list(conversation.id, { limit: 100 })).records;
    const items = reconcileConversationTimeline([], records)
      .filter((item) => item.kind === "message" || item.kind === "tool_call");
    expect(items.map((item) => item.kind === "message"
      ? [item.kind, item.current.content, item.current.status]
      : [item.kind, item.current.toolCallId])).toEqual([
      ["message", "show the order", "completed"],
      ["message", "A before tool", "completed"],
      ["tool_call", "tool-1"],
      ["message", "B after tool", "completed"],
    ]);
  }, 20_000);

  test("a tool still running when its turn ends is recorded failed there; its next-turn update belongs to that turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-consumer-late-tool-"));
    directories.push(directory);
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { fixture: { command: ["bun", PRESENTATION_FIXTURE, "late-tool"] } },
      defaultAdapterId: "fixture",
    });
    agents.push(agent);
    const conversation = await agent.conversations.create();
    const first = await conversation.prompt("start the build");
    const second = await conversation.prompt("is it done?");

    const records = (await agent.persistence.records.list(conversation.id, { limit: 100 })).records;
    const tools = records.filter((record) => record.kind === "tool_call")
      .map((record) => [record.operationId, record.kind === "tool_call" ? record.state : null]);
    expect(tools).toEqual([
      [first.operationId, "announced"],
      [first.operationId, "failed"],
      [second.operationId, "completed"],
    ]);
    const items = reconcileConversationTimeline([], records).filter((item) => item.kind === "tool_call");
    expect(items.map((item) => item.current.kind === "tool_call" ? item.current.state : null)).toEqual(["failed", "completed"]);
  }, 20_000);

  test("a turn that fails keeps the message that ended before the failure completed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-consumer-fails-"));
    directories.push(directory);
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { fixture: { command: ["bun", PRESENTATION_FIXTURE, "fails"] } },
      defaultAdapterId: "fixture",
    });
    agents.push(agent);
    const conversation = await agent.conversations.create();
    await expect(conversation.prompt("show the order")).rejects.toThrow("model overloaded");

    const messages = (await agent.persistence.messages.list(conversation.id)).messages;
    expect(messages.map((message) => [message.content, message.status])).toEqual([
      ["show the order", "completed"],
      ["A before tool", "completed"],
      ["B after tool", "failed"],
    ]);
  }, 20_000);

  test("pages history by agent messages as folded summaries that merge with the full step", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-consumer-paging-"));
    directories.push(directory);
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { fixture: { command: ["bun", PRESENTATION_FIXTURE] } },
      defaultAdapterId: "fixture",
      capture: { tool_call: "content" },
    });
    agents.push(agent);
    const conversation = await agent.conversations.create();
    await conversation.prompt("first turn");
    await conversation.prompt("second turn");

    // Two agent messages: the second turn, beginning with its prompt.
    const page = await agent.persistence.records.listRecent!(conversation.id, {
      agentMessages: 2, fold: true, detail: "summary", kinds: ["message", "tool_call"],
    });
    expect(page.items.map((item) => item.current.kind === "message" ? item.current.content : item.current.kind))
      .toEqual(["second turn", "A before tool", "tool_call", "B after tool"]);
    const message = page.items[1]!;
    expect(message.revisions.length).toBe(2);
    expect(message.current).toMatchObject({ status: "completed" });
    const step = page.items[2]!;
    expect(step.current).toMatchObject({ kind: "tool_call", state: "completed" });
    expect("input" in step.current || "output" in step.current).toBe(false);
    const [expanded] = reconcileConversationTimeline([step], [(await agent.persistence.records.get(step.current.recordId))!]);
    expect(expanded!.current).toMatchObject({ input: { path: "a.txt" } });
    expect(JSON.stringify((expanded!.current as { output?: unknown }).output)).toContain("contents of a.txt");

    const older = await agent.persistence.records.listRecent!(conversation.id, {
      agentMessages: 2, fold: true, detail: "summary", kinds: ["message", "tool_call"], olderCursor: page.olderCursor,
    });
    expect(older.items.map((item) => item.current.kind === "message" ? item.current.content : item.current.kind))
      .toEqual(["first turn", "A before tool", "tool_call", "B after tool"]);
    expect(older.olderCursor).toBeUndefined();
  }, 20_000);

  test("round-trips sender metadata, recent history, live catch-up, and previews", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-consumer-read-"));
    directories.push(directory);
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { fixture: { command: ["bun", FIXTURE, "consumer-read"] } },
      defaultAdapterId: "fixture",
    });
    agents.push(agent);
    const conversation = await agent.conversations.create({
      participants: [{ id: "human-1", kind: "user", name: "Human" }],
    });
    const reply = await conversation.promptFrom({
      participantId: "human-1",
      text: "Please check the file",
      consumerMetadata: { deliveryId: "delivery-1", submittedBy: "relay" },
    });
    expect(reply.status).toBe("completed");
    const messages = (await agent.persistence.messages.list(conversation.id)).messages;
    expect(messages[0]).toMatchObject({
      role: "user", participantId: "human-1",
      consumerMetadata: { deliveryId: "delivery-1", submittedBy: "relay" },
    });

    const append = async (record: Omit<NewConversationRecord, "agentSessionId" | "agentConversationId" | "timestamp">) =>
      await agent.persistence.records.append({
        ...record,
        agentSessionId: agent.id,
        agentConversationId: conversation.id,
        timestamp: new Date().toISOString(),
      } as NewConversationRecord);
    await append({ recordId: "tool-announced", kind: "tool_call", toolCallId: "tool-1", state: "announced", name: "read_file" });
    await append({ recordId: "tool-completed", kind: "tool_call", toolCallId: "tool-1", state: "completed", output: "found it" });
    await append({ recordId: "permission-request", kind: "permission", permissionId: "permission-1", state: "requested" });
    await append({ recordId: "permission-resolved", kind: "permission", permissionId: "permission-1", state: "resolved", outcome: "approved" });
    await append({ recordId: "thinking-1", kind: "thinking", thinkingId: "thought-1", state: "completed", content: "checking" });
    await append({ recordId: "activity-1", kind: "activity", activityId: "activity-1", activityType: "file_edit", state: "completed" });
    await append({ recordId: "action-1", kind: "native_action", action: "switch", transitionId: "transition-1", state: "completed" });
    await append({ recordId: "metering-1", kind: "metering", operationId: "op-1", meteringRecordId: "meter-1", status: "available" });

    const all: ConversationRecord[] = [];
    let items: readonly ConversationTimelineItem[] = [];
    let olderCursor: string | undefined;
    let snapshotSequence = 0;
    do {
      const page = await agent.persistence.records.listRecent!(conversation.id, { limit: 3, ...(olderCursor ? { olderCursor } : {}) });
      snapshotSequence = page.snapshotSequence;
      all.unshift(...page.records);
      items = reconcileConversationTimeline(items, page.records);
      olderCursor = page.olderCursor;
    } while (olderCursor);
    expect(all.map((record) => record.sequence)).toEqual([...all.map((record) => record.sequence)].sort((a, b) => a - b));
    expect(all.find((record) => record.recordId === "tool-completed")).toMatchObject({ toolCallId: "tool-1", state: "completed" });
    expect(all.find((record) => record.recordId === "permission-resolved")).toMatchObject({ permissionId: "permission-1", outcome: "approved" });
    expect(new Set(all.map((record) => record.recordId)).size).toBe(all.length);
    expect(items.filter((item) => item.kind === "tool_call")).toHaveLength(1);
    expect(items.find((item) => item.kind === "tool_call")?.revisions).toHaveLength(2);
    expect(items.find((item) => item.kind === "tool_call")?.current).toMatchObject({
      name: "read_file", state: "completed", output: "found it",
    });
    expect(items.find((item) => item.kind === "permission")?.current).toMatchObject({
      state: "resolved", outcome: "approved",
    });

    await append({ recordId: "late-message", kind: "message", role: "assistant", content: "Done" });
    const catchUp = await agent.persistence.records.list(conversation.id, { afterSequence: snapshotSequence });
    expect(catchUp.records.map((record) => record.recordId)).toEqual(["late-message"]);
    items = reconcileConversationTimeline(items, catchUp.records);
    expect(items.at(-1)?.current).toMatchObject({ recordId: "late-message", content: "Done" });
    const preview = (await agent.conversations.listPreviews()).previews.find(
      (item) => item.conversation.agentConversationId === conversation.id,
    );
    expect(preview?.latestMessage).toMatchObject({ recordId: "late-message", text: "Done" });
    expect(preview?.lastHumanMessageAt).toBe(messages[0]?.timestamp);
  });
});
