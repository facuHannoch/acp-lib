// Folds the ACP delta stream into full-state records.
//
// The protocol streams tool calls and thinking as deltas: a tool call is announced before
// its input is known, updates carry only changed fields, and `content` REPLACES rather
// than accumulates. Every consumer that renders activity has to fold that, and until now
// each one hand-rolled it from a README snippet. This module is that fold, published —
// the same relationship `updates.ts` has to the wire format: the library owns what the
// protocol MEANS, callers own what to draw.
//
// INVARIANT: exactly one aggregator per STREAM, for the life of that stream. Call
// `startTurn()` between turns rather than constructing a new one — `seq` must keep
// counting across turns, or a subscriber's discard threshold goes stale and silently eats
// the start of the next turn (see `snapshot`). `recordId`s for kinds the protocol doesn't
// identify are instance-local counters, so a second instance over the same stream would
// also mint different ids for the same thing. When using AgentSession, take its output —
// don't build a second one.
//
// SCOPE: ACP guarantees `toolCallId`, `planId` and `messageId` are unique "within a
// session", so ids derived from them are used verbatim. Everything else here is MINTED
// from a per-instance counter and is therefore only turn-unique — pass `idPrefix` to
// scope those, or a transcript spanning several turns will have a `think-1` per turn and
// last-wins folding will collapse them all into one.
//
// Pure by contract: no I/O, no runtime imports, erasable syntax only. A test enforces it,
// so this file stays safe to compile for a browser if a consumer ever needs to fold
// locally.

import type { ActivityEvent, ToolActivity } from "./types.ts";

/** Where a record sits in its lifecycle. Persisted, so readers can filter without folding. */
export type EmitReason =
  | "announced" // first seen
  | "input" // a tool call first learned its rawInput
  | "settled" // terminal status reached, or a thinking block ended
  | "flushed" // the turn ended with the record still open
  | "snapshot"; // inherently complete on arrival

/** Full state of one thing that happened, identified for last-wins folding. */
export interface AggregatedRecord {
  recordId: string;
  /** Per-turn logical clock. Every frame from one apply() shares a seq. */
  seq: number;
  reason: EmitReason;
  /** Always FULL state, never a delta. */
  event: ActivityEvent;
}

/**
 * The incremental piece, for kinds this module ACCUMULATES rather than replaces.
 *
 * Only thinking qualifies today. Tool calls are already cumulative on the wire — the
 * agent resends the whole `content` each time — so a full record costs no more than the
 * raw event. Thinking arrives as many small chunks, where re-sending the accumulated
 * block per chunk is quadratic: ~4 KB of text becomes ~800 KB over 400 chunks.
 *
 * Never produced for the chunk that OPENS a block: a delta is an increment on state the
 * consumer already has, and on the opening chunk there is none. That chunk's `current` is
 * the base record, and it is exactly as small as the delta would have been.
 */
export interface ActivityDelta {
  recordId: string;
  seq: number;
  kind: "thinking";
  append: string;
}

/** What a live transport carries. Records are self-contained; deltas need a base. */
export type ActivityFrame = AggregatedRecord | ActivityDelta;

export interface ApplyResult {
  /** Full state of whatever this event touched. Null only if it produced no record. */
  current: AggregatedRecord | null;
  /**
   * Set for accumulating kinds, EXCEPT on the event that opens the record. When present,
   * prefer it over `current` on the wire; when null, `current` is what has to go, or the
   * consumer never gets a base to append to.
   */
  delta: ActivityDelta | null;
  /** Checkpoints worth persisting. Usually empty. */
  emitted: AggregatedRecord[];
}

