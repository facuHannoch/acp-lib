import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ActivityAggregator,
  foldFrame,
  foldRecords,
  isActivityDelta,
  wireFrames,
  type ActivityFrame,
  type AggregatedRecord,
} from "../src/activity.ts";
import type { ActivityEvent } from "../src/types.ts";

const think = (text: string, messageId?: string): ActivityEvent =>
  messageId ? { kind: "thinking", text, messageId } : { kind: "thinking", text };

const tool = (over: Partial<Extract<ActivityEvent, { kind: "tool" }>> = {}): ActivityEvent => ({
  kind: "tool",
  toolCallId: "t1",
  toolKind: "execute",
  status: "pending",
  title: "Bash",
  ...over,
});

const update = (
  over: Partial<Extract<ActivityEvent, { kind: "tool_update" }>> = {},
): ActivityEvent => ({ kind: "tool_update", toolCallId: "t1", ...over });

/** Emissions from a whole event stream, as (recordId, reason) pairs. */
function run(events: ActivityEvent[], agg = new ActivityAggregator()) {
  const emitted: AggregatedRecord[] = [];
  const frames: ActivityFrame[] = [];
  for (const e of events) {
    const result = agg.apply(e);
    emitted.push(...result.emitted);
    frames.push(...wireFrames(result));
  }
  emitted.push(...agg.flush());
  return { agg, emitted, frames, pairs: emitted.map((r) => `${r.recordId}:${r.reason}`) };
}

describe("ActivityAggregator — tool calls", () => {
  test("announces, checkpoints on input, settles once", () => {
    const { pairs, agg } = run([
      tool(),
      update({ content: [{ type: "content", content: { type: "text", text: '{"c' } }] }),
      update({ rawInput: { command: "ls" }, title: "Running: ls" }),
      update({ status: "completed", rawOutput: "a.txt" }),
    ]);

    expect(pairs).toEqual(["t1:announced", "t1:input", "t1:settled"]);

    // The settled record is the MERGE of everything, not just the last update.
    const merged = agg.tool("t1")!;
    expect(merged).toMatchObject({
      kind: "tool",
      toolCallId: "t1",
      title: "Running: ls",
      toolKind: "execute",
      status: "completed",
      rawInput: { command: "ls" },
      rawOutput: "a.txt",
    });
  });

  test("a call announced with its input already present skips the checkpoint", () => {
    const { pairs } = run([
      tool({ rawInput: { command: "ls" } }),
      update({ status: "completed" }),
    ]);
    expect(pairs).toEqual(["t1:announced", "t1:settled"]);
  });

  test("a placeholder rawInput does not count as knowing the input", () => {
    // Agents announce with `rawInput: {}` and fill the real arguments in later (Kimi does,
    // and so does the terminal fixture). Counting the placeholder would skip the
    // checkpoint, so a turn dying after the command was known would not record it.
    const { pairs } = run([
      tool({ rawInput: {} }),
      update({ rawInput: { command: "ls" } }),
      update({ status: "completed" }),
    ]);
    expect(pairs).toEqual(["t1:announced", "t1:input", "t1:settled"]);
  });

  test("an empty string or array rawInput is a placeholder too", () => {
    expect(run([tool({ rawInput: "" }), update({ rawInput: "ls" })]).pairs).toContain("t1:input");
    expect(run([tool({ rawInput: [] }), update({ rawInput: ["ls"] })]).pairs).toContain("t1:input");
  });

  test("settling and learning input in the same update emits only settled", () => {
    // The settled record is a superset — an extra `input` line would be pure duplication.
    const { pairs } = run([tool(), update({ rawInput: { command: "ls" }, status: "completed" })]);
    expect(pairs).toEqual(["t1:announced", "t1:settled"]);
  });

  test("does not re-settle", () => {
    const { pairs } = run([
      tool(),
      update({ status: "completed" }),
      update({ status: "completed", rawOutput: "late" }),
    ]);
    expect(pairs).toEqual(["t1:announced", "t1:settled"]);
  });

  test("failed is terminal too", () => {
    const { pairs } = run([tool(), update({ status: "failed" })]);
    expect(pairs).toEqual(["t1:announced", "t1:settled"]);
  });

  test("an update for a call never announced synthesises one", () => {
    const { pairs, agg } = run([update({ status: "in_progress", title: "Orphan" })]);
    expect(pairs).toEqual(["t1:announced", "t1:flushed"]);
    expect(agg.tool("t1")).toMatchObject({ kind: "tool", toolKind: "other", title: "Orphan" });
  });

  test("content replaces, never accumulates", () => {
    const { agg } = run([
      tool(),
      update({ content: [{ type: "content", content: { type: "text", text: "first" } }] }),
      update({ content: [{ type: "content", content: { type: "text", text: "second" } }] }),
      update({ status: "completed" }),
    ]);
    expect(agg.tool("t1")!.content).toEqual([
      { type: "content", content: { type: "text", text: "second" } },
    ]);
  });

  test("checkpointOnInput: false drops the middle line", () => {
    const { pairs } = run(
      [tool(), update({ rawInput: { command: "ls" } }), update({ status: "completed" })],
      new ActivityAggregator({ checkpointOnInput: false }),
    );
    expect(pairs).toEqual(["t1:announced", "t1:settled"]);
  });

  test("a turn that dies mid-call flushes it at its REAL status", () => {
    const { emitted } = run([tool(), update({ status: "in_progress" })]);
    const last = emitted[emitted.length - 1]!;
    expect(last.reason).toBe("flushed");
    expect((last.event as { status: string }).status).toBe("in_progress");
  });
});

