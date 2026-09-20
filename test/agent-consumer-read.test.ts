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
const agents: Agent[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.close()));
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Agent consumer transcript workflow", () => {
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
