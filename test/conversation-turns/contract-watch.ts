/**
 * Contractual orders (controller-interface spec, "Which orders are contractual"), asserted
 * explicitly for every characterization case:
 * - each stream keeps its own order (records by sequence number, transcript lines by `seq`);
 * - a turn's records and metering belong to it, each appears once, record ids are stable;
 * - metering is recorded after the provider's result;
 * - the final assistant message is recorded before the turn is announced complete;
 * - `turn_completed` comes only after metering, the transcript and `afterPrompt` are done.
 * They are observed on a separate timeline that is never snapshotted.
 *
 * Typed structurally (a conversation with a `connection` whose `prompt` is wrapped, and
 * `subscribe`), so `contract-watch.test.ts` can drive it with synthetic conversations.
 */
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { presentationTurn } from "./pair-rule.ts";

export type Mode = "agent-owned" | "managed" | "detached";

type Item = Record<string, any>;

/** What the watcher needs from a conversation. `AgentSession` satisfies it. */
export interface WatchedConversation {
  readonly connection: { prompt(...args: any[]): Promise<unknown> };
  subscribe(listener: (notification: { readonly event: { readonly kind: string } }) => unknown): unknown;
}

/**
 * A turn whose metering write failed, identified explicitly by the case (none of today's
 * characterization cases has one; the contract for it is an open question in the A2 report):
 * - `"close"`: closing the metered operation itself failed, so there is no metering event and
 *   no metering record for the turn, and its error does not carry a record;
 * - `"record"`: the metering event was emitted (once, after the provider outcome), but the mode's
 *   own record of it (Agent-owned metering record, managed metering reference) was not written.
 */
export type MeteringWriteFailure = "close" | "record";

export interface ContractWatch {
  /** Violations seen while the conversation ran (checked at the moment of `turn_completed`). */
  readonly violations: string[];
  /** Declares a turn whose metering write failed (see `MeteringWriteFailure`). */
  expectMeteringWriteFailure(turnId: string, kind: MeteringWriteFailure): void;
  /** Checks over the whole run: per-stream order, once-only records, provider outcome, bounds. */
  assertRun(mode: Mode, run: Record<string, unknown>): void;
}

/** Errors that carry the turn's closed metering record (`AgentSessionOperationError.metering`, `OperationStalledError.metering`). */
const CARRIES_METERING = /^(AgentSessionOperationError|OperationStalledError): /;
/** A metering preflight rejection: before dispatch, with no record (spec, metering). */
const PREFLIGHT_REJECTION = /^MeteringPreflightError: /;