describe("ActivityAggregator — thinking", () => {
  test("accumulates into one block and settles on the first non-thinking event", () => {
    const { pairs, emitted } = run([think("Simple"), think(" request"), think("."), tool()]);
    expect(pairs).toEqual(["think-1:settled", "t1:announced", "t1:flushed"]);
    expect(emitted[0]!.event).toEqual({ kind: "thinking", text: "Simple request." });
  });

  test("a messageId change starts a new block", () => {
    const { pairs, emitted } = run([think("a", "m1"), think("b", "m1"), think("c", "m2")]);
    expect(pairs).toEqual(["think-m1:settled", "think-m2:settled"]);
    expect(emitted[0]!.event).toMatchObject({ text: "ab", messageId: "m1" });
    expect(emitted[1]!.event).toMatchObject({ text: "c", messageId: "m2" });
  });

  test("a block still open at turn end is flushed", () => {
    const { pairs } = run([think("unfinished")]);
    expect(pairs).toEqual(["think-1:settled"]);
  });

  test("streams incrementally — deltas are O(text), not O(text²)", () => {
    const agg = new ActivityAggregator();
    const chunk = "0123456789";
    const chunks = 400;

    let deltaBytes = 0;
    let currentBytes = 0;
    let rebuilt = "";
    for (let i = 0; i < chunks; i++) {
      const result = agg.apply(think(chunk));
      expect(result.delta).not.toBeNull();
      deltaBytes += result.delta!.append.length;
      rebuilt += result.delta!.append;
      currentBytes += (result.current!.event as { text: string }).text.length;
    }

    const total = chunk.length * chunks;
    expect(rebuilt).toBe(agg.snapshot().records[0]!.event.text as unknown as string);
    expect(deltaBytes).toBe(total); // linear
    expect(currentBytes).toBeGreaterThan(total * 100); // quadratic — what we avoid sending
  });
});

describe("ActivityAggregator — other kinds", () => {
  test("usage coalesces to one record per turn but stays live in `current`", () => {
    const agg = new ActivityAggregator();
    const first = agg.apply({ kind: "usage", used: 10, size: 100 });
    expect(first.emitted).toEqual([]);
    expect(first.current!.event).toEqual({ kind: "usage", used: 10, size: 100 });

    agg.apply({ kind: "usage", used: 20, size: 100 });
    const flushed = agg.flush();
    expect(flushed.filter((r) => r.recordId === "usage")).toHaveLength(1);
    expect(flushed.find((r) => r.recordId === "usage")!.event).toEqual({
      kind: "usage",
      used: 20,
      size: 100,
    });
  });

  test("plans replace on one recordId; keyed plans get their own", () => {
    const { pairs } = run([
      { kind: "plan", entries: [] },
      { kind: "plan", entries: [{ content: "a", priority: "high", status: "pending" }] },
      { kind: "plan_update", planId: "p2", plan: { type: "markdown", content: "x" } },
    ]);
    expect(pairs).toEqual(["plan:snapshot", "plan:snapshot", "plan-p2:snapshot"]);
  });

  test("unmodelled kinds are recorded, not dropped", () => {
    const { pairs } = run([{ kind: "unknown", sessionUpdate: "future", raw: { a: 1 } }]);
    expect(pairs).toEqual(["unknown-1:snapshot"]);
  });
});

