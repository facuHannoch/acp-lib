import { describe, expect, test } from "bun:test";
import { AIR_CLIENT_CAPABILITY_META, providerNoticeFromMeta } from "../src/provider-notices.ts";
import { toActivityEvent } from "../src/updates.ts";
import { OperationSupervisor } from "../src/operations/supervisor.ts";
import { OperationStalledError } from "../src/operations/errors.ts";
import type { OutputListener } from "../src/operations/contracts.ts";
import type { Timers } from "../src/operations/timers.ts";
import type { PromptResult } from "../src/types.ts";

// The exact shape codex-acp 2.1.1 sends a client that doesn't advertise AIR (its retry path).
const codexRetry = {
  sessionUpdate: "session_info_update",
  _meta: {
    codex: {
      error: {
        message: "exceeded retry limit, last status: 429 Too Many Requests",
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
        turnId: "turn-7",
        willRetry: true,
      },
    },
  },
};

// The AIR session failure codex-acp and claude-agent-acp send once the client advertises it.
const airRetry = {
  sessionUpdate: "session_info_update",
  _meta: {
    jetbrains: {
      air: {
        version: 1,
        sessionFailure: {
          id: "turn-7:error",
          revision: 2,
          category: "limit",
          severity: "warning",
          title: "Retrying Claude, attempt 2 of 10.",
          actions: [],
        },
      },
    },
  },
};

describe("provider notices", () => {
  test("advertises the AIR session failure capability adapters check", () => {
    const air = (AIR_CLIENT_CAPABILITY_META.jetbrains as { air: { version: number; capabilities: readonly string[] } }).air;
    expect(air.version).toBe(1);
    expect(air.capabilities).toContain("sessionFailure");
  });

  test("Codex's retry warning becomes a non-terminal rate-limit notice instead of a bare session_info", () => {
    const activity = toActivityEvent(codexRetry as never);
    expect(activity).toEqual({
      kind: "provider_notice",
      noticeId: "codex:turn-7",
      revision: 1,
      severity: "warning",
      category: "limit",
      code: "rate_limited",
      title: "exceeded retry limit, last status: 429 Too Many Requests",
      actions: [],
      httpStatus: 429,
      willRetry: true,
      source: "codex",
    });
  });

  test("Codex's final error (willRetry false) is an error-severity notice", () => {
    const update = structuredClone(codexRetry);
    update._meta.codex.error.willRetry = false;
    const activity = toActivityEvent(update as never);
    expect(activity).toMatchObject({ kind: "provider_notice", severity: "error", code: "rate_limited", actions: ["retry"] });
  });

  test("an AIR session failure keeps its id, revision, category, severity, title and actions", () => {
    const activity = toActivityEvent(airRetry as never);
    expect(activity).toEqual({
      kind: "provider_notice",
      noticeId: "turn-7:error",
      revision: 2,
      severity: "warning",
      category: "limit",
      title: "Retrying Claude, attempt 2 of 10.",
      actions: [],
      source: "air",
    });
  });

  test("unknown actions are dropped and AIR wins over the Codex shape", () => {
    const meta = {
      codex: codexRetry._meta.codex,
      jetbrains: { air: { sessionFailure: { id: "n1", severity: "error", category: "access", title: "Sign in", actions: ["login", "explode"] } } },
    };
    expect(providerNoticeFromMeta(meta)).toMatchObject({ noticeId: "n1", severity: "error", actions: ["login"], source: "air" });
  });

  test("a session_info_update without a notice keeps its unknown _meta instead of dropping it", () => {
    const activity = toActivityEvent({ sessionUpdate: "session_info_update", title: "t", _meta: { other: { x: 1 } } } as never);
    expect(activity).toEqual({ kind: "session_info", title: "t", updatedAt: null, meta: { other: { x: 1 } } });
  });

  test("a usage update keeps its _meta (claude-agent-acp's rate limit details)", () => {
    const activity = toActivityEvent({ sessionUpdate: "usage_update", used: 10, size: 100, _meta: { "_claude/rateLimit": { status: "allowed" } } } as never);
    expect(activity).toMatchObject({ kind: "usage", meta: { "_claude/rateLimit": { status: "allowed" } } });
  });
});

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
  clearTimeout = (id: unknown) => { this.jobs.delete(id as number); };
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

const cancelled: PromptResult = { text: "", messages: [], usage: null, stopReason: "cancelled", status: "cancelled" } as never;

function supervisedWithOutput(limits: { firstOutputMs: number; nextOutputMs: number }) {
  const clock = new Clock();
  let listener!: OutputListener;
  let finish!: (result: PromptResult) => void;
  const supervisor = new OperationSupervisor({
    prompt: () => new Promise<PromptResult>((resolve) => { finish = resolve; }),
    subscribeOutput: (l) => { listener = l; return () => {}; },
    cancel() { finish(cancelled); },
    async forceStop() {},
  }, { operationId: "op-1", kind: "turn", timers: clock, cancelGraceMs: 1000, limits });
  return { clock, supervisor, emit: (activity: unknown) => listener({ kind: "update", sessionId: null, activity: activity as never }) };
}

describe("stall during a provider retry", () => {
  test("the stall error carries the retry notice, naming the cause", async () => {
    const { clock, supervisor, emit } = supervisedWithOutput({ firstOutputMs: 1000, nextOutputMs: 180 });
    const pending = supervisor.run();
    await Promise.resolve();
    emit(toActivityEvent(codexRetry as never));
    clock.advance(180);
    const error = await pending.then(() => undefined, (e) => e);
    expect(error).toBeInstanceOf(OperationStalledError);
    expect((error as OperationStalledError).notice).toEqual({
      title: "exceeded retry limit, last status: 429 Too Many Requests",
      category: "limit",
      code: "rate_limited",
    });
  });

  test("real output after the notice clears it: a later stall is a plain stall", async () => {
    const { clock, supervisor, emit } = supervisedWithOutput({ firstOutputMs: 1000, nextOutputMs: 180 });
    const pending = supervisor.run();
    await Promise.resolve();
    emit(toActivityEvent(codexRetry as never));
    emit({ kind: "text", text: "back" });
    clock.advance(180);
    const error = await pending.then(() => undefined, (e) => e);
    expect(error).toBeInstanceOf(OperationStalledError);
    expect((error as OperationStalledError).notice).toBeUndefined();
  });
});
