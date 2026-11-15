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
}

interface Entry {
  readonly script: FakeScript;
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
  sendScript: (run: TurnRun) => FakeScript = (run) => ({ chunks: [`echo ${run.turnId}`] });
  forceStopped = 0;

  #connected = true;
  #sequence = 0;
  readonly #entries = new Map<string, Entry>();
  readonly #turnListeners = new Set<(event: TurnEvent) => void>();
  readonly #outputListeners = new Set<OutputListener>();
  readonly #connectionListeners = new Set<() => void>();
  readonly #usageListeners = new Set<UsageListener>();
  readonly #open = new Set<(error: Error) => void>();

  constructor(options: { scheduling?: "session" | "backend" } = {}) {
    this.scheduling = options.scheduling ?? "session";
  }

  // --- test control ------------------------------------------------------------------------

  /** The backend starts a turn on its own: reported at once, its output held until `prompt()`. */
  startTurn(script: FakeScript, cause: TurnCause = { kind: "items", items: [] }, turnId = `fake-${++this.#sequence}`): string {
    this.#entries.set(turnId, { script, prepared: false, prompted: false, abandoned: false });
    this.#report({ kind: "turn_started", turnId, cause, sentBySession: false });
    return turnId;
  }

  /** Turns reported and neither prepared nor abandoned: their output is still held. */
  get held(): string[] {
    return [...this.#entries].filter(([, entry]) => !entry.prepared && !entry.abandoned).map(([turnId]) => turnId);
  }

  // --- turns -------------------------------------------------------------------------------

  send(run: TurnRun): Promise<void> {
    this.sent.push(run);
    if (this.scheduling === "session") {
      if (!run.turnId) return Promise.reject(new Error("a run without a turn id"));
      this.#entries.set(run.turnId, { script: this.sendScript(run), prepared: false, prompted: false, abandoned: false });
      this.#report({ kind: "turn_started", turnId: run.turnId, cause: { kind: "messages", messageIds: run.messageIds }, sentBySession: true });
      return Promise.resolve();
    }
    return Promise.resolve(); // backend-scheduled: accepted; the backend starts turns as it decides
  }

  subscribeTurns(listener: (event: TurnEvent) => void): () => void {
    this.#turnListeners.add(listener);
    return () => this.#turnListeners.delete(listener);
  }

  prepareTurn(turnId: string, content: TurnContent): PreparedTurn {
    const entry = this.#entries.get(turnId);
    if (!entry || entry.abandoned) throw new Error(`unknown turn ${turnId}`);
    entry.prepared = true;
    const listeners = new Set<OutputListener>();
    const signal = (output: ProviderOutput) => { for (const listener of [...listeners]) listener(output); };
    let cancelled = false;
    const prepared: PreparedTurn = {
      turnId,
      live: true,
      subscribeOutput: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      cancel: () => { cancelled = true; },
      forceStop: () => this.forceStop(),
      prompt: async () => {
        entry.prompted = true;
        this.prompted.push(turnId);
        let forced!: (error: Error) => void;
        const forcedStop = new Promise<never>((_, reject) => { forced = reject; });
        forcedStop.catch(() => undefined);
        this.#open.add(forced);
        const run = async (): Promise<PromptResult> => {
          if (entry.script.hold) await entry.script.hold;
          if (entry.script.fail) throw entry.script.fail;
          const chunks = entry.script.chunks ?? [];
          signal({ kind: "update", sessionId: this.currentSessionId });
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

  async forceStop(): Promise<void> {
    this.forceStopped += 1;
    for (const reject of [...this.#open]) reject(new Error("forced stop"));
    this.#open.clear();
    this.#connected = false;
    for (const listener of [...this.#connectionListeners]) listener();
  }

  // --- lifecycle ---------------------------------------------------------------------------

  async start(onProgress?: (event: never) => void): Promise<StartResult> {
    void onProgress;
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

  readonly configOptions = new Map() as ConversationController["configOptions"];
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