describe("snapshot + seq — the mid-turn join", () => {
  test("a late subscriber can rebuild state and discard already-folded frames", () => {
    const agg = new ActivityAggregator();
    const live = new Map<string, AggregatedRecord>();

    // Turn in progress: a settled tool call and a thinking block mid-stream.
    for (const e of [tool(), update({ status: "completed" }), think("half a "), think("thought")]) {
      for (const f of wireFrames(agg.apply(e))) foldFrame(live, f);
    }

    // Subscriber joins: takes the snapshot, then sees frames from BOTH sides of it.
    const snap = agg.snapshot();
    const late = foldRecords(snap.records);
    const straggler = wireFrames(agg.apply(think(" more")));

    for (const f of [...live.values(), ...straggler]) {
      if (f.seq <= snap.seq) continue; // already reflected in the snapshot
      foldFrame(late, f as ActivityFrame);
    }
    for (const f of wireFrames(agg.apply(think("!")))) foldFrame(late, f);
    for (const f of straggler) foldFrame(live, f);
    for (const f of wireFrames({ current: null, delta: null, emitted: agg.flush() }))
      foldFrame(live, f), foldFrame(late, f);

    // The late subscriber ends up with exactly what the live one has — no double-append.
    expect([...late.keys()].sort()).toEqual([...live.keys()].sort());
    expect((late.get("think-1")!.event as { text: string }).text).toBe("half a thought more!");
    expect(late.get("t1")!.event).toEqual(live.get("t1")!.event);
  });

  test("a delta with no base is dropped rather than guessed at", () => {
    const map = new Map<string, AggregatedRecord>();
    foldFrame(map, { recordId: "think-1", seq: 5, kind: "thinking", append: "orphan" });
    expect(map.size).toBe(0);
  });

  test("every frame from one apply shares a seq, and seq is monotonic", () => {
    const agg = new ActivityAggregator();
    agg.apply(think("a"));
    const result = agg.apply(tool()); // closes the block AND announces the call
    const frames = wireFrames(result);
    expect(frames).toHaveLength(2);
    expect(new Set(frames.map((f) => f.seq)).size).toBe(1);
    expect(frames[0]!.seq).toBeGreaterThan(agg.snapshot().seq - 1);
  });
});

describe("wireFrames", () => {
  test("carries a thinking close that `current` alone would hide", () => {
    const agg = new ActivityAggregator();
    agg.apply(think("thought"));
    const frames = wireFrames(agg.apply(tool()));
    expect(frames.map((f) => f.recordId)).toEqual(["think-1", "t1"]);
    expect(isActivityDelta(frames[0]!)).toBe(false);
  });

  test("prefers the delta and never duplicates a record", () => {
    const agg = new ActivityAggregator();
    const frames = wireFrames(agg.apply(think("a")));
    expect(frames).toHaveLength(1);
    expect(isActivityDelta(frames[0]!)).toBe(true);

    const settle = wireFrames(agg.apply(update({ status: "completed" })));
    expect(settle.map((f) => f.recordId)).toEqual(["think-1", "t1"]);
  });
});

