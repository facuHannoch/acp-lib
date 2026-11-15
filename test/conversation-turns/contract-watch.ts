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
 * Typed structurally (a conversation whose `harnessConnection()` has a `prompt` to wrap, and
 * `subscribe`), so `contract-watch.test.ts` can drive it with synthetic conversations.
 */
import { expect } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { presentationTurn } from "./pair-rule.ts";

export type Mode = "agent-owned" | "managed" | "detached";

type Item = Record<string, any>;

/** What the watcher needs from a conversation. `AgentSession` satisfies it. */
export interface WatchedConversation {
  /** The live controller's provider call (the `HarnessController`); null for a backend without one. */
  harnessConnection(): { prompt(...args: any[]): Promise<unknown> } | null;
  subscribe(listener: (notification: { readonly event: { readonly kind: string } }) => unknown): unknown;
}

/**
 * A turn whose metering write failed, identified explicitly by the case (none of today's
 * characterization cases has one). The spec (decided 2026-11-13, beta `0013b0f`) surfaces the
 * error and lets the turn end as today, possibly with no durable record; the watcher cannot tell a
 * write failure from other errors by itself, so a case that produces one declares which:
 * - `"close"`: closing the metered operation itself failed, so there is no metering event and
 *   no metering record for the turn, and its error does not carry a record;
 * - `"record"`: the metering event was emitted (once, after the provider outcome), but the mode's
 *   own record of it (Agent-owned metering record, managed metering reference) was not written.
 */
export type MeteringWriteFailure = "close" | "record";

/**
 * The exact metering a case expects for a turn that opened its metered operation but failed before
 * dispatch. The spec (decided 2026-11-13, beta `0013b0f`) accepts none or one no-usage record, so
 * undeclared, either is accepted (at most one, checked); a case that knows its path declares the
 * actual outcome, so a later change shows. Today's code closes the operation, and so meters it
 * once, for a failure inside the dispatch phase (`prepareTurn`, the supervisor before the provider
 * call), and does not close it for a managed pre-dispatch persistence failure (`beginOperation`,
 * user records, `syncBeforeDispatch`).
 */
export interface OpenedNotDispatched {
  readonly metering: 0 | 1;
}

export interface ContractWatch {
  /** Violations seen while the conversation ran (checked at the moment of `turn_completed`). */
  readonly violations: string[];
  /** Declares a turn whose metering write failed (see `MeteringWriteFailure`). */
  expectMeteringWriteFailure(turnId: string, kind: MeteringWriteFailure): void;
  /** Declares a turn that opened its metered operation and failed before dispatch (see `OpenedNotDispatched`). */
  expectOpenedNotDispatched(turnId: string, expected: OpenedNotDispatched): void;
  /**
   * Declares the exact open-attempt history a case expects for a turn (states in call order), for a
   * history other than one settled attempt. No rule about retrying `open()` is decided (the spec's
   * idempotent metering *write* says nothing about it), so the watcher neither forbids nor accepts
   * a repeated open by itself: an undeclared one fails with its history.
   */
  expectOpenAttempts(turnId: string, states: readonly ("opened" | "rejected")[]): void;
  /** Checks over the whole run: per-stream order, once-only records, provider outcome, bounds. */
  assertRun(mode: Mode, run: Record<string, unknown>): void;
}

