import { NativeApprovals } from "./approvals.ts";
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
  aggregateUsage,
  HarnessClient,
  createStdioTransport,
  type ChannelChangeResult,
  type ChannelEvent,
  type ChannelStatusResult,
  type ItemStatus,
  type LoadResult,
  type PendingChannelChange,
  type ProtocolConfig,
  type StatusResult,
  type StoredMessage,
  type TurnStatus,
  type ToolAvailability,
  type ToolInvocation,
} from "../native-harness/src/client.ts";
import { recoverChannel } from "./recovery.ts";
import { createNativeFunctionHost, type NativeFunctionHost, type NativeFunctionsConfig } from "./functions.ts";
import { prepareNativeLaunch, onceDispose, type AcpLauncher } from "../launcher.ts";
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

/** What a live connection to a harness is, for the host. Tests substitute it; production spawns a process. */
export interface NativeConnection {
  readonly client: HarnessClient;
  /** Settles when the connection is gone (process exit, pipe closed, protocol failure). */
  readonly closed: Promise<void>;
  /** Ends the process. Graceful first (closing its input is a stop for the harness), then forced. */
  kill(): Promise<void>;
}

export type NativeApprovalRequest = Omit<Extract<ChannelEvent["event"], { type: "approval_requested" }>, "type"> & { channel: string };
export type NativeApprovalResponder = (
  request: NativeApprovalRequest,
  answer: (decision: "allow_once" | "deny") => Promise<boolean>,
  signal: AbortSignal,
) => void | Promise<void>;

export interface NativeHarnessHostConfig {
  /** The durable harness session: the Agent's id. */
  readonly sessionId: string;
  /** Sent on every open. Session configuration is fixed while the session is open. */
  readonly config: ProtocolConfig;
  /** The harness home, a path in the harness's environment. Must survive process restarts. */
  readonly home: string;
  /** How to start the harness server; defaults to this package's harness in `serve --stdio` mode. */
  readonly command?: readonly string[];
  readonly launcher?: AcpLauncher;
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly records?: NativeHostRecords;
  /** `final`: complete assistant messages only. `stream`: text deltas too. Default `final`. */
  readonly text?: "final" | "stream";
  /** From spawn to the open response. Default 30 000 ms. On expiry the process is killed and the start fails. */
  readonly startupTimeoutMs?: number;
  /** Per request to the running harness. Default 30 000 ms. */
  readonly requestTimeoutMs?: number;
  /** Automatic reopen attempts after an unexpected loss with work outstanding. Default 3 within 60 000 ms. */
  readonly restart?: { readonly limit: number; readonly windowMs: number };
  readonly logger?: Logger;
  /** A blocked channel change (a delete that found pending work, a resume the configuration cannot run...). */
  readonly onChannelChangeBlocked?: (result: ChannelChangeResult) => void;
  /** Functions the model can call, served by this process (tools and callbacks spec). */
  readonly functions?: NativeFunctionsConfig;
  readonly approvalResponder?: NativeApprovalResponder;
  /** Test seam: replaces the process launch. */
  readonly connect?: () => Promise<NativeConnection>;
}

const HARNESS_MAIN = new URL("../native-harness/src/interfaces/cli/main.ts", import.meta.url).pathname;
const REQUIRED_METHODS = ["session/open", "channel/observe", "channel/reconcile", "channel/push", "channel/create", "channel/edit", "channel/suspend", "channel/resume", "channel/delete", "channel/withdraw", "channel/interrupt", "approval/respond", "session/message/read"];

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => undefined); // observed by whoever awaits it; never an unhandled rejection
  return { promise, resolve, reject };
}

export class NativeHarnessHost {
  readonly sessionId: string;
  readonly records: NativeHostRecords;
  readonly #config: NativeHarnessHostConfig;
  readonly #log: Logger;
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
  /** Callers waiting for a submission's acceptance, across reopens. */
  readonly #waiters = new Map<string, Deferred<ItemStatus>>();
  readonly #stateListeners = new Set<() => void>();
  readonly #restarts: number[] = [];
  /** How many processes this host has started (observability and tests). */
  launches = 0;

