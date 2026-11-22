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
  HarnessClient,
  HarnessClientError,
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
import { createNativeFunctionHost, type NativeFunctionHost, type NativeFunctionsConfig } from "./functions.ts";
import { prepareNativeLaunch, onceDispose, type AcpLauncher } from "../launcher.ts";
import { noopLogger, type Logger } from "../logger.ts";
import { createMemoryHostRecords, type ChannelDesire, type NativeHostRecords, type PendingChange, type Submission } from "./records.ts";

export type NativeHostState = "stopped" | "starting" | "running" | "failed";

/** The harness cannot be used: its start failed, it was stopped, or its restarts ran out. */
export class HarnessUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HarnessUnavailableError";
  }
}

/** The running harness lacks something this integration requires (durable sessions, channel controls, approvals, startup changes). */
export class HarnessIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessIncompatibleError";
  }
}

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

export type ChannelChangeOutcome =
  | { readonly state: "applied" }
  /** Stored; goes out with the next open. The harness is not running and a channel change never starts it. */
  | { readonly state: "pending" }
  | { readonly state: "blocked"; readonly reason: NonNullable<ChannelChangeResult["reason"]> };

/** What a live connection to a harness is, for the host. Tests substitute it; production spawns a process. */
export interface NativeConnection {
  readonly client: HarnessClient;
  /** Settles when the connection is gone (process exit, pipe closed, protocol failure). */
  readonly closed: Promise<void>;
  /** Ends the process. Graceful first (closing its input is a stop for the harness), then forced. */
  kill(): Promise<void>;
}

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