/** Everything known about the turn IN FLIGHT — for replaying to a late subscriber. */
export interface ActivitySnapshot {
  /**
   * Whether a turn is in flight. False before the first one and between turns, when
   * `records` is empty.
   *
   * Distinguishes "no turn running" from "a turn that has not produced anything yet" —
   * both return no records, but only the second means frames are coming. It reflects what
   * this aggregator has been told: a caller that knows more (a hub tracking which sessions
   * are busy, say) should trust itself over this.
   */
  active: boolean;
  /**
   * Frames with `seq <= this` are already reflected here and must be discarded.
   *
   * Monotonic for the life of the aggregator, ACROSS turns — so a consumer can store this
   * threshold once and filter forever without knowing where turns begin. That is why
   * `startTurn()` exists and why constructing a fresh aggregator per turn is wrong: the
   * clock would restart and a stale threshold would silently drop the next turn's opening
   * frames.
   */
  seq: number;
  /**
   * Empty between turns. A settled turn's records belong to the transcript, not to a
   * replay: handing them to a client that connects mid-idle would put activity into its
   * log before the surrounding messages have loaded — activity with no turn around it.
   */
  records: AggregatedRecord[];
}

export interface ActivityAggregatorOptions {
  /**
   * Emit an extra checkpoint the first time a tool call learns its `rawInput`. Default
   * true: agents commonly announce a call long before they know its arguments (Kimi
   * sends rawInput on update 13 of 14), so without this a crash mid-call persists a
   * record that names the tool but not what it was doing.
   */
  checkpointOnInput?: boolean;
  /**
   * Namespace for MINTED record ids (`think-1`, `plan`, `usage`, …), which are otherwise
   * only unique within this instance's turn. Ids the protocol guarantees session-unique
   * are never prefixed.
   *
   * Sets the prefix for the FIRST turn; `startTurn()` sets it thereafter. Required
   * whenever records outlive the turn — the transcript accumulates across turns, so
   * `AgentSession` passes a per-turn value. That value must be stable across process
   * restarts: an in-memory turn counter restarts at 0 when a session is resumed and would
   * collide with ids already on disk. Use a timestamp or a random id.
   */
  idPrefix?: string;
}

/** Statuses ACP defines as terminal. */
const TERMINAL_STATUS = ["completed", "failed"];

/**
 * Whether a tool call actually knows its arguments yet.
 *
 * Agents announce a call with a PLACEHOLDER — `rawInput: {}` is common (both Kimi and the
 * test fixture do it) — and fill the real arguments in later. Treating the placeholder as
 * "input known" would skip the input checkpoint, so a turn that died between learning the
 * command and finishing it would persist a record naming the tool but not what it ran.
 */
function hasInput(rawInput: unknown): boolean {
  if (rawInput === undefined || rawInput === null) return false;
  if (typeof rawInput === "string") return rawInput.length > 0;
  if (Array.isArray(rawInput)) return rawInput.length > 0;
  if (typeof rawInput === "object") return Object.keys(rawInput).length > 0;
  return true;
}

export class ActivityAggregator {
  private checkpointOnInput: boolean;
  private idPrefix: string;
  // False until the first event or `startTurn()`. A freshly constructed aggregator has not
  // seen a turn, and saying otherwise puts a spinner in front of any client that connects
  // while the session is still coming up — with no `flush()` ever coming to end it.
  private turnOpen = false;
  private seq = 0;
  private records = new Map<string, AggregatedRecord>();
  private calls = new Map<string, ToolActivity>();
  private settled = new Set<string>();
  private inputSeen = new Set<string>();
  private thinking: { recordId: string; messageId?: string; text: string } | null = null;
  private counters = new Map<string, number>();
  private pendingUsage: ActivityEvent | null = null;

  constructor(options: ActivityAggregatorOptions = {}) {
    this.checkpointOnInput = options.checkpointOnInput !== false;
    this.idPrefix = options.idPrefix ? `${options.idPrefix}:` : "";
  }

  /** Fold one live event. */
  apply(event: ActivityEvent): ApplyResult {
    this.seq++;
    this.turnOpen = true; // an event IS a turn in flight, `startTurn()` or not

    const emitted: AggregatedRecord[] = [];

    // A thinking block ends when something else happens. Emit its close BEFORE the
    // record that ended it, so append order matches causal order.
    const closed = this.closeThinkingFor(event);
    if (closed) emitted.push(closed);

    switch (event.kind) {
      case "thinking":
        return this.foldThinking(event, emitted);
      case "tool":
        return this.foldTool(event, emitted);
      case "tool_update":
        return this.foldToolUpdate(event, emitted);
      case "usage": {
        // Coalesced: many per turn, only the last is worth persisting. `current` is still
        // the live record so a caller can render a context meter.
        this.pendingUsage = event;
        return {
          current: this.put(this.minted("usage"), "snapshot", event),
          delta: null,
          emitted,
        };
      }
      default: {
        const record = this.put(this.recordIdFor(event), "snapshot", event);
        emitted.push(record);
        return { current: record, delta: null, emitted };
      }
    }
  }

