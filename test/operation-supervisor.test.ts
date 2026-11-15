import { expect, test } from "bun:test";
import { OperationSupervisor, type SupervisedProvider } from "../src/operations/supervisor.ts";
import type { OutputListener } from "../src/operations/contracts.ts";
import type { Timers } from "../src/operations/timers.ts";
import type { PromptResult } from "../src/types.ts";

/** A fake clock: timers run only when the test advances time. */
class Clock implements Timers {
  time = 0;
  jobs = new Map<number, { at: number; run: () => void }>();
  id = 0;

  now = () => this.time;

  setTimeout = (run: () => void, delay: number) => {
    const id = ++this.id;
    this.jobs.set(id, { at: this.time + delay, run });
    return id;
  };

  clearTimeout = (id: unknown) => {
    this.jobs.delete(id as number);
  };

  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.jobs.delete(next[0]);
      next[1].run();
    }
    this.time = end;
  }
}

const completed = (text: string): PromptResult => ({
  text,
  messages: [{ text } as never],
  usage: null,
  stopReason: "end_turn",
  status: "completed",
});

/** A prompt that settles only when the test calls `finish`. */
function controllablePrompt() {
  let finish!: (result: PromptResult) => void;
  const prompt = () => new Promise<PromptResult>((resolve) => { finish = resolve; });
  return { prompt, finish: (result: PromptResult) => finish(result) };
}

test("ignored cancellation is resent halfway and forced at the deadline", async () => {
  const clock = new Clock();
  const calls: string[] = [];
  let listener!: OutputListener;
  const provider: SupervisedProvider = {
    prompt: () => new Promise(() => {}),
    subscribeOutput: (fn) => {
      listener = fn;
      return () => { calls.push("detach"); };
    },
    cancel: () => { calls.push("cancel"); },
    forceStop: async () => { calls.push("force"); },
  };
  const stages: string[] = [];
  const supervisor = new OperationSupervisor(provider, {
    operationId: "one",
    kind: "turn",
    timers: clock,
    cancelGraceMs: 100,
    sessionId: "ours",
    onStageChanged: (activity) => stages.push(activity.stage),
  });
  const result = supervisor.run();

  listener({ kind: "request", sessionId: "other" });
  expect(supervisor.activity.lastOutputAt).toBeNull();
  listener({ kind: "permission_started", sessionId: "ours" });
  expect(supervisor.activity.stage).toBe("awaiting_permission");

  supervisor.cancel("interrupt");
  supervisor.cancel("steer");
  clock.advance(49);
  expect(calls).toEqual(["cancel"]);
  clock.advance(1);
  expect(calls).toEqual(["cancel", "cancel"]);
  clock.advance(50);
  expect((await result).cancel).toBe("forced");
  expect(calls).toEqual(["cancel", "cancel", "force", "detach"]);
  expect(stages).toEqual(["waiting", "awaiting_permission", "cancelling"]);
  expect(clock.jobs.size).toBe(0);
});

test("normal settlement removes cancellation timers and subscriptions", async () => {
  const clock = new Clock();
  const { prompt, finish } = controllablePrompt();
  let detached = false;
  const supervisor = new OperationSupervisor({
    prompt,
    subscribeOutput: () => () => { detached = true; },
    cancel() {},
    async forceStop() { throw new Error("unexpected force"); },
  }, { operationId: "one", kind: "turn", timers: clock, cancelGraceMs: 100 });
  const pending = supervisor.run();
  await Promise.resolve();
  supervisor.cancel("steer");
  finish({ ...completed("partial"), status: "cancelled", stopReason: "cancelled" });
  expect((await pending).cancel).toBe("acknowledged");
  expect(detached).toBe(true);
  expect(clock.jobs.size).toBe(0);
});

test("a broken cancellation notification or force primitive cannot leave the request pending", async () => {
  const clock = new Clock();
  const supervisor = new OperationSupervisor({
    prompt: () => new Promise(() => {}),
    subscribeOutput: () => () => {},
    cancel() { throw new Error("connection already closed"); },
    forceStop() { throw new Error("cleanup failed"); },
  }, { operationId: "broken", kind: "turn", timers: clock, cancelGraceMs: 10 });
  const pending = supervisor.run();
  supervisor.cancel("interrupt");
  clock.advance(10);
  expect((await pending).cancel).toBe("forced");
  expect(clock.jobs.size).toBe(0);
});

test("a cancel that loses the completion race does not claim acknowledgement", async () => {
  const supervisor = new OperationSupervisor({
    async prompt() { return completed("done"); },
    subscribeOutput: () => () => {},
    cancel() {},
    async forceStop() {},
  }, { operationId: "complete", kind: "turn" });
  const result = supervisor.run();
  supervisor.cancel("interrupt");
  expect((await result).cancel).toBeUndefined();
});

