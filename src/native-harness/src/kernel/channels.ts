import type { ActiveTurn, ChannelInput, ChannelNotice, SendResult, SessionAgent, TurnExecutor, TurnPort } from "../contracts/agent.ts";
import type { EventSink, SessionEventSink } from "../contracts/events.ts";
import type { LifecycleResult, SessionStatus } from "../contracts/session.ts";
import type { AcceptItem, SessionLifecycle, SessionStorage, StorageSnapshot, StoredTurn } from "../contracts/storage.ts";

export interface ChannelScheduler {
  agent: SessionAgent;
  start(): void;
  suspend(): Promise<LifecycleResult>;
  resume(): LifecycleResult;
  stop(reason: string): SessionStatus;
  status(): SessionStatus;
}

/** Status is a pure reading of one snapshot plus this process's own state. */
export function sessionStatus(view: StorageSnapshot, stopped: boolean): SessionStatus {
  const working = view.turns.some(turn => turn.state.status === "running");
  const pending = view.items.some(item => item.milestone === "received");
  return {
    sessionId: view.session.sessionId, revision: view.revision, lifecycle: view.session.lifecycle,
    execution: stopped ? "stopped" : view.session.lifecycle !== "running" ? view.session.lifecycle : working || pending ? "working" : "idle",
    channels: view.channels.map(({ channelId }) => {
      const turns = view.turns.filter(turn => turn.channelId === channelId), last = turns.at(-1);
      const live = turns.find(turn => turn.state.status === "running" || turn.state.status === "suspended");
      return {
        channelId,
        ...(live ? { activeTurn: { turnId: live.turnId, status: live.state.status as "running" | "suspended" } } : {}),
        pendingItemIds: view.items.filter(item => item.channelId === channelId && item.milestone === "received").map(item => item.itemId),
        ...(last && (last.state.status === "failed" || last.state.status === "interrupted")
          ? { unresolvedInterruption: { turnId: last.turnId, ...last.state } } : {}),
      };
    }),
  };
}

/** One live turn per channel, any number of channels at once. Storage decides
 * every admission, take and finish; this module only reacts to those commits,
 * publishes each one after it happens, and keeps the per-process handles
 * (promises and abort controllers) that storage cannot hold. */