  /**
   * Close everything still open. Call once at turn end, on BOTH the success and error
   * paths — an unsettled call written at its real status is the record of what the turn
   * was doing when it died.
   */
  flush(): AggregatedRecord[] {
    this.seq++;
    const out: AggregatedRecord[] = [];

    const closed = this.closeThinking();
    if (closed) out.push(closed);

    for (const [id, call] of this.calls) {
      if (this.settled.has(id)) continue;
      this.settled.add(id);
      out.push(this.put(id, "flushed", call));
    }

    if (this.pendingUsage) {
      out.push(this.put(this.minted("usage"), "snapshot", this.pendingUsage));
      this.pendingUsage = null;
    }
    this.turnOpen = false;
    return out;
  }

  /**
   * Full state of the turn so far. A subscriber that joins mid-turn takes this, then
   * discards any frame whose `seq` is not greater than the snapshot's — otherwise a
   * thinking delta already folded into the snapshot would be applied twice.
   *
   * The threshold stays valid indefinitely: `seq` never restarts (see `startTurn`).
   *
   * Records are returned only while a turn is in flight — `flush()` ends it. The folded
   * state of a finished turn is still readable via `tool()`/`tools()`, which are
   * inspection accessors rather than the replay contract.
   */
  snapshot(): ActivitySnapshot {
    return {
      seq: this.seq,
      active: this.turnOpen,
      records: this.turnOpen ? [...this.records.values()] : [],
    };
  }

  /**
   * Begin a turn: clear per-turn state and set the prefix for MINTED record ids, while
   * `seq` keeps counting. Use this instead of constructing a new aggregator.
   *
   * Call `flush()` FIRST — those records belong to the turn that is ending. Anything left
   * open is returned here rather than dropped, but it would be persisted after that
   * turn's assistant message, breaking the `msg`-delimits-turn ordering readers rely on.
   * A correct caller always gets an empty array back.
   */
  startTurn(idPrefix?: string): AggregatedRecord[] {
    const leftover = this.flush();
    this.clearTurn();
    this.idPrefix = idPrefix ? `${idPrefix}:` : "";
    this.turnOpen = true;
    return leftover;
  }

  /** Folded state of one tool call. */
  tool(toolCallId: string): ToolActivity | undefined {
    return this.calls.get(toolCallId);
  }

  /** Every tool call seen this turn, in first-seen order. */
  tools(): ToolActivity[] {
    return [...this.calls.values()];
  }

  /**
   * Full reset, including the `seq` clock — for reusing the object on an unrelated
   * stream. Any threshold a subscriber is holding becomes invalid, so this is NOT the
   * between-turns call: use `startTurn()` for that.
   */
  reset(): void {
    this.clearTurn();
    this.seq = 0;
    this.turnOpen = false;
  }

  private clearTurn(): void {
    this.records.clear();
    this.calls.clear();
    this.settled.clear();
    this.inputSeen.clear();
    this.counters.clear();
    this.thinking = null;
    this.pendingUsage = null;
  }

  // --- folds ---------------------------------------------------------------------