/** A metering preflight rejection, observed as the rejection of the metered operation's open. */
const isPreflightRejection = (error: unknown) => error instanceof Error && error.name === "MeteringPreflightError";
/**
 * Whether a metering record attributes no usage to its operation: the "no-usage record" the spec
 * allows for an operation that opened metering but never reached the provider (beta `0013b0f`).
 * Returns why not, or null. Only a recognized shape, complete enough to establish zero, counts as
 * no usage; anything unknown or incomplete fails, as "not established".
 *
 * The shapes are the library's own types: `MeteringUsageResult` (`src/metering/record.ts`),
 * `AttributableUsage` and `PricedTokenAmount` (`src/metering/rating.ts`), `TokenUsage`
 * (`src/types.ts`) and `MoneyTotal` / `Money` (`src/metering/money.ts`).
 * - **Not metered:** `status` is one of `usage_unavailable`, `baseline_required` or
 *   `counter_reset`, with a string `reason`, and no `attributable` (the type has none). Nothing is
 *   attributed.
 * - **Metered:** `attributable` must establish zero:
 *   - `totalTokens` is 0;
 *   - `reportedDelta` is a `TokenUsage` with `totalTokens`, `inputTokens` and `outputTokens` at 0,
 *     and any optional counter present at 0;
 *   - `input` and `output` (required), and `cachedRead`, `cachedWrite` and `thought` when present,
 *     are `PricedTokenAmount`s: `reportedTokens` 0, `pricedTokens` null or 0, `pricing` null or
 *     with a zero `ratedCost`;
 *   - `ratedTotal` is a `MoneyTotal`: an `amounts` array of zero `Money` (a zero decimal string
 *     and a string currency), and `unaccounted` 0;
 *   - `lineItems` is absent or empty; per-model line items are not interpreted, so they fail.
 * - **`usage.reportedCumulative` is never read,** in either shape. It is the provider's
 *   session-cumulative counter, not this operation's, and is optional when not metered.
 * - **Any other `status`,** or a missing or ill-typed required field, fails.
 */
export function attributedUsageProblem(record: Item | undefined): string | null {
  const usage = record?.usage as Item | undefined;
  if (!usage || typeof usage !== "object") return "the record has no usage result";
  if (NOT_METERED.has(usage.status)) {
    if (typeof usage.reason !== "string") return `a ${String(usage.status)} result without a string reason`;
    if ("attributable" in usage) return `a ${String(usage.status)} result carrying attributable usage, which that shape does not have`;
    return null;
  }
  if (usage.status !== "metered") return `an unrecognized usage status ${JSON.stringify(usage.status)}`;
  const attributable = usage.attributable as Item | undefined;
  if (!attributable || typeof attributable !== "object") return "a metered result without attributable usage";
  const problems: string[] = [];
  const zero = (value: unknown, label: string, optional = false) => {
    if (value === undefined && optional) return;
    if (typeof value !== "number" || !Number.isFinite(value)) problems.push(`${label} missing or not a number`);
    else if (value !== 0) problems.push(`${label}=${value}`);
  };
  zero(attributable.totalTokens, "totalTokens");
  const delta = attributable.reportedDelta as Item | undefined;
  if (!delta || typeof delta !== "object") problems.push("reportedDelta missing");
  else {
    for (const key of ["totalTokens", "inputTokens", "outputTokens"]) zero(delta[key], `reportedDelta.${key}`);
    for (const key of ["cachedReadTokens", "cachedWriteTokens", "thoughtTokens"]) zero(delta[key], `reportedDelta.${key}`, true);
    for (const key of Object.keys(delta)) {
      if (!TOKEN_USAGE_KEYS.has(key)) problems.push(`reportedDelta.${key} is not a TokenUsage field`);
    }
  }
  for (const [category, required] of [["input", true], ["output", true], ["cachedRead", false], ["cachedWrite", false], ["thought", false]] as const) {
    const amount = attributable[category] as Item | undefined;
    if (amount === undefined && !required) continue;
    if (!amount || typeof amount !== "object") { problems.push(`${category} missing`); continue; }
    zero(amount.reportedTokens, `${category}.reportedTokens`);
    if (amount.pricedTokens !== null) zero(amount.pricedTokens, `${category}.pricedTokens`);
    if (amount.pricing !== null) {
      if (!amount.pricing || typeof amount.pricing !== "object" || !isZeroMoney(amount.pricing.ratedCost)) problems.push(`${category}.pricing without a zero ratedCost`);
    }
  }
  const total = attributable.ratedTotal as Item | undefined;
  if (!total || typeof total !== "object" || !Array.isArray(total.amounts)) problems.push("ratedTotal missing or without an amounts array");
  else {
    if (!(total.amounts as unknown[]).every(isZeroMoney)) problems.push(`ratedTotal amounts other than zero: ${JSON.stringify(total.amounts)}`);
    zero(total.unaccounted, "ratedTotal.unaccounted");
  }
  if (attributable.lineItems !== undefined && !(Array.isArray(attributable.lineItems) && attributable.lineItems.length === 0)) {
    problems.push("per-model line items, which are not interpreted");
  }
  return problems.length === 0 ? null : `not established as no usage: ${problems.join("; ")}`;
}

