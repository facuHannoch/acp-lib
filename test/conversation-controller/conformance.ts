/**
 * The controller conformance suite (controller-interface spec, Brief B2 step 6): one conversation, run on any
 * controller, asserting what the session guarantees whichever backend runs a turn. It runs on the core-only fake
 * and on the real `HarnessController` (lifecycle fixture agent, an Agent-owned conversation); cases that need a
 * backend-started turn or per-turn supervision are fake-only and live in the fake's own files.
 *
 * A subject supplies how to make a turn slow, silent or unreachable; the cases only talk to the conversation.
 * Content delivery to a backend-scheduled controller is NOT covered: the interface has no message payload yet
 * (`errors/11-15-spec-turnrun-no-message-payload.md`), so those cases are pending that decision.
 */
import { describe, expect, test } from "bun:test";
import type { Agent } from "../../src/agent.ts";
import type { AgentSession } from "../../src/agent-session.ts";

export type Seen = { kind: string; [key: string]: any };

export interface OpenConversation {
  readonly agent: Agent;
  readonly session: AgentSession;
  /** Every conversation event, in order. */
  readonly events: Seen[];
  /** Events and committed records interleaved as they happened: `event:<kind>:<turn>`, `record:<id>`, `afterPrompt:<turn>`. */
  readonly timeline: string[];
  /** The provider is running the slow turn (supervised: interrupting now reaches it). */
  isRunning(): boolean;
  /** A prompt whose turn runs until `release()` (the harness: until interrupted). */
  slow(): { text: string; release(): void };
  /** A prompt whose provider says nothing until it is cancelled (stale detection). */
  silent(): string;
  /** Makes the provider unreachable, so the next turn cannot reach it. */
  breakProvider(): Promise<void>;
  /** Holds the Agent-owned finalization (`afterPrompt`) of every turn until released. */
  holdFinalization(): { release(): void };
  /** The turns the controller was told to abandon, when it reports them (the fake does). */
  abandoned?(): readonly string[];
}

export interface Subject {
  readonly name: string;
  /**
   * The controller decides which turn takes which message (the native controller). Three assertions
   * differ for it, by the session's own rules for backend-started turns (`backend-turns.ts`): such a
   * turn writes no user record under its id, `endedBy` is not reported for it, and a message the
   * backend never accepted fails without any turn having existed.
   */
  readonly backendScheduled?: true;
  /**
   * The backend enforces its own deadlines (`conversationCapabilities.supervision: "backend"`), so the
   * host's silence limits do not cancel its turns: a quiet tool is not a stalled provider.
   */
  readonly backendSupervised?: true;
  open(options?: { stale?: boolean }): Promise<OpenConversation>;
}

export const until = async (predicate: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition timed out");
    await Bun.sleep(5);
  }
};

const turnEvents = (events: Seen[]) => events.filter((event) => event.kind.startsWith("turn_")).map((event) => `${event.kind}:${event.turnId}`);
const started = (events: Seen[]) => events.filter((event) => event.kind === "turn_started");