  constructor(config: NativeHarnessHostConfig, channels?: ChannelPersistence) {
    this.#config = config;
    this.sessionId = config.sessionId;
    this.#log = config.logger ?? noopLogger;
    this.#approvals = new NativeApprovals(config.approvalResponder, this.#log);
    const records = config.records ?? createMemoryHostRecords();
    this.records = channels ? submissionRecords(records) : records;
    this.#changes = new NativeChannelChanges(channels ?? channelStore(records), this.#channels, () => this.#client(),
      this.#log, config.onChannelChangeBlocked);
    if (channels && fileHasPendingChannelChanges(records)) {
      this.#log.warn("native_file_channel_changes_ignored", { sessionId: this.sessionId });
    }
  }

  get state(): NativeHostState { return this.#state; }
  /** Why the host is `failed`. */
  get failure(): Error | null { return this.#failure; }
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

  // --- process lifecycle ------------------------------------------------------------------------

  /** Starts the harness if it is not running. Concurrent callers share one start. */
  ensureStarted(): Promise<void> {
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
    this.#stopped = true;
    const connection = this.#connection;
    this.#connection = null;
    await this.#starting?.catch(() => undefined);
    this.#setState("stopped");
    const error = new HarnessUnavailableError("the native harness was stopped", { code: "stopped" });
    this.#rejectWaiters(error);
    for (const port of [...this.#ports.values()]) port.failed(error);
    this.#approvals.stop();
    const live = connection ?? this.#connection;
    this.#connection = null;
    try {
      if (live) {
        try { await live.client.stop(); }
        finally { await live.kill(); }
      }
    } finally {
      this.#functions?.dispose();
      this.#functions = null;
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
        connection = await (this.#config.connect ?? (() => this.#launch()))();
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
          void live.closed.then(async () => {
            // A loss at the open boundary must reopen after the old start has retired.
            await this.#starting?.catch(() => undefined);
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

  async #launch(): Promise<NativeConnection> {
    const command = this.#config.command ?? [process.execPath, HARNESS_MAIN, "serve", "--stdio", "--home", this.#config.home];
    const launch = await prepareNativeLaunch(this.#config.launcher, { command, env: this.#config.env, cwd: this.#config.cwd });
    const dispose = onceDispose(launch.dispose);
    let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
    try {
      child = Bun.spawn(launch.command, { cwd: launch.spawnCwd, env: launch.spawnEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      await dispose();
      throw new HarnessUnavailableError(`the native harness could not be started: ${String(error)}`, { cause: error, code: "start_failed" });
    }
    void (async () => {
      // Diagnostics only: the protocol is on stdout.
      const text = await new Response(child.stderr).text().catch(() => "");
      if (text.trim()) this.#log.warn("native_harness_stderr", { text: text.slice(-4000) });
    })();
    const transport = createStdioTransport({
      readable: child.stdout,
      exited: child.exited,
      async write(bytes) { child.stdin.write(bytes); await child.stdin.flush(); },
      async end() { await child.stdin.end(); },
    });
    const closed = deferred<void>();
    transport.onClose(() => closed.resolve());
    void child.exited.then(() => { closed.resolve(); void dispose(); });
    const client = new HarnessClient(transport, this.#config.requestTimeoutMs ?? 30_000);
    return {
      client,
      closed: closed.promise,
      async kill() {
        client.close(); // closes the harness's input: it stops, recording running turns interrupted
        const forced = setTimeout(() => child.kill("SIGKILL"), 2000);
        try { await child.exited; } finally { clearTimeout(forced); }
      },
    };
  }

  /** Handlers first, then initialize, then load (or create) with the pending channel changes; then reconcile. */
  async #open(connection: NativeConnection, signal: AbortSignal): Promise<void> {
    const { client } = connection;
    this.#early = [];
    client.onChannelEvent((event) => this.#route(connection, event));
    client.onSessionEvent(event => {
      const status = this.#lastStatus;
      if (this.#connection !== connection || !status || status.revision > event.revision) return;
      this.#lastStatus = { ...status, lifecycle: event.lifecycle, revision: event.revision };
      this.#notifyState();
    });
    // Handlers are in place before `initialize` names them: a recovered call can arrive right after the open.
    const functions = this.#functionHost();
    if (functions) client.serveFunctions((call, signal) => functions.call(call, signal), (read) => functions.read(read));
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
    const opened = await this.#openOrCreate(client, batch, signal);
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

  async #openOrCreate(client: HarnessClient, batch: PendingChannelChange[], signal: AbortSignal) {
    const { sessionId, config } = this.#config;
    const functions = this.#functionHost();
    // The catalog and the current runtime selection go inside the open, before recovered work can start.
    const changes = { ...(batch.length ? { channelChanges: batch } : {}), ...(functions ? { tools: functions.catalog() } : {}) };
    const load = () => {
      signal.throwIfAborted();
      return client.openSession({ sessionId, config, ...changes });
    };
    try {
      try {
        return await load();
      } catch (error) {
        // The response was lost on a live connection: the same request again reports the recorded
        // results and applies nothing twice.
        if (codeOf(error) !== "timeout") throw error;
        return await load();
      }
    } catch (error) {
      if (codeOf(error) !== "not_found") throw error;
    }
    signal.throwIfAborted();
    return client.createSession({ sessionId, config, participants: [], channels: {}, ...changes });
  }

  /** Settles what the view answers: submissions first (they decide which turn causes are ours), then each channel. */
  #reconcile(view: LoadResult, observed: ReadonlyMap<string, number>): void {
    const items = new Map(view.items.map((item) => [item.id, item]));
    for (const submission of this.records.submissions()) {
      const item = items.get(submission.id);
      if (!item) continue; // unknown to the harness: retried after the open, with the same id and payload
      this.records.markAccepted(submission.id);
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
  }

  async #reopen(): Promise<void> {
    const { limit, windowMs } = this.#config.restart ?? { limit: 3, windowMs: 60_000 };
    for (;;) {
      const now = Date.now();
      while (this.#restarts.length && now - this.#restarts[0]! > windowMs) this.#restarts.shift();
      if (this.#stopped) return;
      if (this.#restarts.length >= limit) break;
      this.#restarts.push(now);
      try {
        await this.ensureStarted();
        return;
      } catch (error) {
        this.#log.warn("native_harness_reopen_failed", { error: String(error) });
        await new Promise((resolve) => setTimeout(resolve, 100 * this.#restarts.length));
      }
    }
    // Never a silent wait: restarts ran out, so everything pending fails with an explicit error.
    this.#failure = new HarnessUnavailableError("the native harness could not be reopened", { code: "reopen_failed" });
    this.#setState("failed");
    this.#rejectWaiters(this.#failure);
    for (const port of [...this.#ports.values()]) port.failed(this.#failure);
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters.values()) waiter.reject(error);
    this.#waiters.clear();
  }

  // --- events -----------------------------------------------------------------------------------

  #route(connection: NativeConnection, event: ChannelEvent): void {
    // A late event of a connection that was replaced is not this session's present.
    if (this.#stopped || (this.#connection !== null && this.#connection !== connection)) return;
    this.#observeApproval(connection, event);
    if (this.#early) { this.#early.push(event); return; }
    this.#deliver(event);
  }

  #deliver(event: ChannelEvent): void {
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

  // --- channel work -----------------------------------------------------------------------------

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
    if (!submission) return;
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
        if (codeOf(error) !== "timeout" || this.#state !== "running") throw error;
        receipt = await request();
      }
      this.records.markAccepted(id);
      const item: ItemStatus = receipt.item ?? { id, channel: submission.channel, kind: "participant_message", sender: submission.sender, milestone: "received" };
      settle((waiter) => waiter.resolve(item));
    } catch (error) {
      // Unknown outcome: the saved submission stays `unknown`. The next open finds it in the view
      // (accepted) or retries it with this id and payload.
      if (ambiguous(error)) return;
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
  changeChannel(channel: string, desire: ChannelDesire): Promise<ChannelChangeOutcome> {
    return this.#changes.change(channel, desire, this.#state === "running");
  }

  /** The pending channel intents from the host's active store. */
  async pendingChannelChanges(): Promise<PendingChange[]> { return this.#changes.pendingChanges(); }

  /** Reserve delivery now, then read the intent only after its transaction commits. */
  deliverCommittedChannelChange<T>(channel: string, commit: Promise<T>, deliver: (result: T) => boolean = () => true): Promise<T> {
    return this.#changes.deliverCommitted(channel, commit, () => this.#state === "running", deliver);
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

  async usage(channel?: string) {
    const client = this.#client();
    const attempts: Parameters<typeof aggregateUsage>[0][number][] = [];
    for (let after: string | undefined; ;) {
      const page = await client.modelCalls({ after });
      for (const call of page.calls) if (channel === undefined || call.channel === channel) attempts.push(...call.attempts);
      if (!page.next) break;
      after = page.next;
    }
    const totals = aggregateUsage(attempts);
    const missing = Object.fromEntries((["inputTokens", "outputTokens", "totalTokens"] as const)
      .map(field => [field, attempts.filter(attempt => attempt.usage?.[field] === undefined).length]));
    return { totals, missing, attempts: attempts.length, partial: Object.values(missing).some(count => count > 0) };
  }

  start(): Promise<void> { return this.ensureStarted(); }
  async suspend(): Promise<StatusResult> {
    const status = await this.#client().suspend();
    this.#lastStatus = status;
    return status;
  }
  async resume(): Promise<StatusResult> {
    const status = await this.#client().resume();
    this.#lastStatus = status;
    return status;
  }
  validateConfig(config: unknown) { return this.#client().validateConfig(config); }
  async suspendChannel(channel: string) { return this.#client().suspendChannel({ channel }); }
  resumeChannel(channel: string) { return this.#changes.resume(channel); }
  reconcileChannel(params: Parameters<HarnessClient["reconcileChannel"]>[0]) { return this.#client().reconcileChannel(params); }
  modelCalls(params: Parameters<HarnessClient["modelCalls"]>[0] = {}) { return this.#client().modelCalls(params); }
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
    let position = after;
    const committed = new Set<string>();
    try {
      signal?.throwIfAborted();
      const { revision } = await client.observeChannel({ channel });
      let cursor: string | undefined;
      do {
        signal?.throwIfAborted();
        const page = await client.channelMessages(cursor === undefined
          ? { channel, after, throughRevision: revision } : { channel, cursor });
        signal?.throwIfAborted();
        if (page.messages.length) {
          const next = page.messages.at(-1)!.position;
          await commit(page.messages, next);
          position = next;
          for (const message of page.messages) committed.add(message.messageId);
        }
        cursor = page.next;
      } while (cursor !== undefined);
      return position;
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

  /** Answers one approval request. False when the answer was late: the request is closed and stays closed. */
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

  /** Withdraws an accepted input the harness has not taken. `taken` names the turn that owns it instead. */
  async withdraw(channel: string, item: string): Promise<{ outcome: "withdrawn" } | { outcome: "taken"; turnId: string | undefined }> {
    const result = await this.#client().withdrawItem({ channel, item });
    if (result.outcome === "withdrawn") { this.records.settleSubmission(item); return { outcome: "withdrawn" }; }
    return { outcome: "taken", turnId: result.item.turnId };
  }

  /** The committed text of one assistant message, whatever its size. */
  async readMessage(messageId: string): Promise<string> {
    const client = this.#client();
    const chunks: Buffer[] = [];
    for (let offset: number | undefined = 0; offset !== undefined;) {
      const page: { data: string; nextOffset?: number } = await client.readMessage({ messageId, offset });
      chunks.push(Buffer.from(page.data, "base64"));
      offset = page.nextOffset;
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