/** The `MeteringUsageResult` statuses other than `metered` (`src/metering/record.ts`). */
const NOT_METERED = new Set(["usage_unavailable", "baseline_required", "counter_reset"]);
/** `TokenUsage`'s fields (`src/types.ts`). */
const TOKEN_USAGE_KEYS = new Set(["totalTokens", "inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens"]);
/** A `Money` (`src/metering/money.ts`) whose decimal-string amount is zero. */
const isZeroMoney = (money: unknown): boolean => {
  const value = money as Item | undefined;
  return !!value && typeof value.currency === "string" && typeof value.amount === "string"
    && /^[+-]?\d*(\.\d*)?$/.test(value.amount) && /\d/.test(value.amount) && /^[+-]?0*(\.0*)?$/.test(value.amount);
};

/** Errors that carry the turn's closed metering record (`AgentSessionOperationError.metering`, `OperationStalledError.metering`). */
const CARRIES_METERING = /^(AgentSessionOperationError|OperationStalledError): /;

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
  /** Each turn's metering records, as emitted (`metering_recorded.record`). */
  const meteringRecords = new Map<string, Item[]>();
  const completed = new Set<string>();
  const failed = new Map<string, string>();
  const writeFailures = new Map<string, MeteringWriteFailure>();
  const openedNotDispatched = new Map<string, OpenedNotDispatched>();
  const declaredAttempts = new Map<string, readonly string[]>();
  /**
   * Each operation's metered-operation open attempts, in call order: recorded as `pending` when the
   * call is made, then `opened`, or `rejected` with its error. Kept whole, so a second attempt never
   * hides the first.
   */
  type OpenAttempt = { state: "pending" | "opened" | "rejected"; error?: unknown };
  const openAttempts = new Map<string, OpenAttempt[]>();
  const pendingOpens = (turn: string) => (openAttempts.get(turn) ?? []).filter((attempt) => attempt.state === "pending").length;

  // The provider's outcome for the open turn: the controller's own prompt settling, with a result
  // or a rejection (a forced stop, a transport failure), or throwing synchronously (for example
  // `requireCurrent` on a controller that is not connected). Every controller the conversation
  // uses is wrapped: the first now, one installed later (a handoff target) at its first turn. The
  // wrapper returns the same promise, or rethrows the same error, so the turn path gains no
  // scheduling point.
  const wrapped = new WeakSet<object>();
  const wrap = (controller: { prompt(...args: any[]): Promise<unknown> } | null) => {
    if (!controller) return;
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
  wrap(conversation.harnessConnection());

  // The metered-operation boundary, observed directly: the session's metering engine `open`
  // settling (resolved: opened; rejected or thrown: not opened), keyed by the operation id it was
  // opened for. Same promise returned or same error rethrown. The engine is a private seam (like
  // `ownerLifecycle`); a handoff installs another engine, wrapped at the next `turn_started`.
  const wrappedEngines = new WeakSet<object>();
  const wrapEngine = () => {
    const engine = (conversation as unknown as { metering?: { open: (input: { operationId: string }) => Promise<unknown> } }).metering;
    if (!engine || typeof engine.open !== "function" || wrappedEngines.has(engine)) return;
    wrappedEngines.add(engine);
    const open = engine.open.bind(engine);
    engine.open = (input: { operationId: string }) => {
      const id = String(input?.operationId);
      const attempt: OpenAttempt = { state: "pending" };
      openAttempts.set(id, [...(openAttempts.get(id) ?? []), attempt]);
      let result: Promise<unknown>;
      try {
        result = open(input);
      } catch (error) {
        attempt.state = "rejected";
        attempt.error = error;
        throw error;
      }
      result.then(
        () => { attempt.state = "opened"; timeline.push(`metering_opened:${id}`); },
        (error) => { attempt.state = "rejected"; attempt.error = error; },
      );
      return result;
    };
  };
  wrapEngine();

  // Detached: the transcript's byte length when each turn started. The turn's own lines are the
  // ones after it (turns run one at a time; the previous turn's lines are complete by then).
  const transcriptOffsets = new Map<string, number>();
  const transcriptSize = () => {
    if (!sources.transcriptPath) return 0;
    try { return statSync(sources.transcriptPath).size; } catch { return 0; }
  };

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

  /** The transcript's lines; from `offset` bytes on, when given. */
  const transcript = (offset = 0): Item[] => {
    if (!sources.transcriptPath) return [];
    const text = (() => {
      try { return readFileSync(sources.transcriptPath).subarray(offset).toString("utf8"); } catch { return ""; }
    })();
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
    // Detached: lines carry no turn id, so the turn's segment is what was appended after its
    // `turn_started`: its user line, then exactly one assistant line holding exactly its messages.
    const offset = transcriptOffsets.get(turn);
    if (offset === undefined) return `its start was not observed, so its transcript segment is unknown`;
    const segment = transcript(offset).filter((entry) => entry.t === "msg");
    const assistant = segment.filter((entry) => entry.role === "assistant");
    if (assistant.length !== 1) return `its transcript segment has ${assistant.length} assistant lines, not 1`;
    const at = segment.indexOf(assistant[0]!);
    if (!segment.slice(0, at).some((entry) => entry.role === "user")) return `its transcript segment has no user line before its assistant line`;
    if (at !== segment.length - 1) return `its transcript segment has lines after its assistant line`;
    const texts = ((assistant[0]!.messages as Item[] | undefined) ?? []).map((message) => message.text);
    if (JSON.stringify(texts) !== JSON.stringify(messages.map((message) => message.text))) {
      return `its assistant line does not hold its messages (last message missing or other)`;
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
      wrap(conversation.harnessConnection());
      wrapEngine();
      if (mode === "detached") transcriptOffsets.set(e.turnId, transcriptSize());
      timeline.push(`turn_started:${e.turnId}`);
    } else if (event.kind === "metering_recorded") {
      const turn = e.record?.operationId as string;
      meteringCount.set(turn, (meteringCount.get(turn) ?? 0) + 1);
      meteringRecords.set(turn, [...(meteringRecords.get(turn) ?? []), e.record as Item]);
      timeline.push(`metering:${turn}`);
    } else if ((event.kind === "turn_failed" || event.kind === "turn_completed") && pendingOpens(e.turnId) > 0) {
      // The turn ended while its open had not settled: its boundary was unknown at the end. Kept
      // as a violation even if the open settles later (a late success).
      violations.push(`turn ${e.turnId} ended with its metering open still pending`);
    }
    if (event.kind === "turn_failed") {
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

  /**
   * The metering a failed turn must have. Classified from what was observed (the provider call and
   * the metered operation's open, its last attempt), never from the error text alone.
   */
  const failedTurnMetering = (turn: string): { reason: string; metered: boolean; dispatched: boolean } => {
    const declared = writeFailures.get(turn);
    const dispatched = position(`provider_called:${turn}`) >= 0;
    const open = openAttempts.get(turn)?.at(-1);
    if (declared === "close") return { reason: "metering close failed (declared)", metered: false, dispatched };
    if (dispatched) return { reason: "reached the provider", metered: true, dispatched };
    if (!open) return { reason: "failed before the metered operation was opened", metered: false, dispatched };
    if (open.state !== "opened") {
      return { reason: isPreflightRejection(open.error) ? "metering preflight rejection" : "the metered operation's open failed", metered: false, dispatched };
    }
    const expected = openedNotDispatched.get(turn);
    if (!expected) {
      // None or one accepted (spec, 0013b0f); one is then checked like any metering (below), and
      // more than one fails the once-only check.
      const metered = (meteringCount.get(turn) ?? 0) > 0;
      return { reason: `opened, not dispatched (none or one accepted; here ${metered ? "one" : "none"})`, metered, dispatched };
    }
    return { reason: `opened, not dispatched (declared: metering ${expected.metering})`, metered: expected.metering === 1, dispatched };
  };

  /**
   * Whether the turn's open history is one the watcher can classify: settled, and either one
   * attempt or exactly the history the case declared. An open still pending fails (its boundary is
   * unknown); an undeclared repeated open fails with its history, because no rule about retrying
   * `open()` is decided, so the watcher assumes none either way; continuing after the only attempt
   * was rejected fails.
   */
  const openHistoryProblem = (turn: string): string | null => {
    const attempts = openAttempts.get(turn) ?? [];
    const states = attempts.map((attempt) => attempt.state);
    if (states.includes("pending")) return `its metering open is still pending, so its boundary is unknown (${states.join(", ")})`;
    const declared = declaredAttempts.get(turn);
    if (declared) {
      return JSON.stringify(declared) === JSON.stringify(states)
        ? null
        : `its open attempts (${states.join(", ") || "none"}) are not the declared ones (${declared.join(", ")})`;
    }
    if (attempts.length > 1) {
      return `its metered operation was opened ${attempts.length} times (${states.join(", ")}); no rule about retrying open() is decided, so the case must declare the history it expects (expectOpenAttempts)`;
    }
    if (states[0] === "rejected") {
      const continued = position(`provider_called:${turn}`) >= 0 || (meteringCount.get(turn) ?? 0) > 0 || completed.has(turn);
      if (continued) return `it continued after its metering open was rejected`;
    }
    return null;
  };

  return {
    violations,
    expectMeteringWriteFailure(turnId, kind) {
      writeFailures.set(turnId, kind);
    },
    expectOpenedNotDispatched(turnId, expected) {
      openedNotDispatched.set(turnId, expected);
    },
    expectOpenAttempts(turnId, states) {
      declaredAttempts.set(turnId, [...states]);
    },
    assertRun(runMode, run) {
      expect(violations).toEqual([]);
      for (const turn of [...completed, ...failed.keys()]) {
        expect({ turn, openHistory: openHistoryProblem(turn) }).toEqual({ turn, openHistory: null });
      }
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
          openedBeforeDispatch: before(`metering_opened:${turn}`, `provider_called:${turn}`),
          meteringAfterOutcome: before(`provider_outcome:${turn}`, `metering:${turn}`),
          meteringInsideTurn: before(`turn_started:${turn}`, `metering:${turn}`) && before(`metering:${turn}`, `turn_completed:${turn}`),
          completionAfterLastPresentation: timeline.lastIndexOf(`presentation:${turn}`) < position(`turn_completed:${turn}`),
          ...(runMode === "agent-owned" ? { completionAfterAfterPrompt: before(`after_prompt_done:${turn}`, `turn_completed:${turn}`) } : {}),
        }).toEqual({
          turn,
          meteredOnce: 1,
          reachedProvider: true,
          outcomeOnce: 1,
          openedBeforeDispatch: true,
          meteringAfterOutcome: true,
          meteringInsideTurn: true,
          completionAfterLastPresentation: true,
          ...(runMode === "agent-owned" ? { completionAfterAfterPrompt: true } : {}),
        });
      }
      // Failed turns, classified from what was observed: one that reached the provider opened its
      // metered operation first, has its outcome, then exactly one metering, then the failure, and
      // its error carries the record. Not dispatched: no metering when the open was never reached
      // or failed (a preflight rejection among them); opened but not dispatched: none or one (spec,
      // 0013b0f), exactly as declared when the case declares it. A metering-write failure is declared.
      for (const [turn, error] of failed) {
        const expected = failedTurnMetering(turn);
        const actual = {
          turn,
          reason: expected.reason,
          metering: meteringCount.get(turn) ?? 0,
          ...(expected.dispatched
            ? { outcomeOnce: count(`provider_outcome:${turn}`), openedBeforeDispatch: before(`metering_opened:${turn}`, `provider_called:${turn}`) }
            : {}),
          ...(expected.metered
            ? {
                meteringAfterOutcome: expected.dispatched ? before(`provider_outcome:${turn}`, `metering:${turn}`) : "not dispatched",
                meteringBeforeFailure: before(`metering:${turn}`, `turn_failed:${turn}`),
                errorCarriesRecord: CARRIES_METERING.test(error),
                // Never dispatched: the one record allowed is a no-usage record (spec, 0013b0f).
                ...(expected.dispatched ? {} : { attributedUsage: attributedUsageProblem(meteringRecords.get(turn)?.[0]) ?? "none" }),
              }
            : {}),
        };
        expect(actual).toEqual({
          turn,
          reason: expected.reason,
          metering: expected.metered ? 1 : 0,
          ...(expected.dispatched ? { outcomeOnce: 1, openedBeforeDispatch: true } : {}),
          ...(expected.metered
            ? {
                meteringAfterOutcome: expected.dispatched ? true : "not dispatched",
                meteringBeforeFailure: true,
                errorCarriesRecord: true,
                ...(expected.dispatched ? {} : { attributedUsage: "none" }),
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