test("same-stage output updates snapshot timing without producing stage events", async () => {
  const clock = new Clock();
  const { prompt, finish } = controllablePrompt();
  let output!: OutputListener;
  const stages: string[] = [];
  const supervisor = new OperationSupervisor({
    prompt,
    subscribeOutput: (listener) => {
      output = listener;
      return () => {};
    },
    cancel() {},
    async forceStop() {},
  }, { operationId: "timestamps", kind: "turn", timers: clock, onStageChanged: (activity) => stages.push(activity.stage) });
  const pending = supervisor.run();
  await Promise.resolve();

  clock.advance(10);
  output({ kind: "update", sessionId: null });
  clock.advance(10);
  output({ kind: "request", sessionId: null });
  expect(stages).toEqual(["waiting", "streaming"]);
  expect(supervisor.activity.lastOutputAt).toBe(20);
  finish({ ...completed("done"), messages: [] });
  await pending;
});

test("a turn that completes normally after the stall cancel keeps its result", async () => {
  const clock = new Clock();
  const { prompt, finish } = controllablePrompt();
  const supervisor = new OperationSupervisor({
    prompt,
    subscribeOutput: () => () => {},
    cancel() {},
    async forceStop() { throw new Error("unexpected force"); },
  }, { operationId: "late", kind: "turn", timers: clock, cancelGraceMs: 1000, limits: { firstOutputMs: 100 } });
  const pending = supervisor.run();
  await Promise.resolve();
  clock.advance(100);
  expect(supervisor.activity.cancel?.reason).toBe("stalled");

  finish(completed("full answer"));
  const result = await pending;
  expect(result.status).toBe("completed");
  expect(result.text).toBe("full answer");
  expect(result.cancel).toBeUndefined();
});

test("reports a cancel once when requested and once with how it ended", async () => {
  const run = async (
    reason: "interrupt" | "steer" | "stalled",
    settle: (finish: (result: PromptResult) => void, fail: (error: Error) => void, clock: Clock) => void,
  ) => {
    const clock = new Clock();
    let finish!: (result: PromptResult) => void;
    let fail!: (error: Error) => void;
    const events: string[] = [];
    const supervisor = new OperationSupervisor({
      prompt: () => new Promise<PromptResult>((resolve, reject) => { finish = resolve; fail = reject; }),
      subscribeOutput: () => () => {},
      cancel() {},
      async forceStop() {},
    }, {
      operationId: "op",
      kind: "turn",
      timers: clock,
      cancelGraceMs: 100,
      limits: reason === "stalled" ? { firstOutputMs: 10 } : {},
      onCancelRequested: (requested) => events.push(`requested:${requested}`),
      onCancelResolved: (resolved, outcome) => events.push(`resolved:${resolved}:${outcome}`),
    });
    const pending = supervisor.run().catch(() => undefined);
    await Promise.resolve();
    if (reason === "stalled") clock.advance(10);
    else supervisor.cancel(reason);
    supervisor.cancel("interrupt");
    settle(finish, fail, clock);
    await pending;
    return events;
  };
  const cancelled = { ...completed(""), status: "cancelled" as const, stopReason: "cancelled" };

  expect(await run("steer", (finish) => finish(cancelled)))
    .toEqual(["requested:steer", "resolved:steer:acknowledged"]);
  expect(await run("interrupt", (_finish, _fail, clock) => clock.advance(100)))
    .toEqual(["requested:interrupt", "resolved:interrupt:forced"]);
  expect(await run("interrupt", (finish) => finish(completed("done"))))
    .toEqual(["requested:interrupt", "resolved:interrupt:too_late"]);
  expect(await run("interrupt", (_finish, fail) => fail(new Error("transport closed"))))
    .toEqual(["requested:interrupt", "resolved:interrupt:failed"]);
  expect(await run("interrupt", (finish) => finish({ ...completed(""), status: "error", stopReason: "error" })))
    .toEqual(["requested:interrupt", "resolved:interrupt:failed"]);
  expect(await run("stalled", (finish) => finish(cancelled)))
    .toEqual(["requested:stalled", "resolved:stalled:acknowledged"]);
});

test("a replaying provider is not stalled; once it stops replaying the stall deadline applies again (bounded)", async () => {
  const clock = new Clock();
  let replaying = true;
  const calls: string[] = [];
  const provider: SupervisedProvider = {
    prompt: () => new Promise(() => {}),
    subscribeOutput: () => () => undefined,
    cancel: () => { calls.push("cancel"); },
    forceStop: async () => {},
  };
  const supervisor = new OperationSupervisor(provider, {
    operationId: "replay",
    kind: "turn",
    timers: clock,
    limits: { firstOutputMs: 100 },
    isReplaying: () => replaying,
  });
  void supervisor.run().catch(() => undefined);
  await Promise.resolve();
  clock.advance(1000); // ten intervals while replaying: never stalled
  expect(calls).toEqual([]);
  replaying = false; // the replay is over and the turn is live, but silent
  clock.advance(100); // one interval later at most: stalled
  expect(calls).toEqual(["cancel"]);
});