export function createChannelScheduler(
  storage: SessionStorage, execute: TurnExecutor, emit: EventSink = () => {}, emitSession: SessionEventSink = () => {},
): ChannelScheduler {
  const live = new Map<string, { turnId: number; abort: AbortController }>();
  // Channels that may have pending input. Only an optimization and an idle
  // signal: beginTurn remains the authority on whether a turn starts.
  const waiting = new Set<string>();
  let started = false, stopped = false;
  let lifecycle: SessionLifecycle = "running";
  let suspension: { promise: Promise<LifecycleResult>; settle(result: LifecycleResult): void } | undefined;
  const view = () => { const read = storage.snapshot(); if (!read.ok) throw new Error(read.error.message); return read.value; };
  const status = () => sessionStatus(view(), stopped);
  {
    const initial = view();
    lifecycle = initial.session.lifecycle;
    for (const item of initial.items) if (item.milestone === "received") waiting.add(item.channelId);
  }
  const ended = (turn: StoredTurn, revision: number) => {
    if (turn.state.status !== "failed" && turn.state.status !== "interrupted") return;
    emit({ channel: turn.channelId, revision, event: { type: "turn_ended", turnId: String(turn.turnId), outcome: turn.state.status,
      error: turn.state.reason, ...(turn.state.uncertainCallIds.length ? { uncertainCalls: turn.state.uncertainCallIds } : {}) } });
  };

  /** Start the channel's next turn if storage has one to start. */
  function pump(channelId: string) {
    if (!started || stopped || lifecycle !== "running" || live.has(channelId)) return;
    const begun = storage.beginTurn(channelId);
    if (!begun.ok || !begun.value) { if (begun.ok) waiting.delete(channelId); return; }
    waiting.delete(channelId);
    emit({ channel: channelId, revision: begun.revision, event: { type: "turn_started", turnId: String(begun.value.turn.turnId),
      items: begun.value.items.map(item => item.itemId) } });
    run({ channelId, turnId: begun.value.turn.turnId, resumed: false });
  }

  function run(turn: ActiveTurn) {
    const { channelId, turnId } = turn, abort = new AbortController();
    live.set(channelId, { turnId, abort });
    // Called with the commit that ends or parks the turn, before its event, so
    // an observer reacting to that event already sees the channel as free.
    const release = () => { if (live.get(channelId)?.turnId === turnId) live.delete(channelId); };
    // A refusal here means the turn is no longer running (stopped): unwind the loop.
    const fenced = (message: string): never => { throw new Error(`Turn ${turnId} can no longer be advanced: ${message}`); };
    const port: TurnPort = {
      signal: abort.signal,
      take() {
        const taken = storage.takePending(turnId);
        if (!taken.ok) { if (taken.error.code !== "not_running") fenced(taken.error.message); return; }
        waiting.delete(channelId);
        if (taken.value.items.length) emit({ channel: channelId, revision: taken.revision,
          event: { type: "turn_took", turnId: String(turnId), items: taken.value.items.map(item => item.itemId) } });
      },
      confirm(milestone) {
        const advanced = storage.confirmReceipts(turnId, milestone);
        if (advanced.ok && advanced.value.length) emit({ channel: channelId, revision: advanced.revision,
          event: { type: "items_receipt", turnId: String(turnId), items: advanced.value.map(item => item.itemId), milestone } });
      },
      finish() {
        // The pending check and the completion are one storage transaction, so
        // a concurrent send either keeps this turn open or starts the next one.
        const finished = storage.finishTurn(turnId, { status: "completed" });
        if (!finished.ok) return fenced(finished.error.message);
        if (!finished.value.finished) return false;
        release();
        emit({ channel: channelId, revision: finished.revision, event: { type: "turn_ended", turnId: String(turnId), outcome: "completed" } });
        return true;
      },
      checkpoint() {
        if (lifecycle !== "suspending") return false;
        const saved = storage.checkpointTurn(turnId);
        if (!saved.ok) return fenced(saved.error.message);
        release();
        emit({ channel: channelId, revision: saved.revision, event: { type: "turn_suspended", turnId: String(turnId) } });
        return true;
      },
    };
    // Never run the executor inside the caller's stack: acceptance and resume
    // return before any model or tool work begins.
    void Promise.resolve().then(() => execute(turn, port)).then(() => {}, error => {
      // Record the failure unless stop already ended the turn; either way the
      // channel stays usable.
      const failed = storage.finishTurn(turnId, { status: "failed", reason: String(error) });
      release();
      if (failed.ok && failed.value.finished) ended(failed.value.turn, failed.revision);
    }).then(() => {
      release();
      settleSuspension();
      pump(channelId);
    });
  }

  function settleSuspension() {
    if (!suspension || lifecycle !== "suspending" || live.size) return;
    const done = storage.completeSuspend();
    if (done.ok) { lifecycle = "suspended"; emitSession({ type: "lifecycle", lifecycle, revision: done.revision }); }
    suspension.settle(done.ok ? { ok: true, status: status() } : { ok: false, error: done.error });
    suspension = undefined;
  }

  function accept(item: AcceptItem): SendResult {
    if (stopped) return { accepted: false, code: "stopped", error: "This process has stopped accepting work" };
    const result = storage.acceptItem(item);
    if (!result.ok) {
      const code = result.error.code;
      return { accepted: false, error: result.error.message, code: code === "invalid_input" || code === "item_conflict"
        || code === "not_running" || code === "not_found" ? code : "storage_failure" };
    }
    const { item: stored, duplicate } = result.value;
    if (!duplicate) {
      waiting.add(stored.channelId);
      // Acknowledge first; the channel takes the item on a later microtask.
      queueMicrotask(() => pump(stored.channelId));
    }
    return { accepted: true, itemId: stored.itemId, duplicate, milestone: stored.milestone,
      ...(stored.turnId === undefined ? {} : { turnId: stored.turnId }) };
  }

  return {
    agent: {
      idle: () => live.size === 0 && (!started || stopped || lifecycle !== "running" || waiting.size === 0),
      send: (input: ChannelInput) => accept({ kind: "participant_message", channelId: input?.channelId, senderId: input?.participantId,
        text: input?.text, ...(input?.itemId === undefined ? {} : { itemId: input.itemId }) }),
      notify: (notice: ChannelNotice) => accept({ kind: "channel_notice", channelId: notice?.channelId,
        senderId: `channel:${notice?.fromChannelId}`, sourceChannelId: notice?.fromChannelId, text: notice?.text }),
    },
    start() {
      if (started || stopped) return;
      started = true;
      for (const channelId of [...waiting]) pump(channelId);
    },
    suspend() {
      if (stopped) return Promise.resolve({ ok: false, error: { code: "stopped", message: "Session is stopped" } });
      if (suspension) return suspension.promise;
      const begun = storage.beginSuspend();
      if (!begun.ok) return Promise.resolve({ ok: false, error: begun.error });
      if (begun.value.lifecycle === "suspended") { lifecycle = "suspended"; return Promise.resolve({ ok: true, status: status() }); }
      if (lifecycle === "running") emitSession({ type: "lifecycle", lifecycle: "suspending", revision: begun.revision });
      lifecycle = "suspending";
      let settle!: (result: LifecycleResult) => void;
      const promise = new Promise<LifecycleResult>(resolve => { settle = resolve; });
      suspension = { promise, settle };
      // Active turns reach their boundary on their own; with none, finish now.
      settleSuspension();
      return promise;
    },
    resume() {
      if (stopped) return { ok: false, error: { code: "stopped", message: "Session is stopped" } };
      const resumed = storage.resume();
      if (!resumed.ok) return { ok: false, error: resumed.error };
      if (lifecycle !== "running") emitSession({ type: "lifecycle", lifecycle: "running", revision: resumed.revision });
      lifecycle = "running"; started = true;
      for (const turn of resumed.value.turns) {
        emit({ channel: turn.channelId, revision: resumed.revision, event: { type: "turn_resumed", turnId: String(turn.turnId) } });
        run({ channelId: turn.channelId, turnId: turn.turnId, resumed: true });
      }
      for (const channelId of [...waiting]) pump(channelId);
      return { ok: true, status: status() };
    },
    stop(reason) {
      if (stopped) return status();
      stopped = true;
      // Commit the interruption first so nothing a cancelled call returns can be recorded.
      const interrupted = storage.interruptActive(reason);
      for (const { abort } of live.values()) abort.abort(new Error(reason));
      live.clear();
      if (interrupted.ok) {
        for (const turn of interrupted.value) ended(turn, interrupted.revision);
        if (lifecycle === "suspending") { lifecycle = "running"; emitSession({ type: "lifecycle", lifecycle, revision: interrupted.revision }); }
      }
      suspension?.settle({ ok: false, error: { code: "stopped", message: "Session was stopped before suspension completed" } });
      suspension = undefined;
      return status();
    },
    status,
  };
}
