/**
 * The snapshot exception's rule (`pair-rule.ts`): the allowed alternatives give one canonical form;
 * everything outside the exception is left as captured, so a snapshot comparison still catches it.
 */
import { describe, expect, test } from "bun:test";
import { canonicalManagedEvents, canonicalOwnedRecords } from "./pair-rule.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

describe("managed: metering among its turn's response presentation events", () => {
  const started = { kind: "turn_started", turnId: "t1" };
  const user = { kind: "presentation_recorded", id: "message:t1:user", role: "user", status: "completed" };
  const p1 = { kind: "presentation_recorded", id: "message:t1:assistant:1", role: "assistant", status: "in_progress" };
  const p2 = { kind: "presentation_recorded", id: "message:t1:assistant:1", role: "assistant", status: "completed" };
  const m = { kind: "metering_recorded", operationId: "t1" };
  const done = { kind: "turn_completed", turnId: "t1" };

  test("all three positions (M→P1→P2, P1→M→P2, P1→P2→M) give one form", () => {
    const forms = [
      [started, user, m, p1, p2, done],
      [started, user, p1, m, p2, done],
      [started, user, p1, p2, m, done],
    ].map(canonicalManagedEvents);
    expect(forms[1]).toEqual(forms[0]!);
    expect(forms[2]).toEqual(forms[0]!);
    expect(forms[0]).toEqual([started, user, m, p1, p2, done]);
  });

  test("tool presentations of the turn count as response presentations", () => {
    const toolIn = { kind: "presentation_recorded", id: "tool:t1:read-0", status: "in_progress" };
    const toolDone = { kind: "presentation_recorded", id: "tool:t1:read-0", status: "completed" };
    expect(canonicalManagedEvents([toolIn, toolDone, m])).toEqual(canonicalManagedEvents([toolIn, m, toolDone]));
  });

  test("metering never crosses the turn's user message presentations", () => {
    expect(same(canonicalManagedEvents([started, m, user, p1]), canonicalManagedEvents([started, user, m, p1]))).toBe(false);
  });

  test("metering never crosses another kind of event", () => {
    const other = { kind: "message_pending", id: "x" };
    expect(same(canonicalManagedEvents([p1, other, m]), canonicalManagedEvents([p1, m, other]))).toBe(false);
  });

  test("metering never crosses another turn's presentation events", () => {
    const otherTurn = { kind: "presentation_recorded", id: "message:t2:assistant:1", role: "assistant", status: "in_progress" };
    expect(same(canonicalManagedEvents([otherTurn, m]), canonicalManagedEvents([m, otherTurn]))).toBe(false);
  });

  test("presentation events are never reordered among themselves", () => {
    expect(same(canonicalManagedEvents([p2, p1, m]), canonicalManagedEvents([p1, p2, m]))).toBe(false);
  });

  test("a duplicate metering event is kept, not merged (exactly-once is asserted separately)", () => {
    expect(canonicalManagedEvents([p1, m, m])).toEqual([m, m, p1]);
  });
});

describe("Agent-owned: metering vs the turn's last in-progress assistant snapshot", () => {
  const user = { kind: "message", role: "user", status: "completed", operationId: "t1", recordId: "t1:user", sequence: 1 };
  const snapshot = (sequence: number, overrides: Record<string, unknown> = {}) => ({
    kind: "message", role: "assistant", status: "in_progress", operationId: "t1",
    recordId: "message:t1:assistant:1:snapshot:1", sequence, ...overrides,
  });
  const metering = (sequence: number, overrides: Record<string, unknown> = {}) => ({
    kind: "metering", operationId: "t1", recordId: "t1:metering", sequence, ...overrides,
  });
  const final = { kind: "message", role: "assistant", status: "completed", operationId: "t1", recordId: "t1:assistant:1", sequence: 4 };
  const busOf = (records: readonly Record<string, any>[]) => records.map(({ kind, recordId, operationId }) => ({ kind, recordId, operationId }));
  const canonical = (records: Record<string, any>[]) => canonicalOwnedRecords(records, busOf(records));

  test("both orders give one form, metering first, keeping the pair's own sequence numbers", () => {
    const snapshotFirst = [user, snapshot(2), metering(3), final];
    const meteringFirst = [user, metering(2), snapshot(3), final];
    expect(canonical(snapshotFirst)).toEqual(canonical(meteringFirst));
    expect(canonical(snapshotFirst).records.map((record) => [record.recordId, record.sequence])).toEqual([
      ["t1:user", 1], ["t1:metering", 2], ["message:t1:assistant:1:snapshot:1", 3], ["t1:assistant:1", 4],
    ]);
    expect(canonical(snapshotFirst).bus.map((entry) => entry.recordId)).toEqual(
      ["t1:user", "t1:metering", "message:t1:assistant:1:snapshot:1", "t1:assistant:1"]);
  });

  test("a completed snapshot is not moved", () => {
    const completedSnapshot = snapshot(2, { status: "completed" });
    expect(same(canonical([completedSnapshot, metering(3)]), canonical([metering(2), { ...completedSnapshot, sequence: 3 }]))).toBe(false);
    expect(canonical([completedSnapshot, metering(3)]).records).toEqual([completedSnapshot, metering(3)]);
  });

  test("a non-assistant message is not moved", () => {
    const userSnapshot = snapshot(2, { role: "user" });
    expect(canonical([userSnapshot, metering(3)]).records).toEqual([userSnapshot, metering(3)]);
  });

  test("another turn's snapshot is not moved", () => {
    const otherTurn = snapshot(2, { operationId: "t2", recordId: "message:t2:assistant:1:snapshot:1" });
    expect(canonical([otherTurn, metering(3)]).records).toEqual([otherTurn, metering(3)]);
  });

  test("an in-progress snapshot that is not the turn's last is not moved", () => {
    const earlier = snapshot(2);
    const later = snapshot(4, { recordId: "message:t1:assistant:2:snapshot:1" });
    expect(canonical([earlier, metering(3), later]).records).toEqual([earlier, metering(3), later]);
  });

  test("a record between the snapshot and metering keeps the order as captured", () => {
    const tool = { kind: "tool_call", operationId: "t1", recordId: "t1:runtime:x:1", sequence: 3 };
    expect(canonical([snapshot(2), tool, metering(4)]).records).toEqual([snapshot(2), tool, metering(4)]);
  });

  test("a bus that disagrees with the records is refused, never reconciled", () => {
    const records = [snapshot(2), metering(3)];
    expect(() => canonicalOwnedRecords(records, busOf([metering(2), snapshot(3)]))).toThrow("disagrees with the records");
    expect(() => canonicalOwnedRecords(records, busOf([snapshot(2)]))).toThrow("disagrees with the records");
  });

  test("a bus listing a completed snapshot and metering in the other order is refused", () => {
    // The reviewer's counterexample: records [completed snapshot, metering], bus reversed.
    const completedSnapshot = snapshot(2, { status: "completed" });
    expect(() => canonicalOwnedRecords([completedSnapshot, metering(3)], busOf([metering(3), completedSnapshot])))
      .toThrow("disagrees with the records");
  });
});
