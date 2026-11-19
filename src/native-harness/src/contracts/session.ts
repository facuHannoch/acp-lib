import type { Agent, TurnInput, TurnRunner, SessionAgent, ActiveTurn, TurnExecutor } from "./agent.ts";
import type { Model, ExecuteTool, ToolDefinition } from "./loop.ts";
import type { SharedContextStore } from "./context.ts";
import type { EventSink, SessionEventSink } from "./events.ts";
import type { SessionLifecycle, SessionStorage, StorageError, StorageSnapshot } from "./storage.ts";

export interface TurnServices { model: Model; tools: readonly ToolDefinition[]; executeTool: ExecuteTool }
/** Host composition controls implementations; the kernel sees only contracts. */
export interface SessionOptions {
  systemPrompt: string;
  store?: SharedContextStore;
  configureTurn(input: TurnInput, notify: Agent["notify"]): TurnServices;
  wrapTurn?: (run: TurnRunner) => TurnRunner;
}
export interface HarnessSession {
  agent: Agent;
  store: SharedContextStore;
  subscribe(listener: EventSink): () => void;
}

// ---- Storage-backed session, decision 0013. Replaces the types above when wired.

/** Derived from one storage snapshot. `idle`: lifecycle running, no running
 * turn and nothing pending. `unresolvedInterruption` marks a channel whose most
 * recent turn was interrupted (or failed) and has not been followed by another
 * turn; it reports, and never blocks, new work on that channel. */
export interface SessionStatus {
  sessionId: string;
  revision: number;
  lifecycle: SessionLifecycle;
  /** `stopped`: this process has closed admission and will start no more work. */
  execution: "idle" | "working" | "suspending" | "suspended" | "stopped";
  channels: {
    channelId: string;
    activeTurn?: { turnId: number; status: "running" | "suspended" };
    pendingItemIds: string[];
    unresolvedInterruption?: { turnId: number; status: "failed" | "interrupted"; reason: string; uncertainCallIds: string[] };
  }[];
}

/** `stopped`: stop ended the operation; nothing was suspended or resumed. */
export type LifecycleResult = { ok: true; status: SessionStatus }
  | { ok: false; error: StorageError | { code: "stopped"; message: string } };

export interface PersistentSessionOptions {
  systemPrompt: string;
  /** Opened and later closed by the caller. Recovery already ran in open. */
  storage: SessionStorage;
  configureTurn(turn: ActiveTurn, notify: SessionAgent["notify"]): TurnServices;
  wrapTurn?: (run: TurnExecutor) => TurnExecutor;
}

/** Creating the session executes nothing: it can be inspected, loaded and
 * exported first. Opening, starting and resuming are separate actions. */
export interface PersistentSession {
  agent: SessionAgent;
  /** Read-only timeline projection for the context builder and inspector. */
  store: Pick<SharedContextStore, "snapshot" | "subscribe">;
  snapshot(): StorageSnapshot;
  status(): SessionStatus;
  /** Make pending items eligible: begin turns for channels with pending input
   * when the lifecycle is running. Does not resume a suspended session. Callers
   * that owe a load response deliver it before calling start. Idempotent. */
  start(): void;
  /** Resolves when `suspended` is committed, after in-flight iterations settle.
   * Concurrent and repeated calls observe the same transition. If stop arrives
   * first, resolves `stopped` and `suspended` is never committed. */
  suspend(): Promise<LifecycleResult>;
  /** Explicit resume: continues checkpointed turns, then starts pending input. */
  resume(): LifecycleResult;
  /** Immediate: close admission in this process, abort inference and tools,
   * and commit storage `interruptActive`. While running that interrupts every
   * running turn; while suspending it also interrupts turns checkpointed in
   * this attempt and returns the lifecycle to running; a suspended session keeps
   * its checkpoints. Pending items stay pending. Does not wait for the
   * iteration and is not suspension. Late results are fenced by storage. */
  stop(reason: string): SessionStatus;
  subscribe(listener: EventSink): () => void;
  subscribeSession(listener: SessionEventSink): () => void;
}
