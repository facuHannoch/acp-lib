import type { ContextLimits } from "../contracts/context.ts";
import type { ActiveTurn, ChannelInput, ChannelNotice, SendResult, SessionAgent, TurnExecutor, TurnPort } from "../contracts/agent.ts";
import type { EventSink, SessionEventSink } from "../contracts/events.ts";
import type { ChannelControls, ChannelStatus, ControlResult, LifecycleResult, SessionStatus } from "../contracts/session.ts";
import type { AcceptItem, SessionLifecycle, SessionStorage, StorageError, StorageResult, StorageSnapshot, StoredTurn } from "../contracts/storage.ts";

export interface ChannelScheduler {
  wakeCommittedChannel(channelId: string): void;
  agent: SessionAgent;
  channels: ChannelControls;
  start(): void;
  suspend(): Promise<LifecycleResult>;
  resume(): LifecycleResult;
  stop(reason: string): SessionStatus;
  status(): SessionStatus;
}

/** Status is a pure reading of one snapshot plus this process's own state. */
export function sessionStatus(view: Pick<StorageSnapshot, "revision" | "session" | "channels" | "turns" | "items">, stopped: boolean, incompatible = false): SessionStatus {
  const working = view.turns.some(turn => turn.state.status === "running");
  // Input pending on a channel that cannot run (suspended, suspending) is waiting
  // for a resume, not execution.
  const open = new Set(view.channels.filter(channel => channel.lifecycle === "open").map(channel => channel.channelId));
  const pending = view.items.some(item => item.milestone === "received" && open.has(item.channelId));
  const sessionRuns = view.session.lifecycle === "running";
  return {
    sessionId: view.session.sessionId, revision: view.revision, lifecycle: view.session.lifecycle,
    execution: stopped ? "stopped" : incompatible ? "incompatible" : view.session.lifecycle !== "running" ? view.session.lifecycle : working || pending ? "working" : "idle",
    channels: view.channels.map(({ channelId, displayName, policy, lifecycle }) => {
      const turns = view.turns.filter(turn => turn.channelId === channelId), last = turns.at(-1);
      const live = turns.find(turn => turn.state.status === "running" || turn.state.status === "suspended");
      const pendingItemIds = view.items.filter(item => item.channelId === channelId && item.milestone === "received").map(item => item.itemId);
      return {
        channelId, ...(displayName === undefined ? {} : { displayName }), ...(policy === undefined ? {} : { policy }), lifecycle,
        ...(live ? { activeTurn: { turnId: live.turnId, status: live.state.status as "running" | "suspended" } } : {}),
        pendingItemIds,
        waitingForResume: (pendingItemIds.length > 0 || live?.state.status === "suspended")
          && (lifecycle === "suspending" || lifecycle === "suspended" || !sessionRuns),
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
  storage: SessionStorage, execute: TurnExecutor, emit: EventSink = () => {}, emitSession: SessionEventSink = () => {}, limits?: ContextLimits,
): ChannelScheduler {
  const live = new Map<string, { turnId: number; abort: AbortController; suspension: AbortController }>();
  // Channels that may have pending input. Only an optimization and an idle
  // signal: beginTurn remains the authority on whether a turn starts.
  const waiting = new Set<string>();
  let started = false, stopped = false;
  let lifecycle: SessionLifecycle = "running";
  let suspension: { promise: Promise<LifecycleResult>; settle(result: LifecycleResult): void } | undefined;
  // Individual channel suspensions begun by this process and not yet committed
  // as `suspended`. Storage holds the truth; this holds the waiting callers.
  const channelSuspensions = new Map<string, { promise: Promise<ControlResult<ChannelStatus>>; settle(result: ControlResult<ChannelStatus>): void }>();
  const channelRecord = (channelId: string) => {
    const read = storage.readChannel(channelId);
    if (read.ok) return read.value.channel;
    if (read.error.code !== "not_found") throw new Error(read.error.message);
    return undefined;
  };
  const compatible = () => { const result = storage.executionCompatible(); if (!result.ok) throw new Error(result.error.message); return result.value; };
  const status = () => {
    const read = storage.readExecution();
    if (!read.ok) throw new Error(read.error.message);
    return sessionStatus(read.value, stopped, !compatible());
  };
  /** Channels whose pending input this process may start: open ones only. A
   * suspended channel's backlog waits for its own resume and is not "waiting"
   * here, so it never keeps the session from reporting idle. */
  function rescan() {
    const current = storage.readReadyChannels();
    if (!current.ok) throw new Error(current.error.message);
    lifecycle = current.value.lifecycle;
    waiting.clear();
    for (const channel of current.value.channels) waiting.add(channel);
  }
  rescan();
  const channelStatus = (channelId: string): ChannelStatus => status().channels.find(channel => channel.channelId === channelId)!;
  const emitState = (channelId: string, revision: number) => {
    const channel = channelStatus(channelId);
    // A channel that is not open has no input this process may start.
    if (channel.lifecycle !== "open") waiting.delete(channelId);
    emit({ channel: channelId, revision, event: { type: "channel_state", lifecycle: channel.lifecycle,
      ...(channel.displayName === undefined ? {} : { displayName: channel.displayName }), ...(channel.policy === undefined ? {} : { policy: channel.policy }) } });
  };
  /** A commit just ended or checkpointed this channel's turn: if its individual
   * suspension completed in that same transaction, announce it and answer the caller. */
  function settleChannel(channelId: string, revision: number) {
    const waiter = channelSuspensions.get(channelId);
    if (!waiter || channelStatus(channelId).lifecycle === "suspending") return;
    channelSuspensions.delete(channelId);
    emitState(channelId, revision);
    waiter.settle({ ok: true, value: channelStatus(channelId), revision });
  }
  const ended = (turn: StoredTurn, revision: number) => {
    if (turn.state.status !== "failed" && turn.state.status !== "interrupted") return;
    emit({ channel: turn.channelId, revision, event: { type: "turn_ended", turnId: String(turn.turnId), outcome: turn.state.status,
      error: turn.state.reason, ...(turn.state.uncertainCallIds.length ? { uncertainCalls: turn.state.uncertainCallIds } : {}) } });
  };

  /** Start the channel's next turn if storage has one to start. */
  function pump(channelId: string) {
    if (!started || stopped || lifecycle !== "running" || live.has(channelId)) return;
    const begun = storage.beginTurn(channelId, limits);
    // A suspended or retired channel is not ours to start; its backlog stays
    // pending until its own resume re-queues it.
    if (!begun.ok && (begun.error.code === "channel_suspended" || begun.error.code === "channel_retired")) { waiting.delete(channelId); return; }
    if (!begun.ok || !begun.value) { if (begun.ok) waiting.delete(channelId); return; }
    waiting.delete(channelId);
    emit({ channel: channelId, revision: begun.revision, event: { type: "turn_started", turnId: String(begun.value.turn.turnId),
      items: begun.value.items.map(item => item.itemId), messages: begun.value.entries.flatMap(entry =>
        entry.kind === "participant_message" && entry.itemId ? [{ itemId: entry.itemId, messageId: `item:${entry.itemId}`, position: String(entry.seq) }] : []) } });
    run({ channelId, turnId: begun.value.turn.turnId, resumed: false });
  }

  function run(turn: ActiveTurn) {
    const { channelId, turnId } = turn, abort = new AbortController(), suspensionSignal = new AbortController();
    live.set(channelId, { turnId, abort, suspension: suspensionSignal });
    // Called with the commit that ends or parks the turn, before its event, so
    // an observer reacting to that event already sees the channel as free.
    const release = () => { if (live.get(channelId)?.turnId === turnId) live.delete(channelId); };
    // A refusal here means the turn is no longer running (stopped): unwind the loop.
    const fenced = (message: string): never => { throw new Error(`Turn ${turnId} can no longer be advanced: ${message}`); };
    const port: TurnPort = {
      signal: abort.signal,
      suspensionSignal: suspensionSignal.signal,
      take() {
        const taken = storage.takePending(turnId, limits);
        if (!taken.ok) { if (taken.error.code !== "not_running" && taken.error.code !== "channel_suspended") fenced(taken.error.message); return; }
        waiting.delete(channelId);
        if (taken.value.items.length) emit({ channel: channelId, revision: taken.revision,
          event: { type: "turn_took", turnId: String(turnId), items: taken.value.items.map(item => item.itemId), messages: taken.value.entries.flatMap(entry =>
        entry.kind === "participant_message" && entry.itemId ? [{ itemId: entry.itemId, messageId: `item:${entry.itemId}`, position: String(entry.seq) }] : []) } });
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
        settleChannel(channelId, finished.revision);
        return true;
      },
      checkpoint() {
        // Either suspension stops the turn at this boundary; storage completes the
        // channel's own suspension in the same commit as the checkpoint.
        if (lifecycle !== "suspending" && !channelSuspensions.has(channelId)) return false;
        const saved = storage.checkpointTurn(turnId);
        if (!saved.ok) return fenced(saved.error.message);
        release();
        emit({ channel: channelId, revision: saved.revision, event: { type: "turn_suspended", turnId: String(turnId) } });
        settleChannel(channelId, saved.revision);
        return true;
      },
    };
    // Never run the executor inside the caller's stack: acceptance and resume
    // return before any model or tool work begins.
    void Promise.resolve().then(() => execute(turn, port)).then(() => {}, error => {
      // Record the failure unless stop already ended the turn; either way the
      // channel stays usable.
      const outcome = error && typeof error === "object" && "outcome" in error && typeof error.outcome === "string" ? error.outcome : String(error);
      const failed = storage.finishTurn(turnId, { status: "failed", reason: outcome });
      release();
      if (failed.ok && failed.value.finished) { ended(failed.value.turn, failed.revision); settleChannel(channelId, failed.revision); }
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
    if (stopped && item.kind !== "external_notice") return { accepted: false, code: "stopped", error: "This process has stopped accepting work" };
    if (stopped) {
      const known = storage.snapshot();
      if (!known.ok || !known.value.items.some(stored => stored.itemId === item.itemId))
        return { accepted: false, code: "stopped", error: "This process has stopped accepting work" };
    }
    const result = storage.acceptItem(item, limits?.maxInputBytes);
    if (!result.ok) {
      const code = result.error.code;
      return { accepted: false, error: result.error.message, code: code === "invalid_input" || code === "item_conflict"
        || code === "invalid_policy" || code === "incompatible" || code === "not_running" || code === "not_found" || code === "channel_suspended" || code === "channel_retired" ? code : "storage_failure" };
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

  const stoppedResult = { ok: false as const, error: { code: "stopped" as const, message: "Session is stopped" } };
  const failedWith = (error: StorageError) => ({ ok: false as const, error });
  /** Run one storage control; `after` publishes its effects once it committed. */
  function control<T, R>(act: () => StorageResult<T>, after: (value: T, revision: number) => R): ControlResult<R> {
    if (stopped) return stoppedResult;
    const result = act();
    if (!result.ok) return failedWith(result.error);
    return { ok: true, value: after(result.value, result.revision), revision: result.revision };
  }
  const lifecycleOf = (channelId: string) => channelRecord(channelId)?.lifecycle;

  const channels: ChannelControls = {
    create: input => {
      const result = control(() => storage.createChannel(input), ({ created }, revision) => {
        if (created) emitState(input.channelId, revision);
        return { channel: channelStatus(input.channelId), created };
      });
      return result;
    },
    edit: (channelId, displayName, policy) => {
      const before = channelRecord(channelId);
      return control(() => storage.editChannel(channelId, displayName, policy), (now, revision) => {
        if (now.displayName !== before?.displayName || now.policy !== before?.policy) emitState(channelId, revision);
        return channelStatus(channelId);
      });
    },
    suspend(channelId) {
      if (stopped) return Promise.resolve(stoppedResult);
      const waiter = channelSuspensions.get(channelId);
      if (waiter) return waiter.promise;
      const before = lifecycleOf(channelId);
      const begun = storage.beginChannelSuspend(channelId);
      if (!begun.ok) return Promise.resolve(failedWith(begun.error));
      if (begun.value.lifecycle === "suspended") {
        if (before !== "suspended") emitState(channelId, begun.revision);
        return Promise.resolve({ ok: true, value: channelStatus(channelId), revision: begun.revision });
      }
      let settle!: (result: ControlResult<ChannelStatus>) => void;
      const promise = new Promise<ControlResult<ChannelStatus>>(resolve => { settle = resolve; });
      channelSuspensions.set(channelId, { promise, settle });
      // Install the waiter before aborting: a synchronous cancellation observer
      // may call stop and must be able to settle this very suspension.
      if (before === "open") live.get(channelId)?.suspension.abort();
      if (channelSuspensions.has(channelId)) emitState(channelId, begun.revision);
      // The channel's turn reaches its boundary on its own and settles this at
      // the commit that checkpoints, completes or interrupts it.
      return promise;
    },
    resume: channelId => {
      const before = lifecycleOf(channelId);
      if (stopped) return stoppedResult;
      const resumed = storage.resumeChannel(channelId);
      if (!resumed.ok) return failedWith(resumed.error);
      // An explicit resume runs its checkpoint independently of session.start.
      if (before !== "open") emitState(channelId, resumed.revision);
      for (const reminder of resumed.value.unblockedReminders ?? [])
        emit({ channel: reminder.channel, revision: resumed.revision, event: { type: "reminder_changed", reminder } });
      if (resumed.value.turn) {
        emit({ channel: channelId, revision: resumed.revision, event: { type: "turn_resumed", turnId: String(resumed.value.turn.turnId) } });
        run({ channelId, turnId: resumed.value.turn.turnId, resumed: true });
      } else if (before !== "open") {
        rescan();
        pump(channelId);
      }
      return { ok: true, value: channelStatus(channelId), revision: resumed.revision };
    },
    delete: channelId => {
      const before = lifecycleOf(channelId);
      return control(() => storage.deleteChannel(channelId), (channel, revision) => {
        waiting.delete(channelId);
        if (before !== "retired") emitState(channelId, revision);
        for (const id of channel.cancelledReminderIds ?? [])
          emit({ channel: channelId, revision, event: { type: "reminder_cancelled", reminderId: id, by: "channel_retired" } });
        return channelStatus(channelId);
      });
    },
    withdraw: (channelId, itemId) => control(() => storage.withdrawItem(channelId, itemId), (outcome, revision) => {
      if (outcome.outcome === "withdrawn" && !outcome.repeated)
        emit({ channel: channelId, revision, event: { type: "item_withdrawn", item: itemId } });
      return outcome;
    }),
    interrupt: (channelId, turnId, reason = "interrupted by request") => control(
      () => {
        const handle = live.get(channelId);
        // Close approval and record its paired result before terminal storage
        // state. Reject invalid reasons without touching the live turn.
        if (handle?.turnId === turnId && typeof reason === "string" && reason.trim()) handle.abort.abort(new Error(reason));
        return storage.interruptTurn(channelId, turnId, reason);
      }, (outcome, revision) => {
        if (!outcome.interrupted) return outcome;
        // Commit first, then cancel: whatever the aborted work returns is already fenced.
        const handle = live.get(channelId);
        if (handle?.turnId === turnId) { live.delete(channelId); handle.abort.abort(new Error(reason)); }
        ended(outcome.turn, revision);
        settleChannel(channelId, revision);
        // Untaken input may start the next turn; the old turn's late result cannot reach it.
        queueMicrotask(() => pump(channelId));
        return outcome;
      }),
  };

  return {
    channels,
    wakeCommittedChannel(channelId: string) {
      if (stopped) return;
      waiting.add(channelId);
      if (started) queueMicrotask(() => pump(channelId));
    },
    agent: {
      idle: () => live.size === 0 && (!compatible() || !started || stopped || lifecycle !== "running" || waiting.size === 0),
      send: (input: ChannelInput) => accept({ kind: "participant_message", channelId: input?.channelId, senderId: input?.participantId,
        text: input?.text, ...(input?.policy == null ? {} : { explicitPolicy: input.policy }), ...(input?.itemId === undefined ? {} : { itemId: input.itemId }) }),
      notifyExternal: notice => accept({ kind: "external_notice", itemId: notice.itemId, channelId: notice.channelId,
        senderId: notice.source ?? "host", externalSource: notice.source, inheritedPolicyNames: notice.policyNames, text: notice.text }),
      notify: (notice: ChannelNotice) => accept({ kind: "channel_notice", channelId: notice?.channelId,
        senderId: `channel:${notice?.fromChannelId}`, sourceChannelId: notice?.fromChannelId, sourceTurnId: notice?.sourceTurnId, text: notice?.text }),
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
      const announce = lifecycle === "running";
      lifecycle = "suspending";
      let settle!: (result: LifecycleResult) => void;
      const promise = new Promise<LifecycleResult>(resolve => { settle = resolve; });
      suspension = { promise, settle };
      // Observers can synchronously stop the session while an approval closes.
      // Make the waiter visible before notifying any of them.
      for (const handle of live.values()) handle.suspension.abort();
      if (!suspension) return promise;
      if (announce) emitSession({ type: "lifecycle", lifecycle: "suspending", revision: begun.revision });
      if (!suspension) return promise;
      // Active turns reach their boundary on their own; with none, finish now.
      settleSuspension();
      return promise;
    },
    resume() {
      if (stopped) return { ok: false, error: { code: "stopped", message: "Session is stopped" } };
      const resumed = storage.resume();
      if (!resumed.ok) return { ok: false, error: resumed.error };
      if (lifecycle !== "running") emitSession({ type: "lifecycle", lifecycle: "running", revision: resumed.revision });
      started = true;
      for (const reminder of resumed.value.unblockedReminders ?? [])
        emit({ channel: reminder.channel, revision: resumed.revision, event: { type: "reminder_changed", reminder } });
      // Storage returned only turns of channels that are not individually
      // suspended; those channels keep their checkpoint and backlog.
      rescan();
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
      const suspending = [...channelSuspensions.keys()];
      // Cancellation synchronously closes pending approvals and records their
      // skip before the storage transaction ends each turn.
      for (const { abort } of live.values()) abort.abort(Object.assign(new Error(reason), { approvalCloseCode: "approval_cancelled_by_stop" }));
      const interrupted = storage.interruptActive(reason);
      live.clear();
      if (interrupted.ok) {
        for (const turn of interrupted.value) ended(turn, interrupted.revision);
        if (lifecycle === "suspending") { lifecycle = "running"; emitSession({ type: "lifecycle", lifecycle, revision: interrupted.revision }); }
      }
      suspension?.settle({ ok: false, error: { code: "stopped", message: "Session was stopped before suspension completed" } });
      suspension = undefined;
      // A channel suspension that had not committed returned to `open`; committed ones are untouched.
      for (const channelId of suspending) {
        const waiter = channelSuspensions.get(channelId);
        channelSuspensions.delete(channelId);
        if (interrupted.ok) emitState(channelId, interrupted.revision);
        waiter?.settle({ ok: false, error: { code: "stopped", message: "Session was stopped before the channel suspension completed" } });
      }
      return status();
    },
    status,
  };
}
