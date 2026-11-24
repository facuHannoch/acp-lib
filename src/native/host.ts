import type { NativeConnection, NativeHarnessHostConfig } from "./host-config.ts";
export type { NativeConnection, NativeHarnessHostConfig, NativeApprovalRequest, NativeApprovalResponder } from "./host-config.ts";
import { idleMilliseconds, ReminderIdleSupervisor, type IdleStopResult } from "./reminders/idle.ts";
import { reminderNotification, reminderRpc, type WireChange, type ReminderNotification, type WireReminderEvent } from "./reminders/wire.ts";
import type { ReminderWakeSupervisor } from "./reminders/supervisor.ts";
import type { ReminderSync } from "./reminders/sync.ts";
import { deferred, launchNativeConnection, type Deferred } from "./connection.ts";
import { NativeUsageLedger } from "../metering/native/ledger.ts";
import { summarizeModelUsage } from "./usage.ts";
import { NativeWorkerDelivery } from "./worker-delivery.ts";
import type { WorkerDeliveryRepository } from "../persistence/worker-delivery-contract.ts";
import { NativeApprovals } from "./approvals.ts";
import { SubmissionWithdrawal } from "./submission-withdrawal.ts";
import { takenSender } from "./delegation-sender.ts";
/**
 * The shared native harness host: one per Agent (acp-client integration spec, Ownership).
 *
 * It owns what belongs to the process and the session rather than to one conversation:
 * - launching the harness (`serve --stdio`) through the host launcher, lazily and once: concurrent
 *   first uses share one start;
 * - the open sequence: handlers attached, `initialize`, then `session/open` (or `session/create` on a
 *   confirmed `not_found`) carrying the channel changes made while the harness was stopped;
 * - reconciliation after every open, and reopening after a lost process or connection;
 * - the durable-acceptance rule for inputs: an id and exact payload are saved before `channel/push`,
 *   and an unresolved submission is retried with the same id and payload;
 * - process shutdown. A conversation never stops the process.
 *
 * It uses only the harness's public client entry point. Conversations attach as `ChannelPort`s keyed
 * by channel id (the conversation id) and receive that channel's events and reconciled view.
 */
import {
  type HarnessClient,
  type ChannelEvent,
  type ChannelStatusResult,
  type ItemStatus,
  type LoadResult,
  type StatusResult,
  type StoredMessage,
  type TurnStatus,
  type ToolAvailability,
  type ToolInvocation,
} from "../native-harness/src/client.ts";
import { commitChannelCatchUp, openOrCreate, readCompleteMessage, recoverChannel, recoverStoppedReplies } from "./recovery.ts";
import { createNativeFunctionHost, type NativeFunctionHost } from "./functions.ts";
import { noopLogger, type Logger } from "../logger.ts";
import type { ChannelDesire, ChannelPersistence, PendingChange } from "../persistence/channels.ts";
import { createMemoryHostRecords, fileHasPendingChannelChanges, submissionRecords, type NativeHostRecords, type Submission } from "./records.ts";
import { channelStore, NativeChannelChanges, type ChannelChangeOutcome } from "./channel-changes.ts";
import { ambiguous, codeOf, HarnessIncompatibleError, HarnessUnavailableError } from "./errors.ts";

export { HarnessIncompatibleError, HarnessUnavailableError } from "./errors.ts";
export type { ChannelChangeOutcome } from "./channel-changes.ts";

export type NativeHostState = "stopped" | "starting" | "running" | "failed";

/** One channel's part of a load view, as reconciled after an open. */
export interface ChannelView {
  /** The storage revision of the view. Events at or below it are already reflected. */
  readonly revision: number;
  readonly status: ChannelStatusResult | undefined;
  readonly turns: readonly TurnStatus[];
  readonly items: readonly ItemStatus[];
  /** Committed assistant messages of this channel, in timeline order. Oversized text is a reference: read it with `readMessage`. */
  readonly messages: readonly StoredMessage[];
}

/** What a conversation's controller implements to receive its channel. */
export interface ChannelPort {
  event(event: ChannelEvent): void;
  reminderEvent?(event: WireReminderEvent): void;
  readonly idleStopWindowMs?: number;
  /** After every open, before any live event of that connection is delivered. */
  reconcile(view: ChannelView): void;
  /** The connection was lost. Work stays pending: the next open reconciles it. */
  disconnected(): void;
  /** The host gave up (restarts ran out) or was stopped: nothing pending will be reconciled. */
  failed(error: Error): void;
  /** Whether this channel has a turn the host should reopen for after a lost connection. */
  busy(): boolean;
  trackedTurns?(): string[];
}

const REQUIRED_METHODS = ["session/open", "channel/observe", "channel/reconcile", "channel/push", "channel/create", "channel/edit", "channel/suspend", "channel/resume", "channel/delete", "channel/withdraw", "channel/interrupt", "approval/respond", "session/message/read"];

