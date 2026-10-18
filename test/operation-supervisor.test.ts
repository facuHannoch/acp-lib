import { expect, test } from "bun:test";
import { OperationSupervisor, type SupervisedProvider } from "../src/operations/supervisor.ts";
import type { OutputListener } from "../src/operations/contracts.ts";
import type { Timers } from "../src/operations/timers.ts";
class Clock implements Timers {
  time = 0;
  jobs = new Map<number, { at: number; run: () => void }>();
  id = 0;
  now = () => this.time;
  setTimeout = (run: () => void, delay: number) => { const id = ++this.id; this.jobs.set(id, { at: this.time + delay, run }); return id; };
  clearTimeout = (id: unknown) => { this.jobs.delete(id as number); };
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.jobs.delete(next[0]); next[1].run();
    }
    this.time = end;
  }
}
test("ignored cancellation is resent halfway and forced at the deadline", async () => {
  const clock = new Clock(); const calls: string[] = []; let listener!: OutputListener;
  const provider: SupervisedProvider = {
    prompt: () => new Promise(() => {}), subscribeOutput: (fn) => { listener = fn; return () => { calls.push("detach"); }; },
    cancel: () => { calls.push("cancel"); }, forceStop: async () => { calls.push("force"); },
  };
  const stages: string[] = [];
  const supervisor = new OperationSupervisor(provider, { operationId: "one", kind: "turn", timers: clock, cancelGraceMs: 100,
    sessionId: "ours", onStageChanged: (activity) => stages.push(activity.stage) });
  const result = supervisor.run();
  listener({ kind: "request", sessionId: "other" }); expect(supervisor.activity.lastOutputAt).toBeNull();
  listener({ kind: "permission_started", sessionId: "ours" }); expect(supervisor.activity.stage).toBe("awaiting_permission");
  supervisor.cancel("interrupt"); supervisor.cancel("steer");
  clock.advance(49); expect(calls).toEqual(["cancel"]);
  clock.advance(1); expect(calls).toEqual(["cancel", "cancel"]);
  clock.advance(50); expect((await result).cancel).toBe("forced");
  expect(calls).toEqual(["cancel", "cancel", "force", "detach"]);
  expect(stages).toEqual(["waiting", "awaiting_permission", "cancelling"]);
  expect(clock.jobs.size).toBe(0);
});
test("normal settlement removes cancellation timers and subscriptions", async () => {
  const clock = new Clock(); let resolve!: (result: any) => void; let detached = false;
  const supervisor = new OperationSupervisor({ prompt: () => new Promise((done) => { resolve = done; }),
    subscribeOutput: () => () => { detached = true; }, cancel() {}, async forceStop() { throw new Error("unexpected force"); },
  }, { operationId: "one", kind: "turn", timers: clock, cancelGraceMs: 100 });
  const pending = supervisor.run(); await Promise.resolve(); supervisor.cancel("steer");
  resolve({ text: "partial", messages: [{ text: "partial" }], usage: null, status: "cancelled", stopReason: "cancelled" });
  expect((await pending).cancel).toBe("acknowledged"); expect(detached).toBe(true); expect(clock.jobs.size).toBe(0);
});
test("a broken cancellation notification or force primitive cannot leave the request pending", async () => {
  const clock = new Clock();
  const supervisor = new OperationSupervisor({ prompt: () => new Promise(() => {}), subscribeOutput: () => () => {},
    cancel() { throw new Error("connection already closed"); }, forceStop() { throw new Error("cleanup failed"); },
  }, { operationId: "broken", kind: "turn", timers: clock, cancelGraceMs: 10 });
  const pending = supervisor.run(); supervisor.cancel("interrupt"); clock.advance(10);
  expect((await pending).cancel).toBe("forced"); expect(clock.jobs.size).toBe(0);
});
test("a cancel that loses the completion race does not claim acknowledgement", async () => {
  const supervisor = new OperationSupervisor({ async prompt() { return { text: "done", messages: [{ text: "done" }], status: "completed", stopReason: "end_turn", usage: null }; },
    subscribeOutput: () => () => {}, cancel() {}, async forceStop() {},
  }, { operationId: "complete", kind: "turn" });
  const result = supervisor.run(); supervisor.cancel("interrupt"); expect((await result).cancel).toBeUndefined();
});
test("same-stage output updates snapshot timing without producing stage events", async () => {
  const clock = new Clock(); let output!: OutputListener; let finish!: (result: any) => void; const stages: string[] = [];
  const supervisor = new OperationSupervisor({ prompt: () => new Promise((resolve) => { finish = resolve; }),
    subscribeOutput: (listener) => { output = listener; return () => {}; }, cancel() {}, async forceStop() {},
  }, { operationId: "timestamps", kind: "turn", timers: clock, onStageChanged: (activity) => stages.push(activity.stage) });
  const pending = supervisor.run(); await Promise.resolve();
  clock.advance(10); output({ kind: "update", sessionId: null });
  clock.advance(10); output({ kind: "request", sessionId: null });
  expect(stages).toEqual(["waiting", "streaming"]); expect(supervisor.activity.lastOutputAt).toBe(20);
  finish({ text: "done", messages: [], usage: null, stopReason: "end_turn", status: "completed" }); await pending;
});

test("a turn that completes normally after the stall cancel keeps its result", async () => {
  const clock = new Clock();
  let finish!: (result: any) => void;
  const supervisor = new OperationSupervisor({
    prompt: () => new Promise((resolve) => { finish = resolve; }),
    subscribeOutput: () => () => {},
    cancel() {},
    async forceStop() { throw new Error("unexpected force"); },
  }, { operationId: "late", kind: "turn", timers: clock, cancelGraceMs: 1000, limits: { firstOutputMs: 100 } });
  const pending = supervisor.run();
  await Promise.resolve();
  clock.advance(100);
  expect(supervisor.activity.cancel?.reason).toBe("stalled");
  finish({ text: "full answer", messages: [{ text: "full answer" }], usage: null, stopReason: "end_turn", status: "completed" });
  const result = await pending;
  expect(result.status).toBe("completed");
  expect(result.text).toBe("full answer");
  expect(result.cancel).toBeUndefined();
});