test("a provider that never replays keeps today's deadline exactly", async () => {
  const clock = new Clock();
  const calls: string[] = [];
  const provider: SupervisedProvider = {
    prompt: () => new Promise(() => {}),
    subscribeOutput: () => () => undefined,
    cancel: () => { calls.push("cancel"); },
    forceStop: async () => {},
  };
  const supervisor = new OperationSupervisor(provider, { operationId: "live", kind: "turn", timers: clock, limits: { firstOutputMs: 100 }, isReplaying: () => false });
  void supervisor.run().catch(() => undefined);
  await Promise.resolve();
  clock.advance(99);
  expect(calls).toEqual([]);
  clock.advance(1);
  expect(calls).toEqual(["cancel"]);
});

test("a replayed tool still in flight is never stalled while replaying, with no timer storm; it stalls within one interval once live", async () => {
  const clock = new Clock();
  const arm = clock.setTimeout;
  let armings = 0;
  clock.setTimeout = (run: () => void, delay: number) => {
    if (++armings > 200) throw new Error("timer storm: a deadline already in the past was re-armed without delay");
    return arm(run, delay);
  };
  let replaying = true;
  const calls: string[] = [];
  let emit!: OutputListener;
  const provider: SupervisedProvider = {
    prompt: () => new Promise(() => {}),
    subscribeOutput: (fn) => { emit = fn; return () => undefined; },
    cancel: () => { calls.push("cancel"); },
    forceStop: async () => {},
  };
  const supervisor = new OperationSupervisor(provider, {
    operationId: "replayed-tool",
    kind: "turn",
    timers: clock,
    limits: { toolMs: 100 },
    isReplaying: () => replaying,
  });
  void supervisor.run().catch(() => undefined);
  await Promise.resolve();
  emit({ kind: "update", sessionId: null, activity: { kind: "tool", toolCallId: "t1", status: "in_progress" } as never }); // the replay starts a tool
  const armedBefore = armings;
  clock.advance(1000); // ten tool intervals while replaying
  expect(calls).toEqual([]);
  expect(armings - armedBefore).toBeLessThanOrEqual(11); // one re-arm per interval
  replaying = false; // live now, the tool still running
  clock.advance(100); // within one interval: stalled
  expect(calls).toEqual(["cancel"]);
});

test("a tool in flight on a provider that never replays keeps today's deadline exactly", async () => {
  const clock = new Clock();
  const calls: string[] = [];
  let emit!: OutputListener;
  const provider: SupervisedProvider = {
    prompt: () => new Promise(() => {}),
    subscribeOutput: (fn) => { emit = fn; return () => undefined; },
    cancel: () => { calls.push("cancel"); },
    forceStop: async () => {},
  };
  const supervisor = new OperationSupervisor(provider, { operationId: "live-tool", kind: "turn", timers: clock, limits: { toolMs: 100 }, isReplaying: () => false });
  void supervisor.run().catch(() => undefined);
  await Promise.resolve();
  emit({ kind: "update", sessionId: null, activity: { kind: "tool", toolCallId: "t1", status: "in_progress" } as never });
  clock.advance(99);
  expect(calls).toEqual([]);
  clock.advance(1);
  expect(calls).toEqual(["cancel"]);
});

test("a replay check that lands exactly at clock zero still floors the deadline (no zero-delay storm)", async () => {
  const clock = new Clock();
  clock.time = -100; // a clock whose zero falls inside the operation
  const arm = clock.setTimeout;
  let armings = 0;
  clock.setTimeout = (run: () => void, delay: number) => {
    if (++armings > 200) throw new Error("timer storm: the floor was lost at clock zero");
    return arm(run, delay);
  };
  let replaying = true;
  const calls: string[] = [];
  const provider: SupervisedProvider = {
    prompt: () => new Promise(() => {}),
    subscribeOutput: () => () => undefined,
    cancel: () => { calls.push("cancel"); },
    forceStop: async () => {},
  };
  const supervisor = new OperationSupervisor(provider, { operationId: "zero", kind: "turn", timers: clock, limits: { firstOutputMs: 100 }, isReplaying: () => replaying });
  void supervisor.run().catch(() => undefined);
  await Promise.resolve();
  clock.advance(100); // the first deadline is reached at exactly zero, while replaying: skipped
  expect(calls).toEqual([]);
  clock.advance(150);
  expect(calls).toEqual([]); // still replaying: the next check is a full interval after the skip, not immediately
  replaying = false;
  clock.advance(100);
  expect(calls).toEqual(["cancel"]);
});