export class NativeHarnessHost {
  readonly sessionId: string;
  readonly records: NativeHostRecords;
  readonly #config: NativeHarnessHostConfig;
  readonly #log: Logger;
  reminderSync?: ReminderSync;
  reminderWake?: ReminderWakeSupervisor;
  #stoppingExplicitly = false;
  // Keep receiving deadlines from the detached connection until explicit stop drains them.
  #stoppingConnection: NativeConnection | null = null;
  #wakeFailure: HarnessUnavailableError | null = null;
  get reminderWakeState(): NativeHostState { return this.#wakeFailure ? "failed" : this.#stoppingExplicitly ? "running" : this.#state; }
  get reminderTimer() { return this.#config.reminderTimer; }
  startForReminder(now: number): Promise<void> {
    if (this.#starting || this.#state === "running") return this.ensureStarted();
    if (!this.#claimRestart(now)) {
      if (this.#localBusy()) return Promise.reject(this.#failReopen());
      this.#wakeFailure = new HarnessUnavailableError("the reminder wake exhausted its restart budget", { code: "reopen_failed" });
      return Promise.reject(this.#wakeFailure);
    }
    return this.ensureStarted();
  }
  async changeReminder(change: WireChange) {
    await this.ensureStarted();
    return this.reminderSync?.dispatch(this.#client(), change);
  }
  async refreshReminders(channel?: string, id?: string) {
    await this.#idling;
    if (this.#state === "running") return this.reminderSync?.refresh(this.#client(), channel, id);
  }
  reminderIdle?: ReminderIdleSupervisor;
  closeReminderSupervisors(): void { this.reminderIdle?.close(); this.reminderWake?.close(); }
  #idling?: Promise<IdleStopResult>;

  #localBusy(): boolean {
    return this.#waiters.size > 0 || this.records.submissions().length > 0 || this.#approvals.busy
      || this.#changes.busy || [...this.#ports.values()].some(port => port.busy());
  }

  #idleStop(window: number, stillIdle: () => boolean): Promise<IdleStopResult> {
    if (this.#idling) return this.#idling;
    const connection = this.#connection;
    if (this.#stoppingExplicitly || !connection || !stillIdle() || this.#localBusy()) return Promise.resolve({ stopped: false, reason: "busy" });
    const attempt = reminderRpc<IdleStopResult>(connection.client, "session/stop", { ifIdle: true, unlessDueWithinMs: window });
    this.#idling = attempt.then(async result => {
      await this.reminderSync?.settled();
      if (result.stopped && this.#connection === connection) {
        this.#connection = null;
        this.#approvals.stop();
        for (const port of this.#ports.values()) port.disconnected();
        try { await connection.kill(); } finally { this.#setState("stopped"); }
      }
      return result;
    }).finally(() => { this.#idling = undefined; });
    return this.#idling;
  }

  armIdleStop(pending: () => Promise<{ held: boolean; channels: string[] }>): void {
    const interval = idleMilliseconds(this.#config.idleStopMs, "idleStopMs");
    const fallback = idleMilliseconds(this.#config.idleStopWindowMs, "idleStopWindowMs") ?? 0;
    if (!interval) return;
    this.reminderIdle = new ReminderIdleSupervisor({
      state: () => this.#state,
      window: async () => {
        if (!this.reminderSync?.supported || this.#localBusy() || (await this.#changes.pendingChanges()).length) return;
        const { held, channels } = await pending();
        if (!held) return channels.reduce((max, channel) => Math.max(max, this.#ports.get(channel)?.idleStopWindowMs ?? fallback), 0);
      },
      stop: (window, stillIdle) => this.#idleStop(window, stillIdle),
      error: error => this.#log.warn("native_idle_stop_failed", { error: String(error) }),
    }, interval, this.#config.reminderTimer);
    this.subscribeState(() => this.reminderIdle?.activity());
  }
  #state: NativeHostState = "stopped";
  #connection: NativeConnection | null = null;
  #starting: Promise<void> | null = null;
  /** Set by `stop()`: an explicit stop is never followed by an automatic reopen. */
  #stopped = false;
  #failure: Error | null = null;
  readonly #ports = new Map<string, ChannelPort>();
  /** Events for a channel no conversation is attached to yet; delivered on attach. */
  readonly #backlog = new Map<string, ChannelEvent[]>();
  /** While an open is in progress: events received before the view was applied. */
  #early: ChannelEvent[] | null = null;
  /** The harness's channels as last seen (load view, control responses, `channel_state`). */
  readonly #channels = new Map<string, ChannelStatusResult>();
  readonly #changes: NativeChannelChanges;
  readonly #approvals: NativeApprovals;
  readonly #workerDelivery?: NativeWorkerDelivery;
  /** Callers waiting for a submission's acceptance, across reopens. */
  readonly #waiters = new Map<string, Deferred<ItemStatus>>();
  readonly #withdrawals: SubmissionWithdrawal;
  readonly #stateListeners = new Set<() => void>();
  readonly #restarts: number[] = [];
  /** How many processes this host has started (observability and tests). */
  launches = 0;
  /** @internal Pins reads of one turn to the same connection across pages. */
  readonly usageLedger = new NativeUsageLedger(() => {
    const client = this.#client();
    return (query, signal) => client.modelCalls(query, signal);
  });

  constructor(config: NativeHarnessHostConfig, channels?: ChannelPersistence, workerDelivery?: WorkerDeliveryRepository) {
    this.#config = config;
    this.sessionId = config.sessionId;
    this.#log = config.logger ?? noopLogger;
    this.#approvals = new NativeApprovals(config.approvalResponder, this.#log);
    const records = config.records ?? createMemoryHostRecords();
    this.records = channels ? submissionRecords(records) : records;
    this.#withdrawals = new SubmissionWithdrawal(this.records, config.requestTimeoutMs ?? 30_000,
      (channel, item) => this.withdraw(channel, item),
      async (channel, item) => (await this.#client().reconcileChannel({ channel, itemIds: [item] })).items[0],
      (channel, item) => this.#deliver({ channel, event: { type: "item_withdrawn", item } }));
    this.#changes = new NativeChannelChanges(channels ?? channelStore(records), this.#channels, () => this.#client(),
      this.#log, config.onChannelChangeBlocked);
    if (workerDelivery) this.#workerDelivery = new NativeWorkerDelivery(
      workerDelivery, () => this.#state === "running",
      ({ id, destination, source, text, policyNames }) => this.#changes.enqueue(destination.id, async () => {
        if (this.#state !== "running" || await this.#changes.pendingChange(destination.id)) return false;
        const client = this.#client();
        const params = { channel: destination.id, notice: { id, source, text, policyNames: [...policyNames] } };
        try {
          await client.notify(params);
        } catch (error) {
          if (codeOf(error) !== "timeout" || client !== this.#connection?.client) throw error;
          await client.notify(params);
        }
        return true;
      }),
    );
    if (channels && fileHasPendingChannelChanges(records)) {
      this.#log.warn("native_file_channel_changes_ignored", { sessionId: this.sessionId });
    }
  }

  get state(): NativeHostState { return this.#state; }
  /** Why the host is `failed`. */
  get failure(): Error | null { return this.#failure ?? this.#wakeFailure; }
  get explicitlyStopped(): boolean { return this.#stopped; }
  subscribeState(listener: () => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }
  #setState(state: NativeHostState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#notifyState();
  }
  #notifyState(): void {
    for (const listener of [...this.#stateListeners]) { try { listener(); } catch { /* an observer never breaks the host */ } }
  }

  approvalFor(event: Extract<ChannelEvent["event"], { type: "approval_requested" }>) {
    return this.#approvals.ticket(event);
  }

  #observeApproval(connection: NativeConnection, { channel, event }: ChannelEvent): void {
    if (event.type === "approval_requested") {
      this.#approvals.observe(channel, event, async decision =>
        this.#connection === connection && this.#answerApproval(event.requestId, decision));
    } else if (event.type === "approval_closed") {
      this.#approvals.closed(event);
    }
  }

  /** The channel as the harness last reported it; undefined before the first open or for a channel it has not seen. */
  channel(channel: string): ChannelStatusResult | undefined { return this.#channels.get(channel); }

  // --- conversations ----------------------------------------------------------------------------

  /** Attaches a conversation to its channel. Starts nothing. Events held for the channel are delivered now. */
  attach(channel: string, port: ChannelPort, observe = false): () => void {
    this.#ports.set(channel, port);
    const held = this.#backlog.get(channel);
    if (held && (!observe || !this.#connection)) {
      this.#backlog.delete(channel);
      for (const event of held) port.event(event);
    }
    return () => { if (this.#ports.get(channel) === port) this.#ports.delete(channel); };
  }

  readonly #attaching = new Map<string, ChannelEvent[]>();

  async observeAttachment(channel: string, port: ChannelPort): Promise<void> {
    const connection = this.#connection;
    if (!connection || this.#ports.get(channel) !== port) return;
    const buffered = this.#backlog.get(channel) ?? [];
    this.#backlog.delete(channel);
    this.#attaching.set(channel, buffered);
    let boundary = 0;
    try {
      const saved = this.records.submissions(channel).map(item => item.id);
      const recovered = await recoverChannel(connection.client, channel, saved, port.trackedTurns?.() ?? [], { atObservation: () => { boundary = buffered.length; } });
      if (this.#connection !== connection || this.#ports.get(channel) !== port) return;
      const { observation } = recovered;
      const { pendingCount: _pendingCount, ...state } = observation.channel;
      const status = { pending: this.#channels.get(channel)?.pending ?? [], ...state };
      this.#channels.set(channel, status);
      port.reconcile({ ...recovered, status, revision: observation.revision });
      for (const request of observation.approvals) {
        if (buffered.slice(boundary).some(({ event }) => event.type === "approval_closed" && event.requestId === request.requestId)) continue;
        const event = { channel, event: { type: "approval_requested" as const, ...request } };
        this.#observeApproval(connection, event);
        this.#approvals.start(event.event);
        port.event(event);
      }
      for (const [index, event] of buffered.entries()) {
        if (event.revision === undefined ? index >= boundary : event.revision > observation.revision) port.event(event);
      }
    } catch (error) {
      if (this.#connection === connection) {
        if (codeOf(error) !== "not_found") throw error;
        for (const event of buffered) port.event(event);
      }
    } finally {
      if (this.#attaching.get(channel) === buffered) this.#attaching.delete(channel);
    }
  }

  /** Starts the harness if it is not running. Concurrent callers share one start. */
  ensureStarted(): Promise<void> {
    if (this.#idling) return this.#idling.catch(() => {}).then(() => this.ensureStarted());
    if (this.#wakeFailure) { this.#wakeFailure = null; this.#restarts.length = 0; }
    this.reminderIdle?.activity();
    if (this.#state === "running") return Promise.resolve();
    if (this.#state === "failed") return Promise.reject(new HarnessUnavailableError("the native harness is unavailable; call restart()", { cause: this.#failure, code: "failed" }));
    this.#stopped = false;
    this.#starting ??= this.#start().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  /** Clears a failed state and starts again. */
  restart(): Promise<void> {
    if (this.#state === "failed") { this.#failure = null; this.#restarts.length = 0; this.#setState("stopped"); }
    return this.ensureStarted();
  }

  /** Stops the process. Pending work is not reconciled until the next start; waiting pushes fail. */
  async stop(): Promise<void> {
    this.#stopped = this.#stoppingExplicitly = true;
    this.reminderWake?.refresh();
    await this.#idling?.catch(() => {});
    const connection = this.#stoppingConnection = this.#connection;
    this.#connection = null;
    await this.#starting?.catch(() => undefined);
    this.#setState("stopped");
    const error = new HarnessUnavailableError("the native harness was stopped", { code: "stopped" });
    this.#rejectWaiters(error);
    for (const port of [...this.#ports.values()]) port.failed(error);
    this.#approvals.stop();
    const live = this.#stoppingConnection = connection ?? this.#connection;
    this.#connection = null;
    try {
      if (live) {
        try { await live.client.stop(); }
        finally { await this.reminderSync?.settled(); await live.kill(); }
      }
    } finally {
      this.#functions?.dispose();
      this.#functions = null;
      this.#stoppingConnection = null;
      this.#stoppingExplicitly = false;
      this.reminderWake?.refresh();
    }
  }

  async #start(): Promise<void> {
    this.#setState("starting");
    let connection: NativeConnection | undefined;
    const limit = this.#config.startupTimeoutMs ?? 30_000;
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const opening = (async () => {
        connection = await (this.#config.connect ?? (() => launchNativeConnection(this.#config, this.#log)))();
        this.launches += 1;
        if (deadline.signal.aborted) {
          await connection.kill();
          return;
        }
        const live = connection;
        await this.#open(live, deadline.signal);
        await this.#changes.afterOpen(deadline.signal, () => {
          this.#connection = live;
          this.#replaySubmissions();
          this.#setState("running");
          void this.flushWorkerDelivery();
          void this.reminderSync?.dispatch(live.client).catch(error => this.#log.warn("reminder_dispatch_failed", { error: String(error) }));
          void live.closed.then(async () => {
            // A loss at the open boundary must reopen after the old start has retired.
            await this.#starting?.catch(() => undefined);
            await this.#idling?.catch(() => undefined);
            this.#lost(live);
          });
        });
      })();
      opening.catch(() => undefined);
      await Promise.race([opening, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new HarnessUnavailableError(`the native harness did not open within ${limit} ms`, { code: "open_timeout" });
          deadline.abort(error);
          reject(error);
        }, limit);
      })]);
    } catch (error) {
      this.#early = null;
      this.#connection = null;
      await connection?.kill().catch(() => undefined);
      // A failed start is reported to whoever needed the harness. It is not retried automatically:
      // the next use tries again. Only a loss with work outstanding is reopened by the host itself.
      this.#setState("stopped");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Handlers first, then initialize, then load (or create) with the pending channel changes; then reconcile. */
  async #open(connection: NativeConnection, signal: AbortSignal): Promise<void> {
    const { client } = connection;
    let reminderOpen = false;
    const earlyReminders: ReminderNotification[] = [];
    const reminderEvent = (event: ReminderNotification) =>
      this.reminderSync?.notification(event, (channel, payload) => this.#ports.get(channel)?.reminderEvent?.(payload));
    const notifyReminder = (event: ReminderNotification) => {
      if (!reminderOpen) earlyReminders.push(event);
      else if (this.#connection === connection || ("deadline" in event && this.#stoppingConnection === connection)) reminderEvent(event);
    };
    connection.onReminderNotification?.(notifyReminder);
    client.onReminderWake?.(event => notifyReminder({ deadline: event }));
    this.#early = [];
    client.onChannelEvent(event => {
      const reminder = reminderNotification({ jsonrpc: "2.0", method: "channel/event", params: event });
      if (reminder) notifyReminder(reminder); else this.#route(connection, event);
    });
    client.onSessionEvent(event => {
      const status = this.#lastStatus;
      if (this.#connection !== connection || !status || status.revision > event.revision) return;
      this.#lastStatus = { ...status, lifecycle: event.lifecycle, revision: event.revision };
      this.#notifyState();
    });
    // Handlers are in place before `initialize` names them: a recovered call can arrive right after the open.
    const functions = this.#functionHost();
    if (functions) client.serveFunctions((call, signal) => functions.call(call, signal,
      () => takenSender(client, call.channel, call.turnId, signal)), (read) => functions.read(read));
    const initialized = await client.initialize({
      protocolVersion: 1,
      host: { name: "acp-client", version: "1" },
      callbacks: functions ? ["functions/call"] : [],
      ...(functions ? { functions: functions.handlers() } : {}),
      approval: true,
      subscription: { text: this.#config.text ?? "final", tools: "full" },
    });
    signal.throwIfAborted();
    const capabilities = initialized.description.capabilities;
    const missing = REQUIRED_METHODS.filter((method) => !capabilities.methods.includes(method));
    if (!capabilities.persistence || capabilities.acceptance !== "durable") throw new HarnessIncompatibleError("the native harness does not offer durable sessions");
    if (missing.length) throw new HarnessIncompatibleError(`the native harness lacks ${missing.join(", ")}`);
    if (!capabilities.startupChannelChanges) throw new HarnessIncompatibleError("the native harness cannot apply channel changes at open");
    if (functions && !capabilities.functions) throw new HarnessIncompatibleError("the native harness cannot call host functions");

    // The startup cutoff: what is pending now goes inside the open and is applied before any work
    // can run. An edit made after this line is sent through the live channel methods once open.
    const batch = await this.#changes.startupBatch(signal);
    await this.reminderSync?.initialize(initialized.description);
    const opened = await openOrCreate(client, this.#config, batch, functions?.catalog(), signal, this.reminderSync);
    for (const event of earlyReminders.splice(0)) reminderEvent(event);
    await this.reminderSync?.settled();
    signal.throwIfAborted();
    await this.#changes.acknowledgeOpen(opened.channelChanges ?? [], signal);
    signal.throwIfAborted();

    const status = await client.status();
    signal.throwIfAborted();
    const view: LoadResult = { status, items: [], turns: [], messages: [] };
    const submissions = this.records.submissions();
    const observed = new Map<string, number>();
    const boundaries = new Map<string, number>();
    for (const channel of new Set([...this.#ports.keys(), ...submissions.map(item => item.channel)])) {
      const saved = submissions.filter(item => item.channel === channel).map(item => item.id);
      try {
        const recovered = await recoverChannel(client, channel, saved, this.#ports.get(channel)?.trackedTurns?.() ?? [], { signal, atObservation: () => { boundaries.set(channel, this.#early?.length ?? 0); } });
        const { observation } = recovered;
        observed.set(channel, observation.revision);
        const known = status.channels.find(value => value.channel === channel);
        const { pendingCount: _pendingCount, ...state } = observation.channel;
        if (known) Object.assign(known, state);
        else status.channels.push({ ...state, pending: [] });
        view.items.push(...recovered.items);
        view.turns.push(...recovered.turns);
        view.messages.push(...recovered.messages);
        for (const request of observation.approvals) {
          const boundary = boundaries.get(channel)!;
          const event = { channel, event: { type: "approval_requested" as const, ...request } };
          this.#observeApproval(connection, event);
          this.#early?.splice(boundary, 0, event);
        }
      } catch (error) {
        if (codeOf(error) !== "not_found") throw error;
      }
    }

    this.#lastStatus = status;
    this.#capabilities = capabilities;
    this.#channels.clear();
    for (const channel of view.status.channels) this.#channels.set(channel.channel, channel);
    this.#connection = connection;
    reminderOpen = true;
    for (const event of earlyReminders.splice(0)) reminderEvent(event);
    this.#reconcile(view, observed);
    for (const turn of view.turns) {
      if (turn.state !== "running" && turn.state !== "suspended") this.#approvals.end(turn.channel, turn.turnId);
    }

    // Events received while the view was being read and applied: the ones it already includes are
    // dropped; the rest follow in delivery order. Several events can share a revision, so the
    // comparison is with the view's revision, never with the previous event's.
    const early = this.#early ?? [];
    this.#early = null;
    for (const [index, event] of early.entries()) {
      if (event.revision === undefined ? index < (boundaries.get(event.channel) ?? 0)
        : event.revision <= (observed.get(event.channel) ?? status.revision)) continue;
      this.#deliver(event);
    }
  }

  #functions: NativeFunctionHost | null = null;

  /** The function host, created on first use so a host without functions makes no result directory. */
  #functionHost(): NativeFunctionHost | null {
    if (!this.#config.functions) return null;
    return this.#functions ??= createNativeFunctionHost(this.#config.functions);
  }

  /** Every registered tool with its availability and, when unavailable, the reason. Policy is separate. */
  async tools(): Promise<ToolAvailability[]> { return (await this.#client().tools()).tools; }
  /** Revoke a `revocable` tool's grant. The harness keeps it with the session, across reopen. */
  async revokeTool(name: string): Promise<ToolAvailability> { return (await this.#client().revokeTool(name)).tool; }
  async restoreTool(name: string): Promise<ToolAvailability> { return (await this.#client().restoreTool(name)).tool; }
  /** Enable a `runtime` tool by name. Remembered here and supplied again on the next open. */
  async enableTool(name: string): Promise<ToolAvailability> {
    const tool = (await this.#client().enableTool(name)).tool;
    this.#functionHost()?.select(name, true);
    return tool;
  }
  async removeTool(name: string): Promise<ToolAvailability> {
    const tool = (await this.#client().removeTool(name)).tool;
    this.#functionHost()?.select(name, false);
    return tool;
  }
  /** One tool call by its invocation ID, from the harness's records. Undefined when unknown. */
  async toolInvocation(invocationId: string): Promise<ToolInvocation | undefined> {
    try { return (await this.#client().toolInvocation(invocationId)).invocation; }
    catch (error) { if (codeOf(error) === "not_found") return undefined; throw error; }
  }
  async toolInvocations(turn: string): Promise<ToolInvocation[]> { return (await this.#client().toolInvocations(turn)).invocations; }

  /** Settles what the view answers: submissions first (they decide which turn causes are ours), then each channel. */
  #reconcile(view: LoadResult, observed: ReadonlyMap<string, number>): void {
    const items = new Map(view.items.map((item) => [item.id, item]));
    for (const submission of this.records.submissions()) {
      const item = items.get(submission.id);
      if (!item) continue; // unknown to the harness: retried after the open, with the same id and payload
      if (item.milestone === "withdrawn") this.records.settleSubmission(submission.id);
      else this.records.markAccepted(submission.id, item.turnId !== undefined);
      this.#waiters.get(submission.id)?.resolve(item);
      this.#waiters.delete(submission.id);
    }
    for (const [channel, port] of [...this.#ports]) {
      port.reconcile({
        revision: observed.get(channel) ?? view.status.revision,
        status: this.#channels.get(channel),
        turns: view.turns.filter((turn) => turn.channel === channel),
        items: view.items.filter((item) => item.channel === channel),
        messages: view.messages.filter((message) => message.channel === channel),
      });
    }
  }

  /** Queue unresolved submissions behind the post-cutoff edits. */
  #replaySubmissions(): void {
    for (const submission of this.records.submissions()) {
      if (submission.withdrawing) { this.#retryWithdrawal(submission, true); continue; }
      if (submission.state === "accepted") continue;
      // Saved and never written, with nobody waiting (its caller was told it failed, or is gone):
      // it is not sent now.
      if (submission.state === "saved" && !this.#waiters.has(submission.id)) { this.records.settleSubmission(submission.id); continue; }
      void this.#changes.enqueue(submission.channel, () => this.#submit(submission.id)).catch(() => undefined);
    }
  }
  /** The connection is gone. Reopen if work is outstanding; otherwise wait for the next use. */
  #lost(connection: NativeConnection): void {
    if (this.#connection !== connection) return;
    this.#connection = null;
    this.#approvals.disconnected();
    if (this.#stopped) return;
    this.#setState("stopped");
    this.#log.warn("native_harness_connection_lost", { sessionId: this.sessionId });
    for (const port of [...this.#ports.values()]) port.disconnected();
    // An input the harness accepted is outstanding until its turn settles, even when the process died
    // before this host saw that turn start: its `turn_started` may never have been written.
    const outstanding = this.#waiters.size > 0 || [...this.#ports.values()].some((port) => port.busy()) || this.records.submissions().length > 0;
    if (outstanding) void this.#reopen();
    else if (this.#workerDelivery) void this.#workerDelivery.hasWork().then(hasWork => {
      if (hasWork && this.#state === "stopped" && !this.#stopped) void this.#reopen();
    }).catch(error => this.#log.warn("native_worker_delivery_discovery_failed", { error: String(error) }));
  }

  async #reopen(): Promise<void> {
    while (!this.#stopped && this.#claimRestart(Date.now())) {
      try {
        await this.ensureStarted();
        return;
      } catch (error) {
        this.#log.warn("native_harness_reopen_failed", { error: String(error) });
        await new Promise((resolve) => setTimeout(resolve, 100 * this.#restarts.length));
      }
    }
    if (!this.#stopped) this.#failReopen();
  }

  #claimRestart(now: number): boolean {
    const { limit, windowMs } = this.#config.restart ?? { limit: 3, windowMs: 60_000 };
    while (this.#restarts.length && now - this.#restarts[0]! > windowMs) this.#restarts.shift();
    if (this.#restarts.length >= limit) return false;
    this.#restarts.push(now);
    return true;
  }

  #failReopen(): Error {
    // Report exhausted retries to pending callers and stop automatic starts.
    this.#failure = new HarnessUnavailableError("the native harness could not be reopened", { code: "reopen_failed" });
    this.#setState("failed");
    this.#rejectWaiters(this.#failure);
    for (const port of [...this.#ports.values()]) port.failed(this.#failure);
    return this.#failure;
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters.values()) waiter.reject(error);
    this.#waiters.clear();
  }

  #route(connection: NativeConnection, event: ChannelEvent): void {
    // A late event of a connection that was replaced is not this session's present.
    if (this.#stopped || (this.#connection !== null && this.#connection !== connection)) return;
    this.#observeApproval(connection, event);
    if (this.#early) { this.#early.push(event); return; }
    this.#deliver(event);
  }

  #deliver(event: ChannelEvent): void {
    this.reminderIdle?.activity();
    if (event.event.type === "item_withdrawn") {
      const id = event.event.item;
      const sender = this.records.submission(id)?.sender ?? "";
      this.records.settleSubmission(id);
      this.#waiters.get(id)?.resolve({ id, channel: event.channel, sender, kind: "participant_message", milestone: "withdrawn" });
      this.#waiters.delete(id);
    }
    if (event.event.type === "turn_started" || event.event.type === "turn_took") for (const id of event.event.items) if (this.records.submission(id)?.withdrawing) this.records.markAccepted(id, true);
    if (event.event.type === "approval_requested") this.#approvals.start(event.event);
    if (event.event.type === "approval_closed") this.#approvals.closed(event.event);
    if (event.event.type === "turn_ended") this.#approvals.end(event.channel, event.event.turnId);
    if (event.event.type === "channel_state") {
      const known = this.#channels.get(event.channel);
      const { displayName, policy, lifecycle } = event.event;
      const { displayName: _name, policy: _policy, ...rest } = known ?? { channel: event.channel, pending: [], waitingForResume: false, lifecycle };
      this.#channels.set(event.channel, { ...rest, lifecycle, ...(displayName === undefined ? {} : { displayName }), ...(policy === undefined ? {} : { policy }) });
    }
    const buffered = this.#attaching.get(event.channel);
    if (buffered) { buffered.push(event); return; }
    const port = this.#ports.get(event.channel);
    if (port) { port.event(event); return; }
    // No conversation attached: keep the channel's events until one is. Bounded so an unattended
    // channel cannot grow without limit; state events are not kept (the status is tracked above).
    if (event.event.type === "channel_state") return;
    const held = this.#backlog.get(event.channel) ?? [];
    held.push(event);
    if (held.length > 2000) held.shift();
    this.#backlog.set(event.channel, held);
  }

  #client(): HarnessClient {
    // Also during an open, once the view is in: reconciliation may read a message by reference.
    const client = this.#connection?.client;
    if (!client) throw new HarnessUnavailableError("the native harness is not running", { code: "not_running" });
    return client;
  }

  /**
   * Hands one input to the harness. The id and exact payload are saved first; the promise resolves on a
   * receipt or when reconciliation finds the item, whichever comes first, possibly after a reopen. A
   * definite refusal (suspended or retired channel, unknown policy, a conflicting id) rejects it.
   */
  async push(input: Omit<Submission, "state">): Promise<ItemStatus> {
    this.records.saveSubmission({ ...input, state: "saved" });
    const waiter = this.#waiters.get(input.id) ?? deferred<ItemStatus>();
    this.#waiters.set(input.id, waiter);
    try {
      await this.ensureStarted();
    } catch (error) {
      if (this.#waiters.get(input.id) === waiter) this.#waiters.delete(input.id);
      // Nothing was written for it, so the harness cannot have it: the caller is told it failed and
      // it must never run later. One that was written before (`unknown`) stays for the next open.
      if (this.records.submission(input.id)?.state === "saved") this.records.settleSubmission(input.id);
      throw error;
    }
    // Behind the channel's queued live edits: an edit made before this input reaches the harness first.
    void this.#changes.enqueue(input.channel, () => this.#submit(input.id)).catch(() => undefined);
    return waiter.promise;
  }

  async #submit(id: string): Promise<void> {
    const submission = this.records.submission(id);
    if (!submission || submission.withdrawing) return;
    if (submission.state === "accepted" && !this.#waiters.has(id)) return;
    // Read when the outcome is known, not now: a caller may start waiting for this id while the
    // request is in flight (a retry after a reopen, then the conversation's own send).
    const settle = (act: (waiter: Deferred<ItemStatus>) => void) => {
      const waiter = this.#waiters.get(id);
      this.#waiters.delete(id);
      if (waiter) act(waiter);
    };
    const request = () => {
      const client = this.#client();
      // Recorded before the bytes leave: from here the outcome is unknown until a receipt or a view.
      this.records.markSent(id);
      return client.push({
      channel: submission.channel,
      item: {
        id: submission.id, kind: "user_message", sender: submission.sender,
        content: [{ type: "text", text: submission.text }],
        ...(submission.policy === undefined ? {} : { policy: submission.policy }),
      },
      });
    };
    try {
      let receipt;
      try { receipt = await request(); }
      catch (error) {
        // No answer on a live connection: the same id and payload again. The harness answers a
        // repeat with the original item, so this never creates a second input.
        const pending = this.records.submission(id);
        if (codeOf(error) !== "timeout" || this.#state !== "running" || !pending || pending.withdrawing) throw error;
        receipt = await request();
      }
      const item: ItemStatus = receipt.item ?? { id, channel: submission.channel, kind: "participant_message", sender: submission.sender, milestone: "received" };
      if (item.milestone === "withdrawn") { this.#deliver({ channel: submission.channel, event: { type: "item_withdrawn", item: id } }); return; }
      this.records.markAccepted(id, item.turnId !== undefined);
      settle((waiter) => waiter.resolve(item));
      if (this.records.submission(id)?.withdrawing) this.#retryWithdrawal(submission);
    } catch (error) {
      // Unknown outcome: the saved submission stays `unknown`. The next open finds it in the view
      // (accepted) or retries it with this id and payload.
      if (ambiguous(error)) {
        if (codeOf(error) === "timeout" && this.records.submission(id)?.withdrawing) this.#retryWithdrawal(submission, true);
        return;
      }
      // Not running, so nothing was written this time. Whoever waits is reopened for by `#lost`, or
      // was already told the host stopped or failed.
      if (error instanceof HarnessUnavailableError) return;
      this.records.settleSubmission(id);
      settle((waiter) => waiter.reject(error));
    }
  }

  /** The input reached its end (its turn ended, or it was withdrawn): nothing is left to retry. */
  settle(ids: Iterable<string>): void {
    for (const id of ids) this.records.settleSubmission(id);
  }

  /**
   * Records the newest desired state of a channel. Running: applied through the live channel methods,
   * in order with that channel's inputs. Stopped: stored, and sent with the next open; it never starts
   * the harness.
   */
  async changeChannel(channel: string, desire: ChannelDesire): Promise<ChannelChangeOutcome> {
    if (this.#idling) await this.ensureStarted();
    this.reminderIdle?.activity();
    const result = await this.#changes.change(channel, desire, this.#state === "running");
    if (result.state === "applied") void this.flushWorkerDelivery();
    return result;
  }

  /** The pending channel intents from the host's active store. */
  async pendingChannelChanges(): Promise<PendingChange[]> { return this.#changes.pendingChanges(); }

  /** Reserve delivery now, then read the intent only after its transaction commits. */
  async deliverCommittedChannelChange<T>(channel: string, commit: Promise<T>, deliver: (result: T) => boolean = () => true): Promise<T> {
    this.reminderIdle?.activity();
    const result = await this.#changes.deliverCommitted(channel, commit, () => this.#state === "running", deliver);
    void this.flushWorkerDelivery();
    return result;
  }

  /** The session's status as the running harness reports it now. */
  #lastStatus?: StatusResult;
  #capabilities?: Awaited<ReturnType<HarnessClient["initialize"]>>["description"]["capabilities"];

  get capabilities() { return this.#capabilities; }
  get sessionLifecycle() { return this.#lastStatus?.lifecycle; }
  async status(): Promise<StatusResult> {
    const live = await this.#client().status();
    this.#lastStatus = live;
    return live;
  }

  async operatorStatus() {
    const connection = this.#connection;
    let confirmed = false;
    if (connection) {
      try { await this.status(); confirmed = true; }
      catch (error) { if (!ambiguous(error)) throw error; }
    }
    const session = this.#lastStatus;
    const workingChannels = session?.channels.filter(channel => channel.activeTurn?.state === "running").length ?? 0;
    return { process: this.#state, stale: !confirmed || this.#connection !== connection, session, workingChannels };
  }

  async usage(channel?: string) { return summarizeModelUsage(this.#client(), channel); }

  start(): Promise<void> { return this.ensureStarted(); }
  async suspend(): Promise<StatusResult> {
    const status = await this.#client().suspend();
    this.#lastStatus = status;
    return status;
  }
  async resume(): Promise<StatusResult> {
    const status = await this.#client().resume();
    this.#lastStatus = status;
    void this.flushWorkerDelivery();
    return status;
  }
  validateConfig(config: unknown) { return this.#client().validateConfig(config); }
  async suspendChannel(channel: string) { return this.#client().suspendChannel({ channel }); }
  async resumeChannel(channel: string) {
    const status = await this.#changes.resume(channel);
    void this.flushWorkerDelivery();
    return status;
  }

  async flushWorkerDelivery(): Promise<void> {
    if (this.#state !== "running") return;
    try { await this.#workerDelivery?.flush(); }
    catch (error) { this.#log.warn("native_worker_delivery_failed", { error: String(error) }); }
  }
  reconcileChannel(params: Parameters<HarnessClient["reconcileChannel"]>[0]) { return this.#client().reconcileChannel(params); }
  modelCalls(params: Parameters<HarnessClient["modelCalls"]>[0] = {}, signal?: AbortSignal) { return this.#client().modelCalls(params, signal); }
  conversationMessages(params: Parameters<HarnessClient["channelMessages"]>[0]) { return this.#client().channelMessages(params); }
  /** Commit each page atomically with its position. On failure the caller's
   * last committed position is the retry boundary. */
  async catchUp(channel: string, after: string,
    commit: (messages: Awaited<ReturnType<HarnessClient["channelMessages"]>>["messages"], position: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<string> {
    const client = this.#client();
    const connection = this.#connection;
    if (this.#attaching.has(channel)) throw new Error("Channel observation is already in progress");
    const buffered: ChannelEvent[] = [];
    this.#attaching.set(channel, buffered);
    const committed = new Set<string>();
    try { return await commitChannelCatchUp(client, channel, after, committed, commit, signal);
    } finally {
      this.#attaching.delete(channel);
      const port = this.#connection === connection ? this.#ports.get(channel) : undefined;
      for (const event of this.#connection === connection ? buffered : []) {
        if (event.event.type === "message_completed" && event.event.messageId && committed.has(event.event.messageId)) continue;
        if (port) port.event(event);
        else this.#deliver(event);
      }
    }
  }

  timeline(params: Parameters<HarnessClient["timeline"]>[0] = {}) { return this.#client().timeline(params); }

  /** Interrupts exactly this turn. False when it had already ended or was checkpointed. */
  async interrupt(channel: string, turn: string, reason?: string): Promise<boolean> {
    const result = await this.#client().interruptTurn({ channel, turn, ...(reason === undefined ? {} : { reason }) });
    return result.interrupted;
  }

  async respondApproval(requestId: string, decision: "allow_once" | "deny"): Promise<boolean> {
    if (this.#config.approvalResponder) return false;
    return this.#answerApproval(requestId, decision);
  }

  async #answerApproval(requestId: string, decision: "allow_once" | "deny"): Promise<boolean> {
    try {
      await this.#client().respondApproval(requestId, decision);
      return true;
    } catch (error) {
      if (codeOf(error) === "not_found" || ambiguous(error) || error instanceof HarnessUnavailableError) return false;
      throw error;
    }
  }

  async withdraw(channel: string, item: string): Promise<{ outcome: "withdrawn" } | { outcome: "taken"; turnId: string | undefined }> {
    const result = await this.#client().withdrawItem({ channel, item });
    if (result.outcome === "withdrawn") this.#deliver({ channel, event: { type: "item_withdrawn", item } });
    else { this.records.markAccepted(item, true); this.#waiters.get(item)?.resolve(result.item); this.#waiters.delete(item); }
    return result.outcome === "withdrawn" ? { outcome: "withdrawn" } : { outcome: "taken", turnId: result.item.turnId };
  }

  async withdrawSubmission(channel: string, id: string, onTaken?: (turnId?: string) => void): Promise<boolean> {
    const result = await this.#withdrawals.withdraw(channel, id, this.#waiters.get(id)?.promise);
    if (result?.outcome === "taken") onTaken?.(result.turnId);
    return result?.outcome === "withdrawn";
  }

  #retryWithdrawal(submission: Submission, reopened = false): void {
    const connection = this.#connection;
    void this.#withdrawals.retry(submission.channel, submission.id, undefined, reopened).catch(error => {
      this.#log.warn("native_withdrawal_unresolved", { item: submission.id, error: String(error) });
      // Once reconciliation is exhausted, unblock an unacknowledged push with uncertainty.
      if (reopened && this.#connection === connection && this.records.submission(submission.id)?.withdrawing) {
        this.#waiters.get(submission.id)?.reject(error);
        this.#waiters.delete(submission.id);
      }
    });
  }

  recoverStoppedReplies(channel: string, turnId: string, seen: Parameters<typeof recoverStoppedReplies>[3]) { return recoverStoppedReplies(this.#client(), channel, turnId, seen); }
  readMessage(messageId: string): Promise<string> { return readCompleteMessage(this.#client(), messageId); }
}