export function runConformance(subject: Subject): void {
  describe(`conformance: ${subject.name}`, () => {
    test("a prompt: turn_started with its cause is not missed, metering and records are written, completion follows finalization", async () => {
      const { session, events, timeline, agent } = await subject.open();
      const handle = session.prompt("hello");
      const result = await handle;
      const id = result.operationId;
      expect(result.status).toBe("completed");
      expect(started(events)[0]).toMatchObject({ turnId: id, cause: { messageIds: [handle.id] } });
      expect(events.filter((event) => event.kind === "metering_recorded").map((event) => event.record.operationId)).toEqual([id]);
      const records = (await agent.persistence.records.list(session.id, { limit: 1000 })).records as unknown as Array<Record<string, any>>;
      if (!subject.backendScheduled) expect(records.some((record) => record.recordId === `${id}:user`)).toBe(true);
      expect(records.some((record) => record.recordId === `${id}:assistant:1`)).toBe(true);
      expect(records.filter((record) => record.kind === "metering" && record.operationId === id).map((record) => record.recordId)).toEqual([`${id}:metering`]);
      const at = (entry: string) => timeline.indexOf(entry);
      for (const entry of [`event:turn_started:${id}`, `record:${id}:assistant:1`, `record:${id}:metering`, `afterPrompt:${id}`, `event:turn_completed:${id}`]) {
        expect({ entry, present: at(entry) >= 0 }).toEqual({ entry, present: true });
      }
      expect(at(`event:turn_started:${id}`)).toBeLessThan(at(`record:${id}:metering`));
      expect(at(`event:turn_completed:${id}`)).toBeGreaterThan(at(`record:${id}:assistant:1`));
      expect(at(`event:turn_completed:${id}`)).toBeGreaterThan(at(`record:${id}:metering`));
      expect(at(`event:turn_completed:${id}`)).toBeGreaterThan(at(`afterPrompt:${id}`));
    }, 30_000);

    test("a second prompt queued behind a running one runs after it; each turn names its own message", async () => {
      const open = await subject.open();
      const slow = open.slow();
      const first = open.session.prompt(slow.text);
      await until(() => open.isRunning());
      const second = open.session.prompt({ text: "second", delivery: "queue" });
      slow.release();
      const [, secondResult] = await Promise.all([first.catch(() => undefined), second]);
      const order = turnEvents(open.events);
      const firstEnd = order.findIndex((entry) => entry.startsWith("turn_completed:") || entry.startsWith("turn_failed:"));
      expect(order.indexOf(`turn_started:${secondResult.operationId}`)).toBeGreaterThan(firstEnd);
      expect(started(open.events)[1]).toMatchObject({ cause: { messageIds: [second.id] } });
    }, 30_000);

    test("withdraw: a queued message withdrawn before dispatch resolves as cancelled and never starts a turn", async () => {
      const open = await subject.open();
      const slow = open.slow();
      const first = open.session.prompt(slow.text);
      await until(() => open.isRunning());
      const queued = open.session.prompt({ text: "never runs", delivery: "queue" });
      expect(queued.withdraw()).toBe(true);
      expect((await queued).status).toBe("cancelled");
      slow.release();
      await first.catch(() => undefined);
      expect(started(open.events)).toHaveLength(1);
    }, 30_000);

    test("interrupt with clearQueue settles queued prompts as cancelled; the running turn ends", async () => {
      const open = await subject.open();
      const slow = open.slow();
      const first = open.session.prompt(slow.text);
      await until(() => open.isRunning());
      const queued = open.session.prompt({ text: "dropped", delivery: "queue" });
      open.session.interrupt({ clearQueue: true });
      expect((await queued).status).toBe("cancelled");
      slow.release();
      await first.catch(() => undefined);
      expect(started(open.events)).toHaveLength(1);
      expect(open.session.state.operation).toBeNull();
    }, 30_000);

    test("interrupt: the running turn ends cancelled, endedBy interrupt, and the conversation goes on", async () => {
      const open = await subject.open();
      const slow = open.slow();
      const handle = open.session.prompt(slow.text);
      await until(() => open.isRunning());
      open.session.interrupt();
      const result = await handle;
      expect(result.status).toBe("cancelled");
      if (!subject.backendScheduled) expect(result.endedBy).toBe("interrupt");
      slow.release();
      expect((await open.session.prompt("after")).status).toBe("completed");
    }, 30_000);

    test("force stop of the backend while a turn runs: that prompt fails with turn_failed, and the next prompt works", async () => {
      const open = await subject.open();
      const slow = open.slow();
      const handle = open.session.prompt(slow.text);
      const outcome = handle.then(() => "settled", () => "rejected");
      await until(() => open.isRunning());
      await open.session.connection.forceStop();
      expect(await outcome).toBe("rejected");
      expect(open.events.some((event) => event.kind === "turn_failed")).toBe(true);
      slow.release();
      expect((await open.session.prompt("after the forced stop")).status).toBe("completed");
    }, 30_000);

    test("stale detection: a silent provider is cancelled, the prompt fails as stalled", async () => {
      const open = await subject.open({ stale: true });
      if (subject.backendSupervised) {
        // The same silent turn, well past the host's limits, is still running; only an explicit stop ends it.
        let settled = false;
        const pending = open.session.prompt(open.silent()).catch((caught) => caught).finally(() => { settled = true; });
        await until(() => open.events.some((event) => event.kind === "turn_started"));
        await Bun.sleep(400);
        expect(settled).toBe(false);
        await open.session.connection.forceStop();
        expect((await pending).code).not.toBe("stalled");
        return;
      }
      const error = await open.session.prompt(open.silent()).catch((caught) => caught);
      expect(error.code).toBe("stalled");
      expect(open.events.some((event) => event.kind === "turn_failed")).toBe(true);
      expect(open.events.filter((event) => event.kind === "metering_recorded")).toHaveLength(1); // metered once, though it failed
    }, 30_000);

    test("a turn that never reaches the provider: turn_failed, the prompt rejects, and (when reported) the turn is abandoned", async () => {
      const open = await subject.open();
      expect((await open.session.prompt("warm up")).status).toBe("completed");
      await open.breakProvider();
      const error = await open.session.prompt("cannot reach").catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      const failed = open.events.filter((event) => event.kind === "turn_failed");
      // Backend-scheduled: the message was never accepted, so no turn started and none can fail.
      expect(failed).toHaveLength(subject.backendScheduled ? 0 : 1);
      if (open.abandoned) expect(open.abandoned()).toContain(failed[0]!.turnId);
      expect(open.session.state.operation).toBeNull();
    }, 30_000);

    test("slow finalization: completion and the next operation both wait for it", async () => {
      const open = await subject.open();
      const hold = open.holdFinalization();
      const first = open.session.prompt("first");
      const second = open.session.prompt({ text: "second", delivery: "queue" });
      await until(() => open.timeline.some((entry) => entry.startsWith("afterPrompt_held:"))); // the provider is done; finalization waits
      expect(open.events.some((event) => event.kind === "turn_completed")).toBe(false);
      expect(started(open.events)).toHaveLength(1); // the next operation has not started
      hold.release();
      const [one, two] = await Promise.all([first, second]);
      const order = turnEvents(open.events);
      expect(order.indexOf(`turn_completed:${one.operationId}`)).toBeLessThan(order.indexOf(`turn_started:${two.operationId}`));
    }, 30_000);
  });
}