  private foldThinking(
    event: Extract<ActivityEvent, { kind: "thinking" }>,
    emitted: AggregatedRecord[],
  ): ApplyResult {
    // The opening chunk sends the RECORD, not a delta. A delta is an increment on state
    // the consumer already has, and here it has none: `foldFrame` correctly drops a delta
    // whose base it never saw, so opening with one means the whole block streams to
    // nobody — it only appears once it closes and the settled record goes out.
    const opening = !this.thinking;
    if (!this.thinking) {
      // `messageId` identifies the block when the agent sends one — most don't, so fall
      // back to a per-turn counter. This is the instance-local id the one-aggregator
      // invariant exists to protect.
      // `messageId` is session-unique per ACP, so it needs no prefix; the counter does.
      const recordId = event.messageId
        ? `think-${event.messageId}`
        : this.minted(`think-${this.nextCount("think")}`);
      this.thinking = { recordId, messageId: event.messageId, text: "" };
    }
    this.thinking.text += event.text;

    const full: ActivityEvent = this.thinking.messageId
      ? { kind: "thinking", text: this.thinking.text, messageId: this.thinking.messageId }
      : { kind: "thinking", text: this.thinking.text };

    return {
      current: this.put(this.thinking.recordId, "announced", full),
      delta: opening
        ? null
        : {
            recordId: this.thinking.recordId,
            seq: this.seq,
            kind: "thinking",
            append: event.text,
          },
      emitted,
    };
  }

  private foldTool(
    event: Extract<ActivityEvent, { kind: "tool" }>,
    emitted: AggregatedRecord[],
  ): ApplyResult {
    // A RE-announcement is an update in disguise. Claude announces every call twice — once
    // with `rawInput: {}`, then again with the real arguments, both as `tool_call` rather
    // than `tool_call_update`. Taking the second as a fresh announce would replace the
    // stored call (losing whatever the re-announce omits) and spend a second `announced`
    // line where every other agent spends `input`.
    if (this.calls.has(event.toolCallId)) {
      return this.foldToolUpdate({ ...event, kind: "tool_update" }, emitted);
    }

    const call: ToolActivity = { ...event };
    this.calls.set(call.toolCallId, call);
    if (hasInput(call.rawInput)) this.inputSeen.add(call.toolCallId);

    const terminal = TERMINAL_STATUS.indexOf(call.status) >= 0;
    if (terminal) this.settled.add(call.toolCallId);

    const record = this.put(call.toolCallId, terminal ? "settled" : "announced", call);
    emitted.push(record);
    return { current: record, delta: null, emitted };
  }

  private foldToolUpdate(
    event: Extract<ActivityEvent, { kind: "tool_update" }>,
    emitted: AggregatedRecord[],
  ): ApplyResult {
    const id = event.toolCallId;
    const previous = this.calls.get(id);

    // Spreading is the whole merge: `updates.ts` omits absent keys, so only the fields
    // the agent actually changed are present. `content`/`locations` replace wholesale,
    // which a spread also gets right.
    const merged: ToolActivity = previous
      ? { ...previous, ...event, kind: "tool" }
      : {
          ...event,
          kind: "tool",
          toolKind: event.toolKind ?? "other",
          status: event.status ?? "in_progress",
        };
    this.calls.set(id, merged);

    const terminal = TERMINAL_STATUS.indexOf(merged.status) >= 0;
    let reason: EmitReason | null = null;

    if (terminal && !this.settled.has(id)) {
      this.settled.add(id);
      this.inputSeen.add(id); // the settled record is a superset — no input checkpoint too
      reason = "settled";
    } else if (!previous) {
      reason = "announced"; // an update for a call we never saw announced
    } else if (this.checkpointOnInput && !this.inputSeen.has(id) && hasInput(merged.rawInput)) {
      this.inputSeen.add(id);
      reason = "input";
    }

    const record = this.put(id, reason ?? this.reasonOf(id, "announced"), merged);
    if (reason) emitted.push(record);
    return { current: record, delta: null, emitted };
  }

  // --- thinking boundary -----------------------------------------------------------

  /**
   * THE ONE INVENTED RULE. ACP has no block-end event, so a block ends when the next
   * event isn't thinking, or when `messageId` changes ("a change in messageId indicates
   * a new message has started"). `messageId` is optional and commonly absent, so the
   * heuristic is the usual path. Everything else in this module is protocol-derived; if
   * this rule ever changes, the transcript format version changes with it.
   */
  private closeThinkingFor(event: ActivityEvent): AggregatedRecord | null {
    if (!this.thinking) return null;
    if (event.kind === "thinking") {
      const sameBlock = (event.messageId ?? null) === (this.thinking.messageId ?? null);
      if (sameBlock) return null;
    }
    return this.closeThinking();
  }