describe("the round trip — persisted state equals live state", () => {
  test("folding persisted records reproduces the live fold", () => {
    const events: ActivityEvent[] = [
      think("Simple"),
      think(" request"),
      tool(),
      update({ content: [{ type: "content", content: { type: "text", text: '{"c' } }] }),
      update({ rawInput: { command: "ls" }, title: "Running: ls" }),
      update({ status: "completed", rawOutput: "a.txt" }),
      { kind: "usage", used: 12, size: 200 },
    ];

    // Live: fold the wire frames the transport would carry.
    const liveAgg = new ActivityAggregator();
    const live = new Map<string, AggregatedRecord>();
    const persisted: AggregatedRecord[] = [];
    for (const e of events) {
      const result = liveAgg.apply(e);
      persisted.push(...result.emitted);
      for (const f of wireFrames(result)) foldFrame(live, f);
    }
    const tail = liveAgg.flush();
    persisted.push(...tail);
    for (const r of tail) foldFrame(live, r);

    // Persisted: what a reader does with transcript lines — NOT apply().
    const reloaded = foldRecords(persisted);

    expect([...reloaded.keys()].sort()).toEqual([...live.keys()].sort());
    for (const [id, record] of reloaded) {
      expect(record.event).toEqual(live.get(id)!.event);
    }

    // Two thinking blocks must stay two records — the bug a naive round trip hides.
    const twoBlocks = foldRecords([
      { recordId: "think-1", seq: 1, reason: "settled", event: { kind: "thinking", text: "a" } },
      { recordId: "think-2", seq: 2, reason: "settled", event: { kind: "thinking", text: "b" } },
    ]);
    expect(twoBlocks.size).toBe(2);
  });

  test("volume: one shell command settles in at most 3 tool lines", () => {
    // The real Kimi shape: announce empty, stream the input as growing JSON, then finish.
    const events: ActivityEvent[] = [tool({ content: [] })];
    const growing = ['{"', '{"command', '{"command":"ls', '{"command":"ls"}'];
    for (const text of growing) {
      events.push(update({ content: [{ type: "content", content: { type: "text", text } }] }));
    }
    events.push(update({ rawInput: { command: "ls" }, title: "Running: ls" }));
    events.push(update({ status: "completed", rawOutput: "LICENSE\nREADME.md\n" }));

    const { emitted } = run(events);
    expect(emitted.filter((r) => r.event.kind === "tool")).toHaveLength(3);
    expect(events).toHaveLength(7); // 7 events in, 3 lines out
  });
});

describe("recordId scope across turns", () => {
  // The transcript accumulates across turns while an aggregator is per-turn, so MINTED
  // ids (think-N, plan, usage) repeat every turn. Without idPrefix, folding a multi-turn
  // file keeps only the last turn's thinking and plan — the earlier turns come back
  // stripped of their reasoning. Tool calls hide the bug because ACP guarantees
  // toolCallId is unique within a SESSION.
  const turnEvents = (text: string, callId: string): ActivityEvent[] => [
    think(text),
    { kind: "plan", entries: [{ content: text, priority: "high", status: "pending" }] },
    { kind: "usage", used: 1, size: 100 },
    tool({ toolCallId: callId }),
    update({ toolCallId: callId, status: "completed" }),
  ];

  /** One aggregator for the stream, `startTurn` between turns — the supported shape. */
  const turn = (agg: ActivityAggregator, prefix: string | undefined, text: string, callId: string) => {
    expect(agg.startTurn(prefix)).toEqual([]); // nothing left open by the previous turn
    const emitted: AggregatedRecord[] = [];
    for (const e of turnEvents(text, callId)) emitted.push(...agg.apply(e).emitted);
    emitted.push(...agg.flush());
    return emitted;
  };

  test("a multi-turn transcript keeps every turn's records when scoped", () => {
    const agg = new ActivityAggregator();
    const file = [...turn(agg, "t1", "first", "call-a"), ...turn(agg, "t2", "second", "call-b")];
    const folded = foldRecords(file);

    expect([...folded.keys()].sort()).toEqual([
      "call-a",
      "call-b",
      "t1:plan",
      "t1:think-1",
      "t1:usage",
      "t2:plan",
      "t2:think-1",
      "t2:usage",
    ]);
    expect((folded.get("t1:think-1")!.event as { text: string }).text).toBe("first");
    expect((folded.get("t2:think-1")!.event as { text: string }).text).toBe("second");
  });

  test("without a prefix, minted ids collide across turns — the bug this guards", () => {
    const agg = new ActivityAggregator();
    const file = [
      ...turn(agg, undefined, "first", "call-a"),
      ...turn(agg, undefined, "second", "call-b"),
    ];
    const folded = foldRecords(file);

    // Turn 1's reasoning and plan are gone; only the tool calls survive.
    expect(folded.has("think-1")).toBe(true);
    expect((folded.get("think-1")!.event as { text: string }).text).toBe("second");
    expect([...folded.keys()].filter((k) => k.startsWith("think"))).toHaveLength(1);
  });

  test("protocol-given ids are never prefixed", () => {
    const agg = new ActivityAggregator({ idPrefix: "t9" });
    const ids = [
      agg.apply(tool({ toolCallId: "call-x" })).current!.recordId,
      agg.apply(think("a", "m1")).current!.recordId,
      agg.apply({ kind: "plan_update", planId: "p1", plan: {} }).current!.recordId,
      agg.apply({ kind: "user_message", text: "hi", messageId: "m2" }).current!.recordId,
    ];
    // toolCallId / messageId / planId are session-unique per ACP — verbatim.
    expect(ids).toEqual(["call-x", "think-m1", "plan-p1", "msg-m2"]);

    // Everything we mint is scoped.
    expect(agg.apply({ kind: "mode", modeId: "plan" }).current!.recordId).toBe("t9:mode");
    expect(agg.apply(think("b")).current!.recordId).toBe("t9:think-1");
  });
});

