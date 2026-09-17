import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentConversationId } from "../../src/agent-ids.ts";
import { ConversationCheckpointCoordinator } from "../../src/checkpointing/coordinator.ts";
import { resolveConversationCheckpointingConfig } from "../../src/checkpointing/config.ts";
import type {
  EnqueueInternalInferenceRequest,
  InternalInferenceEvent,
  InternalInferenceManager,
} from "../../src/internal-inference/contracts.ts";
import { SqliteAgentPersistence } from "../../src/persistence/sqlite-backend.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("conversation checkpoint coordinator", () => {
  test("enqueues milestone coverage without waiting for provider execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-checkpoint-coordinator-"));
    roots.push(root);
    const persistence = await SqliteAgentPersistence.open({ path: join(root, "agent.sqlite") });
    const conversationId = createAgentConversationId();
    await persistence.conversations.create({
      agentSessionId: persistence.identityRecord.agentSessionId,
      agentConversationId: conversationId,
    });
    await persistence.records.appendMany([
      {
        recordId: "turn-1:user", agentSessionId: persistence.identityRecord.agentSessionId,
        agentConversationId: conversationId, kind: "message", timestamp: new Date().toISOString(),
        role: "user", content: "hello", status: "completed", metadata: JSON.stringify({ operationId: "turn-1" }),
      },
      {
        recordId: "turn-1:assistant:1", agentSessionId: persistence.identityRecord.agentSessionId,
        agentConversationId: conversationId, kind: "message", timestamp: new Date().toISOString(),
        role: "assistant", content: "hi", status: "completed", metadata: JSON.stringify({ operationId: "turn-1" }),
      },
    ]);
    const manager = new CapturingManager();
    const coordinator = new ConversationCheckpointCoordinator(
      persistence,
      manager,
      resolveConversationCheckpointingConfig(),
    );

    await coordinator.afterSuccessfulResponse(conversationId);

    expect(manager.requests).toHaveLength(1);
    expect(manager.requests[0]).toMatchObject({
      purpose: "conversation_checkpoint",
      agentConversationId: conversationId,
      sourceFromSequence: 0,
      sourceThroughSequence: 2,
      requestedThroughSequence: 2,
    });
    coordinator.close();
    await persistence.close();
  });
});

class CapturingManager implements InternalInferenceManager {
  readonly requests: EnqueueInternalInferenceRequest[] = [];
  subscribe(_listener: (event: InternalInferenceEvent) => void) { return () => {}; }
  async enqueue(request: EnqueueInternalInferenceRequest) {
    this.requests.push(request);
    return {} as Awaited<ReturnType<InternalInferenceManager["enqueue"]>>;
  }
  async getAttempt() { return null; }
  async getRun() { return null; }
  async list() { return { attempts: [] }; }
  async cancel() {}
}
