import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAgentPersistence } from "../src/persistence/sqlite-backend.ts";
import { createAgentConversationId } from "../src/index.ts";

for (const legacy of [16, 17, "early 17"] as const) test(`worker repository upgrades schema ${legacy} and recovers only abandoned work`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "worker-delivery-"));
  const path = join(dir, "agent.sqlite");
  let backend = await SqliteAgentPersistence.open({ path });
  try {
    const version = legacy === 16 ? 16 : 17;
    const conversationId = createAgentConversationId();
    await backend.conversations.create({ agentConversationId: conversationId,
      agentSessionId: backend.identityRecord.agentSessionId, controllerKind: "native" });
    await backend.close();
    const db = new Database(path);
    try {
      db.exec("DROP TABLE worker_assignment_continuations; DROP TABLE worker_assignments");
      if (legacy !== 17) db.exec("ALTER TABLE conversations DROP COLUMN controller_kind");
      if (version === 16) db.exec("DROP TABLE native_channel_intents; DROP TABLE native_channel_intent_clock");
      db.query("DELETE FROM schema_migrations WHERE version > ?").run(version);
      db.query("INSERT OR IGNORE INTO schema_migrations VALUES (?, ?)").run(version, new Date().toISOString());
    } finally { db.close(); }
    backend = await SqliteAgentPersistence.open({ path });
    expect((await backend.conversations.get(conversationId))?.controllerKind).toBe(legacy === 17 ? "native" : undefined);
    {
      using migrated = new Database(path, { readonly: true });
      expect(migrated.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 20 });
    }
    const repo = backend.workerDelivery!;
    const binding = { assignmentId: "assignment", workerConversationId: "worker", workerHandle: "worker-handle", messageId: "operation",
      destination: { kind: "native" as const, id: "original" }, originatingPolicyNames: ["guest"], contributingPolicyNames: [] };
    await expect(SqliteAgentPersistence.open({ path })).rejects.toThrow();
    expect(await repo.reserve(binding)).toBe("reserved");
    expect(await repo.reserve(binding)).toBe("existing");
    expect(await repo.reserve({ ...binding, destination: { kind: "native" as const, id: "different" } })).toBe("conflict");
    expect(await repo.stage(binding.assignmentId)).toBeUndefined();
    expect(await repo.reserve({ ...binding, assignmentId: "other" })).toBe("conflict");
    const foldedOwner = { ...binding, assignmentId: "fold-owner", messageId: "fold-owner-message",
      originatingPolicyNames: ["owner"], destination: { kind: "native" as const, id: "owner" } };
    const foldedGuest = { ...binding, assignmentId: "fold-guest", messageId: "fold-guest-message",
      originatingPolicyNames: ["guest"], destination: { kind: "native" as const, id: "guest" } };
    expect(await repo.reserve(foldedOwner)).toBe("reserved");
    expect(await repo.reserve(foldedGuest)).toBe("reserved");
    await repo.recordFailure("worker", "folded-operation", [foldedOwner.messageId, foldedGuest.messageId],
      { kind: "failed", reason: "fake-secret-" + "x".repeat(200), possiblePartialEffects: true });
    const ownerFailure = await repo.stage(foldedOwner.assignmentId);
    const guestFailure = await repo.stage(foldedGuest.assignmentId);
    expect(ownerFailure).toMatchObject({ outcome: { kind: "failed", reason: "worker failed" },
      delivery: { destination: { kind: "native" as const, id: "owner" }, policyNames: ["guest", "owner"] } });
    expect(guestFailure?.delivery.id).not.toBe(ownerFailure?.delivery.id);
    expect(guestFailure?.delivery.policyNames).toEqual(["guest", "owner"]);
    expect(JSON.stringify(ownerFailure)).not.toContain("fake-secret");
    expect(ownerFailure?.delivery.text).toContain("Partial external effects may have occurred");
    expect(await repo.stage(foldedOwner.assignmentId)).toEqual(ownerFailure);
    expect(await repo.stage(binding.assignmentId)).toBeUndefined();
    const interrupted = { ...binding, assignmentId: "interrupted", messageId: "interrupted-message" };
    expect(await repo.reserve(interrupted)).toBe("reserved");
    await repo.recordFailure("worker", "interrupted-operation", [interrupted.messageId],
      { kind: "interrupted", reason: "worker interrupted", possiblePartialEffects: true });
    expect(await repo.stage(interrupted.assignmentId)).toMatchObject({
      outcome: { kind: "interrupted", reason: "worker interrupted" }, delivery: { state: "pending" },
    });
    const undeliverable = { ...binding, assignmentId: "missing-destination", messageId: "other-operation" };
    expect(await repo.reserve(undeliverable)).toBe("reserved");
    await expect(backend.transaction(async scope => {
      await scope.workerDelivery!.redirect(binding.assignmentId, { kind: "native", id: "rollback" });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await repo.readBinding(binding.assignmentId))?.destination).toEqual({ kind: "native", id: "original" });
    expect(await repo.redirect(binding.assignmentId, { kind: "native", id: "next" })).toBe(true);
    expect(await repo.addContributingPolicies(binding.assignmentId, ["owner", "guest"])).toBe(true);
    await backend.close();
    backend = await SqliteAgentPersistence.open({ path });
    const reopened = backend.workerDelivery!;
    await expect(backend.transaction(async scope => {
      expect(await scope.workerDelivery!.stage(binding.assignmentId)).toBeDefined();
      throw new Error("stage rollback");
    })).rejects.toThrow("stage rollback");
    expect(await reopened.readStaged(binding.assignmentId)).toBeUndefined();
    const result = await reopened.stage(binding.assignmentId);
    expect(result).toMatchObject({ outcome: { kind: "uncertain" },
      delivery: { destination: { kind: "native" as const, id: "next" }, source: "worker-handle", policyNames: ["guest", "owner"], state: "pending" } });
    expect(await reopened.stage(binding.assignmentId)).toEqual(result);
    expect(await reopened.redirect(binding.assignmentId, { kind: "native", id: "later" })).toBe(false);
    const { id } = result!.delivery;
    expect(await reopened.transitionDelivery(id, { from: "pending", to: "blocked_policy" })).toBe(true);
    expect(await reopened.transitionDelivery(id, { from: "pending", to: "delivered" })).toBe(false);
    expect(await reopened.transitionDelivery(id, { from: "blocked_policy", to: "pending", explicitRetry: true })).toBe(true);
    expect(await reopened.transitionDelivery(id, { from: "pending", to: "delivered" })).toBe(true);
    expect(await reopened.transitionDelivery(id, { from: "pending", to: "failed_destination" })).toBe(false);
    expect((await reopened.readStaged(binding.assignmentId))?.delivery).toEqual({ ...result!.delivery, state: "delivered" });
    const failed = (await reopened.stage(undeliverable.assignmentId))!;
    expect(await reopened.transitionDelivery(failed.delivery.id, { from: "pending", to: "failed_destination" })).toBe(true);
    expect(await reopened.transitionDelivery(failed.delivery.id, { from: "pending", to: "delivered" })).toBe(false);
    expect((await reopened.stage(undeliverable.assignmentId))?.delivery.state).toBe("failed_destination");
  } finally {
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker terminal reasons are fixed public strings for typed signals", async () => {
  const { workerTerminalFailure } = await import("../src/persistence/worker-terminal-reason.ts");
  const { OperationStalledError } = await import("../src/operations/errors.ts");
  expect(workerTerminalFailure(true)).toMatchObject({ kind: "interrupted", reason: "worker interrupted" });
  expect(workerTerminalFailure(true, undefined, "interrupt")).toMatchObject({
    kind: "interrupted", reason: "worker interrupted by request",
  });
  expect(workerTerminalFailure(false, new Error("credential=secret"))).toMatchObject({
    kind: "failed", reason: "worker failed",
  });
  expect(workerTerminalFailure(false, new OperationStalledError("operation", "first_output")).reason).toBe("worker stalled");
});