export function watchContract(
  mode: Mode,
  conversation: WatchedConversation,
  sources: { readonly transcriptPath?: string; readonly committed?: readonly Item[] },
): ContractWatch {
  const violations: string[] = [];
  const timeline: string[] = [];
  const position = (entry: string) => timeline.indexOf(entry);
  const count = (entry: string) => timeline.filter((at) => at === entry).length;
  let openTurn: string | null = null;
  const meteringCount = new Map<string, number>();
  const completed = new Set<string>();
  const failed = new Map<string, string>();
  const writeFailures = new Map<string, MeteringWriteFailure>();

  // The provider's outcome for the open turn: the controller's own prompt settling, with a result
  // or a rejection (a forced stop, a transport failure), or throwing synchronously (for example
  // `requireCurrent` on a controller that is not connected). Every controller the conversation
  // uses is wrapped: the first now, one installed later (a handoff target) at its first turn. The
  // wrapper returns the same promise, or rethrows the same error, so the turn path gains no
  // scheduling point.
  const wrapped = new WeakSet<object>();
  const wrap = (controller: WatchedConversation["connection"]) => {
    if (wrapped.has(controller)) return;
    wrapped.add(controller);
    const prompt = controller.prompt.bind(controller);
    controller.prompt = (...args: any[]) => {
      const turn = openTurn;
      if (turn) timeline.push(`provider_called:${turn}`);
      const settled = () => { if (turn) timeline.push(`provider_outcome:${turn}`); };
      let result: Promise<unknown>;
      try {
        result = prompt(...args);
      } catch (error) {
        settled();
        throw error;
      }
      result.then(settled, settled);
      return result;
    };
  };
  wrap(conversation.connection);

  // Agent-owned finalization, observed directly: `afterPrompt` settling (same promise returned).
  const lifecycle = (conversation as unknown as { ownerLifecycle?: { afterPrompt: (input: any) => Promise<unknown> } }).ownerLifecycle;
  if (mode === "agent-owned" && lifecycle) {
    const afterPrompt = lifecycle.afterPrompt.bind(lifecycle);
    lifecycle.afterPrompt = (input: { operationId: string }) => {
      const result = afterPrompt(input);
      result.then(
        () => { timeline.push(`after_prompt_done:${input.operationId}`); },
        () => { timeline.push(`after_prompt_done:${input.operationId}`); },
      );
      return result;
    };
  }

  const transcript = (): Item[] => {
    if (!sources.transcriptPath) return [];
    const text = (() => { try { return readFileSync(sources.transcriptPath, "utf8"); } catch { return ""; } })();
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };

  /** Whether the expected last assistant message of `turn` was recorded, by mode; or why not. */
  const lastMessageRecorded = (turn: string, messages: readonly Item[]): string | null => {
    const n = messages.length;
    const last = String(messages[n - 1]?.text);
    if (mode === "agent-owned") {
      const finals = (sources.committed ?? []).filter((record) =>
        typeof record.recordId === "string" && new RegExp(`^${turn}:assistant:\\d+$`).test(record.recordId));
      const expected = finals.find((record) => record.recordId === `${turn}:assistant:${n}`);
      if (!expected) return `its final assistant message ${turn}:assistant:${n} was not committed`;
      if (expected.content !== last) return `its committed final assistant message has other content than the last message`;
      const beyond = finals.filter((record) => Number(record.recordId.split(":").pop()) > n);
      if (beyond.length > 0) return `it has committed assistant messages beyond its last (${n})`;
      return null;
    }
    if (mode === "managed") {
      const lines = transcript().filter((line) => line.operationId === turn && line.t === "message" && line.role === "assistant");
      const id = `message:${turn}:assistant:${n}`;
      const terminal = lines.filter((line) => line.presentation?.id === id && line.status !== "in_progress");
      if (terminal.length === 0) return `its final assistant message ${id} was not in the transcript as terminal`;
      const text = (line: Item) => (line.structured?.messages as Item[] | undefined)?.at(-1)?.text ?? line.text;
      if (text(terminal.at(-1)!) !== last) return `its terminal final assistant message has other text than the last message`;
      const beyond = lines.filter((line) => Number(String(line.presentation?.id).split(":").pop()) > n);
      if (beyond.length > 0) return `it has assistant messages beyond its last (${n}) in the transcript`;
      return null;
    }
    // Detached: lines carry no turn id, and each turn appends its one assistant line on its own
    // path before it ends, so at completion the last assistant line is this turn's.
    const line = transcript().filter((entry) => entry.t === "msg" && entry.role === "assistant").at(-1);
    if (!line) return `no assistant line was in the transcript`;
    const texts = ((line.messages as Item[] | undefined) ?? []).map((message) => message.text);
    if (JSON.stringify(texts) !== JSON.stringify(messages.map((message) => message.text))) {
      return `the last assistant line does not hold its messages (last message missing or other)`;
    }
    return null;
  };

  /** Each presentation item's statuses, in arrival order (in-progress may not follow completed). */
  const presentationStatuses = new Map<string, string[]>();
  conversation.subscribe(({ event }) => {
    const e = event as Item;
    if (event.kind === "presentation_recorded") {
      const id = String(e.item?.id);
      presentationStatuses.set(id, [...(presentationStatuses.get(id) ?? []), String(e.item?.status)]);
      timeline.push(`presentation:${presentationTurn({ id })}`);
    } else if (event.kind === "turn_started") {
      openTurn = e.turnId;
      wrap(conversation.connection);
      timeline.push(`turn_started:${e.turnId}`);
    } else if (event.kind === "metering_recorded") {
      const turn = e.record?.operationId as string;
      meteringCount.set(turn, (meteringCount.get(turn) ?? 0) + 1);
      timeline.push(`metering:${turn}`);
    } else if (event.kind === "turn_failed") {
      failed.set(e.turnId, String(e.error));
      timeline.push(`turn_failed:${e.turnId}`);
      if (openTurn === e.turnId) openTurn = null;
    } else if (event.kind === "turn_completed") {
      const turn = e.turnId as string;
      completed.add(turn);
      timeline.push(`turn_completed:${turn}`);
      if (openTurn === turn) openTurn = null;
      // What must already be done at the moment of completion (read synchronously, now).
      const messages = (e.result?.messages ?? []) as Item[];
      if (messages.length > 0) {
        const missing = lastMessageRecorded(turn, messages);
        if (missing) violations.push(`turn ${turn} completed, but ${missing}`);
      }
      if (mode === "managed") {
        const lines = transcript().filter((line) => line.operationId === turn);
        if (!lines.some((line) => line.t === "metering_reference")) violations.push(`turn ${turn} completed before its metering reference was in the transcript`);
        if (!lines.some((line) => line.t === "operation" && line.event !== "started")) violations.push(`turn ${turn} completed before its operation was closed in the transcript`);
      }
    }
  });

  const before = (earlier: string, later: string) => {
    const a = position(earlier);
    const b = position(later);
    return a >= 0 && b >= 0 && a < b;
  };

  /** The metering a failed turn must have, and where; `null` when it must have none. */
  const failedTurnMetering = (turn: string, error: string) => {
    const declared = writeFailures.get(turn);
    const dispatched = position(`provider_called:${turn}`) >= 0;
    if (declared === "close") return { reason: "metering close failed (declared)", metered: false, dispatched };
    if (dispatched) return { reason: "reached the provider", metered: true, dispatched };
    if (PREFLIGHT_REJECTION.test(error)) return { reason: "metering preflight rejection", metered: false, dispatched };
    // Not dispatched: metered when the metered operation was opened and closed before the provider
    // call (the error carries its record), otherwise it failed before the operation opened.
    return CARRIES_METERING.test(error)
      ? { reason: "closed before the provider call", metered: true, dispatched }
      : { reason: "failed before the metered operation", metered: false, dispatched };
  };

  return {
    violations,
    expectMeteringWriteFailure(turnId, kind) {
      writeFailures.set(turnId, kind);
    },
    assertRun(runMode, run) {
      expect(violations).toEqual([]);
      // Presentation events keep their own order: no item goes back to in progress once completed.
      for (const [id, statuses] of presentationStatuses) {
        const completedAt = statuses.findIndex((status) => status !== "in_progress");
        if (completedAt >= 0) expect({ id, after: statuses.slice(completedAt).filter((status) => status === "in_progress") }).toEqual({ id, after: [] });
      }
      for (const [turn, metering] of meteringCount) expect({ turn, metering }).toEqual({ turn, metering: 1 });
      for (const turn of completed) {
        // Over the complete timeline (presentations that arrive later included):
        expect({
          turn,
          meteredOnce: meteringCount.get(turn) ?? 0,
          reachedProvider: position(`provider_called:${turn}`) >= 0,
          outcomeOnce: count(`provider_outcome:${turn}`),
          meteringAfterOutcome: before(`provider_outcome:${turn}`, `metering:${turn}`),
          meteringInsideTurn: before(`turn_started:${turn}`, `metering:${turn}`) && before(`metering:${turn}`, `turn_completed:${turn}`),
          completionAfterLastPresentation: timeline.lastIndexOf(`presentation:${turn}`) < position(`turn_completed:${turn}`),
          ...(runMode === "agent-owned" ? { completionAfterAfterPrompt: before(`after_prompt_done:${turn}`, `turn_completed:${turn}`) } : {}),
        }).toEqual({
          turn,
          meteredOnce: 1,
          reachedProvider: true,
          outcomeOnce: 1,
          meteringAfterOutcome: true,
          meteringInsideTurn: true,
          completionAfterLastPresentation: true,
          ...(runMode === "agent-owned" ? { completionAfterAfterPrompt: true } : {}),
        });
      }
      // Failed turns: one that reached the provider has its outcome, then exactly one metering,
      // then the failure, and its error carries the record. The only exceptions are explicit: a
      // metering preflight rejection or a failure before the metered operation opened (never
      // dispatched, no metering), and a declared metering-write failure.
      for (const [turn, error] of failed) {
        const expected = failedTurnMetering(turn, error);
        const actual = {
          turn,
          reason: expected.reason,
          metering: meteringCount.get(turn) ?? 0,
          ...(expected.dispatched ? { outcomeOnce: count(`provider_outcome:${turn}`) } : {}),
          ...(expected.metered
            ? {
                meteringAfterOutcome: expected.dispatched ? before(`provider_outcome:${turn}`, `metering:${turn}`) : "not dispatched",
                meteringBeforeFailure: before(`metering:${turn}`, `turn_failed:${turn}`),
                errorCarriesRecord: CARRIES_METERING.test(error),
              }
            : {}),
        };
        expect(actual).toEqual({
          turn,
          reason: expected.reason,
          metering: expected.metered ? 1 : 0,
          ...(expected.dispatched ? { outcomeOnce: 1 } : {}),
          ...(expected.metered
            ? {
                meteringAfterOutcome: expected.dispatched ? true : "not dispatched",
                meteringBeforeFailure: true,
                errorCarriesRecord: true,
              }
            : {}),
        });
      }
      // The mode's own metering record: one per metered turn (none for a turn without metering,
      // or whose record write failed by declaration).
      const turns = new Set([...completed, ...failed.keys(), ...meteringCount.keys()]);
      const recordsExpected = (turn: string) =>
        (meteringCount.get(turn) ?? 0) === 1 && writeFailures.get(turn) !== "record" ? 1 : 0;
      const records = run.records as Item | undefined;
      if (runMode === "agent-owned" && records?.records) {
        const list = records.records as Item[];
        const sequences = list.map((record) => record.sequence as number);
        expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
        expect(new Set(sequences).size).toBe(sequences.length);
        const ids = list.map((record) => record.recordId as string);
        expect(new Set(ids).size).toBe(ids.length);
        // The committed-record bus lists exactly the records, in the records' order (raw).
        expect((records.committedBus as Item[]).map((record) => record.recordId)).toEqual(ids);
        for (const turn of turns) {
          expect({ turn, metering: list.filter((record) => record.kind === "metering" && record.operationId === turn).map((record) => record.recordId) })
            .toEqual({ turn, metering: recordsExpected(turn) ? [`${turn}:metering`] : [] });
        }
      }
      if (runMode === "managed" && records?.transcript) {
        const lines = records.transcript as Item[];
        expect(lines.map((line) => line.seq)).toEqual(lines.map((_, index) => index + 1));
        for (const turn of turns) {
          expect({ turn, references: lines.filter((line) => line.t === "metering_reference" && line.operationId === turn).length })
            .toEqual({ turn, references: recordsExpected(turn) });
        }
      }
    },
  };
}