  private closeThinking(): AggregatedRecord | null {
    const block = this.thinking;
    if (!block) return null;
    this.thinking = null;
    const event: ActivityEvent = block.messageId
      ? { kind: "thinking", text: block.text, messageId: block.messageId }
      : { kind: "thinking", text: block.text };
    return this.put(block.recordId, "settled", event);
  }

  // --- identity --------------------------------------------------------------------

  /**
   * Ids the protocol guarantees session-unique (`planId`, `messageId`) pass through
   * verbatim; ids we mint are scoped by `idPrefix`.
   */
  private recordIdFor(event: ActivityEvent): string {
    switch (event.kind) {
      case "plan_update":
      case "plan_removed":
        return `plan-${event.planId}`;
      case "user_message":
        return event.messageId
          ? `msg-${event.messageId}`
          : this.minted(`msg-${this.nextCount("msg")}`);
      case "plan":
      case "mode":
      case "commands":
      case "config":
      case "session_info":
        return this.minted(event.kind);
      default:
        return this.minted(`${event.kind}-${this.nextCount(event.kind)}`);
    }
  }

  /** Namespace an id we invented. Protocol-given ids never go through here. */
  private minted(id: string): string {
    return `${this.idPrefix}${id}`;
  }

  private nextCount(key: string): number {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  private reasonOf(recordId: string, fallback: EmitReason): EmitReason {
    return this.records.get(recordId)?.reason ?? fallback;
  }

  private put(recordId: string, reason: EmitReason, event: ActivityEvent): AggregatedRecord {
    const record: AggregatedRecord = { recordId, seq: this.seq, reason, event };
    this.records.set(recordId, record);
    return record;
  }
}

// --- consumer-side folds -----------------------------------------------------------

/** True for the incremental wire shape. */
export function isActivityDelta(frame: ActivityFrame): frame is ActivityDelta {
  return "append" in frame;
}

/**
 * The PERSISTED fold — what a reader does with transcript lines. Genuinely one
 * operation: transcript lines are always full records, never deltas.
 *
 * This is NOT `apply()`. Feeding records back through `apply()` would, for one, merge two
 * separately-settled thinking blocks into a single block.
 */
export function foldRecords(
  records: Iterable<AggregatedRecord>,
  into?: Map<string, AggregatedRecord>,
): Map<string, AggregatedRecord> {
  const map = into ?? new Map<string, AggregatedRecord>();
  for (const record of records) map.set(record.recordId, record);
  return map;
}

/**
 * The LIVE fold — handles both wire shapes, so a consumer writes neither.
 *
 * A delta for a `recordId` with no base is dropped: it means the subscriber joined
 * mid-block without taking a snapshot first (see `ActivityAggregator.snapshot`).
 */
export function foldFrame(
  map: Map<string, AggregatedRecord>,
  frame: ActivityFrame,
): Map<string, AggregatedRecord> {
  if (!isActivityDelta(frame)) {
    map.set(frame.recordId, frame);
    return map;
  }
  const base = map.get(frame.recordId);
  if (!base || base.event.kind !== "thinking") return map;
  map.set(frame.recordId, {
    ...base,
    seq: frame.seq,
    event: { ...base.event, text: base.event.text + frame.append },
  });
  return map;
}

/**
 * What a live transport should send for one `apply()`, in order.
 *
 * `delta ?? current` alone is not enough: when a thinking block closes because a tool
 * call arrived, the close is in `emitted` while `current` is the tool — a subscriber
 * would never learn the block ended. Records already in `emitted` are not repeated.
 *
 * Never sends a record and a delta for the same `recordId` in one call: `foldFrame` has
 * no seq guard, so the consumer would apply the same text twice. The opening chunk of a
 * thinking block is a record (`delta` is null there); every chunk after it is a delta.
 */
export function wireFrames(result: ApplyResult): ActivityFrame[] {
  const frames: ActivityFrame[] = [...result.emitted];
  const live: ActivityFrame | null = result.delta ?? result.current;
  if (live && !frames.some((f) => f.recordId === live.recordId)) frames.push(live);
  return frames;
}