test("continuations fence old terminal evidence and replacement is atomic and idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-continuation-"));
  const path = join(directory, "agent.sqlite");
  let backend = await SqliteAgentPersistence.open({ path });
  const failure = { kind: "failed" as const, reason: "worker failed", possiblePartialEffects: true };
  const base = {
    assignmentId: "old", workerConversationId: "worker", workerHandle: "label", messageId: "m0",
    destination: { kind: "native" as const, id: "original" },
    originatingPolicyNames: ["guest"], contributingPolicyNames: [],
  };
  try {
    const repository = backend.workerDelivery!;
    expect(await repository.reserve(base)).toBe("reserved");
    await repository.markSteered("worker", ["no-binding"]);
    await repository.markSteered("worker", ["m0"]);
    expect(await repository.stage("old")).toBeUndefined();
    expect(await repository.continueAssignment("old", "m0", "m1")).toBe("continued");
    expect(await repository.continueAssignment("old", "m1", "m2")).toBe("continued");
    expect(await repository.continueAssignment("old", "m0", "m1")).toBe("existing");
    expect(await repository.reserve({ ...base, assignmentId: "conflict", messageId: "m1" })).toBe("conflict");
    await repository.recordFailure("worker", "old-operation", ["m0", "m1"], failure);
    await repository.recordFinal("worker", "old-operation", ["m0", "m1"]);
    expect(await repository.stage("old")).toBeUndefined();
    expect(await repository.discoverAssignments({ destinationKind: "native", state: "unstaged" }))
      .toEqual({ assignments: [] });

    const replacement = { ...base, assignmentId: "new", messageId: "m3",
      destination: { kind: "acp" as const, id: "redirect" } };
    await repository.markSteered("worker", ["m2"]);
    expect(await repository.replaceAssignment("old", "m2", { ...replacement, messageId: "m1" })).toEqual({ kind: "conflict" });
    expect(await repository.readStaged("old")).toBeUndefined();
    expect(await repository.replaceAssignment("old", "m2", replacement))
      .toEqual({ kind: "replaced", reservation: "reserved" });
    await repository.markSteered("worker", ["m2"]);
    expect(await repository.replaceAssignment("old", "m2", replacement))
      .toEqual({ kind: "replaced", reservation: "existing" });
    expect(await repository.readStaged("old")).toMatchObject({
      outcome: { kind: "interrupted", reason: "worker interrupted by steering", possiblePartialEffects: true },
      delivery: { destination: base.destination, source: "label" },
    });
    await repository.recordFailure("worker", "new-operation", ["m3"], failure);
    const next = { ...replacement, assignmentId: "next", messageId: "m4" };
    expect(await repository.replaceAssignment("new", "m3", next)).toEqual({ kind: "old_settled", reservation: "reserved" });
    expect(await repository.replaceAssignment("new", "m3", next)).toEqual({ kind: "old_settled", reservation: "existing" });
    expect((await repository.latestOutcome("worker"))?.assignmentId).toBe("new");

    await backend.close();
    backend = await SqliteAgentPersistence.open({ path });
    const reopened = backend.workerDelivery!;
    expect((await reopened.discoverAssignments({ destinationKind: "acp", state: "unstaged" })).assignments)
      .toEqual([{ state: "unstaged", binding: await reopened.readBinding("next") }]);
    expect(await reopened.continueAssignment("next", "m4", "m5")).toBe("conflict");
    const fresh = { ...next, assignmentId: "after-reopen", messageId: "m5" };
    expect(await reopened.replaceAssignment("next", "m4", fresh)).toEqual({ kind: "old_settled", reservation: "reserved" });
    const uncertain = await reopened.readStaged("next");
    expect(uncertain).toMatchObject({ outcome: { kind: "uncertain" },
      delivery: { id: "worker-result:next", destination: next.destination, state: "pending" } });
    expect(await reopened.replaceAssignment("next", "m4", fresh)).toEqual({ kind: "old_settled", reservation: "existing" });
    expect(await reopened.stage("next")).toEqual(uncertain);
    const first = await reopened.discoverAssignments({ destinationKind: "acp", state: "pending", limit: 1 });
    expect(first.assignments[0]).toMatchObject({ staged: { assignmentId: "new" } });
    expect(first.next).toBeDefined();
    expect((await reopened.discoverAssignments({ destinationKind: "acp", state: "pending", after: first.next })).assignments)
      .toEqual([{ state: "pending", staged: uncertain }]);
    expect(() => reopened.discoverAssignments({ destinationKind: "native", state: "pending", after: first.next })).toThrow();
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});
