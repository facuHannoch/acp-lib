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
