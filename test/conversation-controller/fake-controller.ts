/**
 * A core-only fake `ConversationController` (controller-interface spec, Brief B2 step 6): no optional
 * member at all. It can run either kind of backend: **session-scheduled** (like the `HarnessController`:
 * `send` reports `turn_started` for the run synchronously) or **backend-scheduled** (like the native
 * controller: `send` only accepts; the test starts turns with `startTurn`, as the backend would).
 * A prepared turn replays its scripted output to the session's handlers only once its `prompt()` is
 * called, and settles at its end; a turn started on its own holds its output until then.
 */
import type {
  ConversationCapabilities,
  ConversationController,
  PreparedTurn,
  StartResult,
  TurnCause,
  TurnContent,
  TurnEvent,
  TurnRun,
  UsageListener,
} from "../../src/conversation-controller/index.ts";
import type { OutputListener, ProviderOutput } from "../../src/operations/contracts.ts";
import type { PromptResult } from "../../src/types.ts";

export interface FakeScript {
  /** Assistant message chunks streamed to the handlers when `prompt()` is called; each string is one chunk of one message. */
  readonly chunks?: readonly string[];
  /** The result text; defaults to the chunks joined. */
  readonly text?: string;
  readonly status?: PromptResult["status"];
  /** `prompt()` waits for this before replaying (keeps the turn running). */
  readonly hold?: Promise<void>;
  /** `prompt()` rejects with it instead of replaying. */
  readonly fail?: Error;
  /** Provider signals emitted to this turn's supervisor the instant `prompt()` is called, before anything else. */
  readonly signals?: readonly ProviderOutput[];
  /** The backend already finished this turn: its prepared turn replays held output and is not `live`. */
  readonly ended?: boolean;
  /** With `ended`: the turn becomes `live` when this settles (the replay is over, but the turn still runs). */
  readonly goLive?: Promise<void>;
}

interface Entry {
  readonly script: FakeScript;
  handlers?: TurnContent["handlers"];
  prepared: boolean;
  prompted: boolean;
  abandoned: boolean;
}