const codeOf = (error: unknown): string | undefined => error instanceof HarnessClientError ? error.code : undefined;
/** The request's outcome is unknown: it may or may not have been applied. */
const ambiguous = (error: unknown) => { const code = codeOf(error); return code === "timeout" || code === "transport_closed" || code === "closed"; };
const toWire = (change: PendingChange): PendingChannelChange => ({ channel: change.channel, changeId: String(change.version), ...change.desire });

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
  /** Per channel: live edits and pushes run one at a time, in order, so an edit lands before later input. */
  readonly #queues = new Map<string, Promise<unknown>>();
  /** Callers waiting for a submission's acceptance, across reopens. */
  readonly #waiters = new Map<string, Deferred<ItemStatus>>();
  readonly #stateListeners = new Set<() => void>();
  readonly #restarts: number[] = [];
  /** How many processes this host has started (observability and tests). */
  launches = 0;

  constructor(config: NativeHarnessHostConfig) {
    this.#config = config;
    this.sessionId = config.sessionId;
    this.records = config.records ?? createMemoryHostRecords();
    this.#log = config.logger ?? noopLogger;
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
    for (const listener of [...this.#stateListeners]) { try { listener(); } catch { /* an observer never breaks the host */ } }
  }

  /** The channel as the harness last reported it; undefined before the first open or for a channel it has not seen. */
  channel(channel: string): ChannelStatusResult | undefined { return this.#channels.get(channel); }

  // --- conversations ----------------------------------------------------------------------------

  /** Attaches a conversation to its channel. Starts nothing. Events held for the channel are delivered now. */
  attach(channel: string, port: ChannelPort): () => void {
    this.#ports.set(channel, port);
    const held = this.#backlog.get(channel);
    if (held) {
      this.#backlog.delete(channel);
      for (const event of held) port.event(event);
    }
    return () => { if (this.#ports.get(channel) === port) this.#ports.delete(channel); };
  }

  // --- process lifecycle ------------------------------------------------------------------------

  /** Starts the harness if it is not running. Concurrent callers share one start. */
  ensureStarted(): Promise<void> {
    if (this.#state === "running") return Promise.resolve();
    if (this.#state === "failed") return Promise.reject(new HarnessUnavailableError("the native harness is unavailable; call restart()", { cause: this.#failure }));
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
    const error = new HarnessUnavailableError("the native harness was stopped");
    this.#rejectWaiters(error);
    for (const port of [...this.#ports.values()]) port.failed(error);
    await (connection ?? this.#connection)?.kill();
    this.#connection = null;
    // Stored results were temporary: a default result directory goes with the host.
    this.#functions?.dispose();
    this.#functions = null;
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
        await this.#open(connection, deadline.signal);
      })();
      opening.catch(() => undefined);
      await Promise.race([opening, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new HarnessUnavailableError(`the native harness did not open within ${limit} ms`);
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
    const live = connection!;
    this.#connection = live;
    this.#setState("running");
    void live.closed.then(() => this.#lost(live));
    this.#afterOpen();
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
      throw new HarnessUnavailableError(`the native harness could not be started: ${String(error)}`, { cause: error });
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
    const cutoff = this.records.pendingChanges();
    const batch = cutoff.map(toWire);
    const opened = await this.#openOrCreate(client, batch, signal);
    signal.throwIfAborted();

    this.#blockedVersions.clear();
    for (const result of opened.channelChanges ?? []) {
      // Cleared only when this exact version was applied: an edit made during the open stays pending.
      if (result.outcome === "applied") this.records.confirmChange(result.channel, Number(result.changeId));
      else {
        // Stays pending for the host: a later open re-evaluates it once its obstacle is resolved.
        this.#blockedVersions.set(result.channel, Number(result.changeId));
        this.#log.warn("native_channel_change_blocked", { ...result });
        try { this.#config.onChannelChangeBlocked?.(result); } catch { /* observer */ }
      }
    }

    const status = await client.status();
    signal.throwIfAborted();
    const view: LoadResult = { status, items: [], turns: [], messages: [] };
    const submissions = this.records.submissions();
    const observed = new Map<string, number>();
    for (const channel of new Set([...this.#ports.keys(), ...submissions.map(item => item.channel)])) {
      const saved = submissions.filter(item => item.channel === channel);
      try {
        const current = await client.observeChannel({ channel });
        signal.throwIfAborted();
        observed.set(channel, current.revision);
        const known = status.channels.find(value => value.channel === channel);
        const { pendingCount: _pendingCount, ...state } = current.channel;
        if (known) Object.assign(known, state);
        else status.channels.push({ ...state, pending: [] });
      } catch (error) {
        if (codeOf(error) !== "not_found") throw error;
        continue;
      }
      const tracked = new Set(this.#ports.get(channel)?.trackedTurns?.() ?? []);
      for (let offset = 0; offset < saved.length; offset += 100) {
        const page = await client.reconcileChannel({ channel, itemIds: saved.slice(offset, offset + 100).map(item => item.id) });
        signal.throwIfAborted();
        view.items.push(...page.items);
        for (const item of page.items) if (item.turnId) tracked.add(item.turnId);
      }
      const turnIds = [...tracked];
      for (let offset = 0; offset < turnIds.length; offset += 100) {
        let page = await client.reconcileChannel({ channel, turnIds: turnIds.slice(offset, offset + 100) });
        signal.throwIfAborted();
        view.turns.push(...page.turns.map(turn => ({ ...turn, items: view.items.filter(item => item.turnId === turn.turnId).map(item => item.id) })));
        while (true) {
          view.messages.push(...page.replies.map(reply => ({ channel, messageId: reply.messageId, turnId: reply.turnId, reference: true as const })));
          if (!page.next) break;
          page = await client.reconcileChannel({ channel, cursor: page.next });
          signal.throwIfAborted();
        }
      }
    }

    this.#channels.clear();
    for (const channel of view.status.channels) this.#channels.set(channel.channel, channel);
    this.#connection = connection;
    this.#reconcile(view, view.messages);

    // Events received while the view was being read and applied: the ones it already includes are
    // dropped; the rest follow in delivery order. Several events can share a revision, so the
    // comparison is with the view's revision, never with the previous event's.
    const early = this.#early ?? [];
    this.#early = null;
    for (const event of early) {
      if (event.revision !== undefined && event.revision <= (observed.get(event.channel) ?? opened.revision)) continue;
      this.#deliver(event);
    }
  }

  /** Per channel, the version of a change the harness reported blocked. That version is not resent while running. */
  readonly #blockedVersions = new Map<string, number>();
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
  #reconcile(view: LoadResult, messages: StoredMessage[]): void {
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
        revision: view.status.revision,
        status: this.#channels.get(channel),
        turns: view.turns.filter((turn) => turn.channel === channel),
        items: view.items.filter((item) => item.channel === channel),
        messages: messages.filter((message) => message.channel === channel),
      });
    }
  }

  /** Once running: edits made after the cutoff, then submissions the harness does not have. Queued per channel, in that order. */
  #afterOpen(): void {
    for (const change of this.records.pendingChanges()) {
      // A change the open just reported blocked is not retried at once: its obstacle is still there.
      // A newer version of it (an edit made after the cutoff) is a different request and is sent.
      if (this.#blockedVersions.get(change.channel) === change.version) continue;
      void this.#enqueue(change.channel, () => this.#flushChange(change.channel)).catch(() => undefined);
    }
    for (const submission of this.records.submissions()) {
      if (submission.state === "accepted") continue;
      // Saved and never written, with nobody waiting (its caller was told it failed, or is gone):
      // it is not sent now.
      if (submission.state === "saved" && !this.#waiters.has(submission.id)) { this.records.settleSubmission(submission.id); continue; }
      void this.#enqueue(submission.channel, () => this.#submit(submission.id)).catch(() => undefined);
    }
  }
  /** The connection is gone. Reopen if work is outstanding; otherwise wait for the next use. */
  #lost(connection: NativeConnection): void {
    if (this.#connection !== connection) return;
    this.#connection = null;
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
    this.#failure = new HarnessUnavailableError("the native harness could not be reopened");
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
    if (this.#connection !== null && this.#connection !== connection) return;
    if (this.#early) { this.#early.push(event); return; }
    this.#deliver(event);
  }

  #deliver(event: ChannelEvent): void {
    if (event.event.type === "channel_state") {
      const known = this.#channels.get(event.channel);
      const { displayName, policy, lifecycle } = event.event;
      const { displayName: _name, policy: _policy, ...rest } = known ?? { channel: event.channel, pending: [], waitingForResume: false, lifecycle };
      this.#channels.set(event.channel, { ...rest, lifecycle, ...(displayName === undefined ? {} : { displayName }), ...(policy === undefined ? {} : { policy }) });
    }
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

  #enqueue<T>(channel: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(channel) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    this.#queues.set(channel, tail);
    void tail.then(() => { if (this.#queues.get(channel) === tail) this.#queues.delete(channel); });
    return next;
  }

  #client(): HarnessClient {
    // Also during an open, once the view is in: reconciliation may read a message by reference.
    const client = this.#connection?.client;
    if (!client) throw new HarnessUnavailableError("the native harness is not running");
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
    void this.#enqueue(input.channel, () => this.#submit(input.id)).catch(() => undefined);
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
    this.records.desire(channel, desire);
    // Not running, or an open is in progress past its cutoff: the change stays pending. An open in
    // progress sends it through the live methods as soon as it completes, before fresh input.
    if (this.#state !== "running") return Promise.resolve({ state: "pending" });
    return this.#enqueue(channel, () => this.#flushChange(channel));
  }

  async #flushChange(channel: string): Promise<ChannelChangeOutcome> {
    for (;;) {
      const pending = this.records.pendingChange(channel);
      if (!pending) return { state: "applied" };
      const outcome = await this.#applyLive(pending);
      if (outcome.state !== "applied") {
        if (outcome.state === "blocked") this.#blockedVersions.set(channel, pending.version);
        return outcome;
      }
      // An older acknowledgment cannot clear a newer edit: if the state changed meanwhile, go again.
      if (this.records.confirmChange(channel, pending.version)) return outcome;
    }
  }

  async #applyLive(change: PendingChange): Promise<ChannelChangeOutcome> {
    const { channel, desire } = change;
    const client = this.#client();
    const seen = (result: { channel: ChannelStatusResult }) => { this.#channels.set(channel, result.channel); };
    const known = this.#channels.get(channel);
    const blocked = (reason: NonNullable<ChannelChangeResult["reason"]>): ChannelChangeOutcome => {
      const result: ChannelChangeResult = { channel, changeId: String(change.version), outcome: "blocked", reason };
      try { this.#config.onChannelChangeBlocked?.(result); } catch { /* observer */ }
      return { state: "blocked", reason };
    };
    try {
      if (known?.lifecycle === "retired") return desire.lifecycle === "retired" ? { state: "applied" } : blocked("channel_retired");
      if (desire.lifecycle === "retired") {
        if (!known) seen(await client.createChannel({ channel }));
        try {
          seen(await client.deleteChannel({ channel }));
        } catch (error) {
          if (codeOf(error) !== "channel_busy") throw error;
          // The same rule as at open: pending work must neither run nor be lost.
          seen(await client.suspendChannel({ channel }));
          return blocked("channel_busy");
        }
        return { state: "applied" };
      }
      if (!known) {
        seen(await client.createChannel({ channel,
          ...(typeof desire.displayName === "string" ? { displayName: desire.displayName } : {}),
          ...(typeof desire.policy === "string" ? { policy: desire.policy } : {}) }));
      } else if (desire.displayName !== undefined || desire.policy !== undefined) {
        // The edit replaces the name, so a change that omits it restates the current one.
        seen(await client.editChannel({ channel,
          displayName: desire.displayName === undefined ? known.displayName ?? null : desire.displayName,
          ...(desire.policy === undefined ? {} : { policy: desire.policy }) }));
      }
      if (desire.lifecycle === "suspended") seen(await client.suspendChannel({ channel }));
      if (desire.lifecycle === "open") {
        try { seen(await client.resumeChannel({ channel })); }
        catch (error) {
          if (codeOf(error) !== "incompatible") throw error;
          return blocked("incompatible");
        }
      }
      return { state: "applied" };
    } catch (error) {
      if (codeOf(error) === "channel_retired") return blocked("channel_retired");
      // Unknown outcome or no connection: the change stays pending and goes with the next open.
      if (ambiguous(error) || error instanceof HarnessUnavailableError) return { state: "pending" };
      throw error;
    }
  }

  /** The session's status as the running harness reports it now. */
  status(): Promise<StatusResult> { return this.#client().status(); }

  /** Interrupts exactly this turn. False when it had already ended or was checkpointed. */
  async interrupt(channel: string, turn: string, reason?: string): Promise<boolean> {
    const result = await this.#client().interruptTurn({ channel, turn, ...(reason === undefined ? {} : { reason }) });
    return result.interrupted;
  }

  /** Answers one approval request. False when the answer was late: the request is closed and stays closed. */
  async respondApproval(requestId: string, decision: "allow_once" | "deny"): Promise<boolean> {
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
