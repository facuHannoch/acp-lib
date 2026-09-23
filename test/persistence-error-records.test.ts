import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONVERSATION_ERROR_CODES,
  SqliteAgentPersistence,
  buildConversationErrorDetails,
  createAgentConversationId,
  createAgentSessionId,
  resolveConversationRecordCapture,
  sanitizeConversationErrorMessage,
} from "../src/index.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.allSettled(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("conversation error record model", () => {
  test("exports the initial library codes", () => {
    expect(CONVERSATION_ERROR_CODES).toContain("provider_session_missing");
    expect(CONVERSATION_ERROR_CODES).toContain("provider_session_load_failed");
    expect(CONVERSATION_ERROR_CODES).toContain("unknown");
  });

  test("sanitizes a display message to one bounded line", () => {
    expect(sanitizeConversationErrorMessage("The session could not be loaded.\n    at stack")).toBe(
      "The session could not be loaded.",
    );
    expect(sanitizeConversationErrorMessage(new Error("boom"))).toBe("boom");
    expect(sanitizeConversationErrorMessage("   \n  ")).toBeUndefined();
    expect(sanitizeConversationErrorMessage(42)).toBeUndefined();
    expect(sanitizeConversationErrorMessage("x".repeat(1_000))?.length).toBe(512);
  });

  test("builds details from allow-listed fields only", () => {
    const input = {
      providerCode: "E_MISSING",
      rpcCode: -32_000,
      service: "acp",
      exitCode: 1,
      signal: "SIGTERM",
      transportState: "closed",
      secret: "must not survive",
    };
    expect(buildConversationErrorDetails(input)).toEqual({
      providerCode: "E_MISSING",
      rpcCode: -32_000,
      service: "acp",
      exitCode: 1,
      signal: "SIGTERM",
      transportState: "closed",
    });
    expect(buildConversationErrorDetails({})).toBeUndefined();
    expect(buildConversationErrorDetails({ rpcCode: 1.5 })).toBeUndefined();
    expect(buildConversationErrorDetails({ service: "   " })).toBeUndefined();
  });

  test("resolves error capture with a content default", () => {
    expect(resolveConversationRecordCapture({}).error).toBe("content");
    expect(resolveConversationRecordCapture({ error: "metadata" }).error).toBe("metadata");
    expect(resolveConversationRecordCapture({ error: "none" }).error).toBe("none");
    expect(() => resolveConversationRecordCapture({ error: "nonsense" as never })).toThrow(
      /invalid capture level/,
    );
  });

  test("round-trips every error field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-error-records-"));
    directories.push(directory);
    const backend = await SqliteAgentPersistence.open({
      path: join(directory, "agent.sqlite"),
      agentSessionId: createAgentSessionId(),
    });
    try {
      const conversationId = createAgentConversationId();
      await backend.conversations.create({
        agentSessionId: backend.identityRecord.agentSessionId,
        agentConversationId: conversationId,
      });
      await backend.records.append({
        recordId: "provider-load-1:error",
        agentSessionId: backend.identityRecord.agentSessionId,
        agentConversationId: conversationId,
        kind: "error",
        timestamp: "2026-09-23T00:00:00.000Z",
        source: "provider_session",
        code: "provider_session_missing",
        recoverability: "recoverable",
        message: "The provider session could not be loaded.",
        operationId: "provider-load-1",
        transitionId: "provider-load-1",
        internalSessionId: "thread-abc",
        details: { rpcCode: -32_001, service: "acp", transportState: "closed" },
      });

      const stored = (await backend.records.list(conversationId, { kinds: ["error"] })).records;
      expect(stored).toHaveLength(1);
      expect(stored[0]).toEqual({
        recordId: "provider-load-1:error",
        agentSessionId: backend.identityRecord.agentSessionId,
        agentConversationId: conversationId,
        sequence: 1,
        kind: "error",
        timestamp: "2026-09-23T00:00:00.000Z",
        source: "provider_session",
        code: "provider_session_missing",
        recoverability: "recoverable",
        message: "The provider session could not be loaded.",
        operationId: "provider-load-1",
        transitionId: "provider-load-1",
        internalSessionId: "thread-abc",
        details: { rpcCode: -32_001, service: "acp", transportState: "closed" },
      });

      // Error records are operational history, not full-text-searchable content.
      expect(await backend.search!.search({ text: "could not be loaded" })).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  test("re-appending the same error record is idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-error-idempotent-"));
    directories.push(directory);
    const backend = await SqliteAgentPersistence.open({
      path: join(directory, "agent.sqlite"),
      agentSessionId: createAgentSessionId(),
    });
    try {
      const conversationId = createAgentConversationId();
      await backend.conversations.create({
        agentSessionId: backend.identityRecord.agentSessionId,
        agentConversationId: conversationId,
      });
      const record = {
        recordId: "provider-load-idem:error",
        agentSessionId: backend.identityRecord.agentSessionId,
        agentConversationId: conversationId,
        kind: "error" as const,
        timestamp: "2026-09-23T00:00:00.000Z",
        source: "provider_session" as const,
        code: "provider_session_missing",
        recoverability: "recoverable" as const,
        message: "The provider session could not be loaded.",
      };
      const first = await backend.records.append(record);
      const second = await backend.records.append(record);
      expect(second.recordId).toBe(first.recordId);
      expect(second.sequence).toBe(first.sequence);
      expect((await backend.records.list(conversationId, { kinds: ["error"] })).records).toHaveLength(1);
    } finally {
      await backend.close();
    }
  });
});