export class FakeController implements ConversationController {
  readonly scheduling: "session" | "backend";
  /** What the session handed over with `send`, in order. */
  readonly sent: TurnRun[] = [];
  /** The turns the controller abandoned, with the reason. */
  readonly abandoned: Array<{ turnId: string; reason: unknown }> = [];
  /** Turns whose `prompt()` was called, in order. */
  readonly prompted: string[] = [];
  /** The script a session-scheduled `send` uses for each run (default: a one-chunk echo). */
  sendScript: (run: TurnRun) => FakeScript = (run) => this.#scripts.shift() ?? { chunks: [`echo ${run.turnId}`] };
  readonly #scripts: FakeScript[] = [];
  /** The next session-scheduled `send` that has no other script uses this one (in call order). */
  queueScript(script: FakeScript): void { this.#scripts.push(script); }
  forceStopped = 0;
  /** `send` resolves only when this does (backend-scheduled: the backend has not accepted the message yet). */
  acceptGate: Promise<void> | null = null;
  /** The next `send` rejects with this (the backend refused the message). */
  rejectNextSend: Error | null = null;

  #connected = true;
  #sequence = 0;
  readonly #entries = new Map<string, Entry>();
  readonly #turnListeners = new Set<(event: TurnEvent) => void>();
  readonly #outputListeners = new Set<OutputListener>();
  readonly #connectionListeners = new Set<() => void>();
  readonly #usageListeners = new Set<UsageListener>();
  readonly #open = new Set<(error: Error) => void>();

  constructor(options: { scheduling?: "session" | "backend"; configOptions?: ConversationController["configOptions"] } = {}) {
    this.scheduling = options.scheduling ?? "session";
    this.configOptions = options.configOptions ?? (new Map() as ConversationController["configOptions"]);
  }

  // --- test control ------------------------------------------------------------------------

  /** The backend starts a turn on its own: reported at once, its output held until `prompt()`. */
  startTurn(script: FakeScript, cause: TurnCause = { kind: "items", items: [] }, turnId = `fake-${++this.#sequence}`): string {
    this.#entries.set(turnId, { script, prepared: false, prompted: false, abandoned: false });
    this.#report({ kind: "turn_started", turnId, cause, sentBySession: false });
    return turnId;
  }

  /** The backend folds more into a turn already running (native steering): `turn_took`. */
  foldInto(turnId: string, cause: TurnCause): void {
    this.#report({ kind: "turn_took", turnId, cause });
  }

  /** Output arriving for a turn after the fact (late output after a forced stop): delivered to the handlers it was prepared with. */
  deliverLate(turnId: string, text: string): void {
    const handlers = this.#entries.get(turnId)?.handlers;
    handlers?.onChunk?.(text);
    handlers?.onResponseChunk?.({ text, startsMessage: false });
  }

  /** Turns reported and neither prepared nor abandoned: their output is still held. */
  get held(): string[] {
    return [...this.#entries].filter(([, entry]) => !entry.prepared && !entry.abandoned).map(([turnId]) => turnId);
  }

  // --- turns -------------------------------------------------------------------------------

  async send(run: TurnRun): Promise<void> {
    this.sent.push(run);
    if (this.rejectNextSend) {
      const error = this.rejectNextSend;
      this.rejectNextSend = null;
      throw error;
    }
    if (this.acceptGate) await this.acceptGate;
    if (this.scheduling === "session") {
      if (!run.turnId) throw new Error("a run without a turn id");
      this.#entries.set(run.turnId, { script: this.sendScript(run), prepared: false, prompted: false, abandoned: false });
      this.#report({ kind: "turn_started", turnId: run.turnId, cause: { kind: "messages", messageIds: run.messageIds }, sentBySession: true });
      return;
    }
    // backend-scheduled: accepted; the backend starts turns as it decides
  }

  subscribeTurns(listener: (event: TurnEvent) => void): () => void {
    this.#turnListeners.add(listener);
    return () => this.#turnListeners.delete(listener);
  }

  prepareTurn(turnId: string, content: TurnContent): PreparedTurn {
    const entry = this.#entries.get(turnId);
    if (!entry || entry.abandoned) throw new Error(`unknown turn ${turnId}`);
    entry.prepared = true;
    entry.handlers = content.handlers;
    const listeners = new Set<OutputListener>();
    const signal = (output: ProviderOutput) => { for (const listener of [...listeners]) listener(output); };
    let cancelled = false;
    let replaying = entry.script.ended === true;
    void entry.script.goLive?.then(() => { replaying = false; });
    let onCancel!: () => void;
    const cancelSignal = new Promise<void>((resolve) => { onCancel = resolve; });
    const prepared: PreparedTurn = {
      turnId,
      get live() { return !replaying; },
      subscribeOutput: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      cancel: () => { cancelled = true; onCancel(); },
      forceStop: () => this.forceStop(),
      prompt: async () => {
        entry.prompted = true;
        this.prompted.push(turnId);
        let forced!: (error: Error) => void;
        const forcedStop = new Promise<never>((_, reject) => { forced = reject; });
        forcedStop.catch(() => undefined);
        this.#open.add(forced);
        const run = async (): Promise<PromptResult> => {
          for (const output of entry.script.signals ?? []) signal(output);
          if (entry.script.hold) await Promise.race([entry.script.hold, cancelSignal]); // a cancel ends a held turn
          if (entry.script.fail) throw entry.script.fail;
          const chunks = entry.script.chunks ?? [];
          if (!entry.script.signals) signal({ kind: "update", sessionId: this.currentSessionId });
          chunks.forEach((text, index) => {
            content.handlers.onChunk?.(text);
            content.handlers.onResponseChunk?.({ text, startsMessage: index === 0 });
          });
          const text = entry.script.text ?? chunks.join("");
          const status = cancelled ? "cancelled" : entry.script.status ?? "completed";
          return {
            text,
            messages: text ? [{ text }] : [],
            stopReason: status === "completed" ? "end_turn" : status === "cancelled" ? "cancelled" : "error",
            status,
            usage: null,
          };
        };
        try {
          return await Promise.race([run(), forcedStop]);
        } finally {
          this.#open.delete(forced);
        }
      },
    };
    return prepared;
  }

  abandonTurn(turnId: string, reason: unknown): void {
    const entry = this.#entries.get(turnId);
    if (!entry || entry.abandoned || entry.prompted) return; // idempotent; a turn already executed is not abandoned
    entry.abandoned = true;
    this.abandoned.push({ turnId, reason });
  }

  subscribeOutput(listener: OutputListener): () => void {
    this.#outputListeners.add(listener);
    return () => this.#outputListeners.delete(listener);
  }

  cancel(): void { /* each prepared turn's own cancel is what the supervisor uses */ }

  /** Stops the backend: every open prepared turn rejects. The fake backend restarts at once (it stays connected). */
  async forceStop(): Promise<void> {
    this.forceStopped += 1;
    for (const reject of [...this.#open]) reject(new Error("forced stop"));
    this.#open.clear();
  }

  /** The backend becomes unreachable: the next start fails with `error` (a turn that never reaches the provider). */
  breakBackend(error: Error): void {
    this.#connected = false;
    this.#startError = error;
    for (const listener of [...this.#connectionListeners]) listener();
  }
  #startError: Error | null = null;

  // --- lifecycle ---------------------------------------------------------------------------

  async start(onProgress?: (event: never) => void): Promise<StartResult> {
    void onProgress;
    if (this.#startError) throw this.#startError;
    this.#connected = true;
    for (const listener of [...this.#connectionListeners]) listener();
    return { sessionId: "fake-session", resumed: false };
  }
  startFresh(onProgress?: (event: never) => void): Promise<StartResult> { return this.start(onProgress); }
  async stop(): Promise<void> {
    this.#connected = false;
    for (const listener of [...this.#connectionListeners]) listener();
  }
  get isConnected(): boolean { return this.#connected; }
  subscribeConnection(listener: () => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }
  readonly cancelGraceMs = undefined;

  // --- settings and usage ------------------------------------------------------------------

  /** Known before `start` (a native controller has its options at once). */
  readonly configOptions: ConversationController["configOptions"];
  async setConfig(): Promise<void> { /* no options */ }
  subscribeUsageUpdate(listener: UsageListener): () => void {
    this.#usageListeners.add(listener);
    return () => this.#usageListeners.delete(listener);
  }
  get currentSessionId(): string | null { return "fake-session"; }
  get conversationCapabilities(): ConversationCapabilities {
    return { nativeSteering: this.scheduling === "backend", backend: null };
  }

  #report(event: TurnEvent): void {
    for (const listener of [...this.#turnListeners]) listener(event);
  }
}