describe("seq outlives the turn", () => {
  test("a discard threshold from an earlier turn never eats the next turn", () => {
    // The failure this guards: a subscriber stores snapshotSeq mid-turn-1 and filters
    // `frame.seq <= snapshotSeq` forever. If seq restarted per turn, turn 2's opening
    // frames — potentially a whole tool call — would be dropped in silence.
    const agg = new ActivityAggregator();

    agg.startTurn("turn-1");
    for (const e of [think("reasoning"), tool({ toolCallId: "call-a" })]) agg.apply(e);
    const threshold = agg.snapshot().seq;
    expect(threshold).toBeGreaterThan(0);
    agg.apply(update({ toolCallId: "call-a", status: "completed" }));
    agg.flush();

    agg.startTurn("turn-2");
    const frames: ActivityFrame[] = [];
    for (const e of [think("more"), tool({ toolCallId: "call-b" })]) {
      frames.push(...wireFrames(agg.apply(e)));
    }
    frames.push(...agg.flush());

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.seq > threshold)).toBe(true);
  });

  test("a snapshot is empty between turns and populated during one", () => {
    // A client connecting mid-idle must not receive the last turn's records: it would
    // place activity in its log before chat-history loads the messages around it. The
    // transcript already owns everything settled.
    const agg = new ActivityAggregator();
    expect(agg.snapshot()).toMatchObject({ active: true, records: [] }); // fresh, nothing yet

    agg.apply(think("reasoning"));
    agg.apply(tool());
    const mid = agg.snapshot();
    expect(mid.active).toBe(true);
    expect(mid.records.map((r) => r.recordId)).toEqual(["think-1", "t1"]);

    agg.flush();
    const idle = agg.snapshot();
    expect(idle).toMatchObject({ active: false, records: [] });
    expect(idle.seq).toBe(mid.seq + 1); // the clock still advanced
    expect(agg.tool("t1")).toBeDefined(); // inspection accessors still work

    agg.startTurn("t2");
    expect(agg.snapshot()).toMatchObject({ active: true, records: [] });
  });

  test("startTurn clears turn state but not the clock; reset clears both", () => {
    const agg = new ActivityAggregator();
    agg.apply(think("a"));
    agg.flush();
    const afterFirst = agg.snapshot().seq;

    agg.startTurn("t2");
    expect(agg.snapshot().records).toEqual([]); // previous turn's records are gone
    expect(agg.snapshot().seq).toBeGreaterThanOrEqual(afterFirst);
    expect(agg.apply(think("b")).current!.recordId).toBe("t2:think-1"); // counter restarts

    agg.reset();
    expect(agg.snapshot().seq).toBe(0);
  });

  test("startTurn hands back anything the caller forgot to flush", () => {
    const agg = new ActivityAggregator();
    agg.apply(tool());
    agg.apply(think("unfinished"));

    const leftover = agg.startTurn("t2"); // no flush() — a caller bug
    expect(leftover.map((r) => r.reason).sort()).toEqual(["flushed", "settled"]);
    expect(leftover.some((r) => r.recordId === "t1")).toBe(true);
  });
});

describe("purity", () => {
  test("activity.ts has no runtime imports", async () => {
    const source = await readFile(resolve(import.meta.dir, "../src/activity.ts"), "utf8");
    const imports = source.match(/^import .*/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line.startsWith("import type ")).toBe(true);
  });
});
