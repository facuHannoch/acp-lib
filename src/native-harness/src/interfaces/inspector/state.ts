import type { Message, ToolDefinition } from "../../contracts/loop.ts";
import type { ContextEntry } from "../../contracts/context.ts";
import type { SessionStatus } from "../../contracts/session.ts";

/** What the session's storage says right now; not a record of past activity. */
export interface InspectedSession {
  storage: string;
  sessionId: string;
  lifecycle: SessionStatus["lifecycle"];
  execution: SessionStatus["execution"];
  revision: number;
}

export interface InspectedInference {
  number: number;
  turnId?: number;
  at: string;
  body: unknown;
  response?: Extract<Message, { role: "assistant" }>;
}

export interface InspectedChannel {
  id: string;
  pending: number;
  running: boolean;
  error?: string;
  /** `suspended`: a checkpointed turn waits for resume. */
  turn?: "running" | "suspended";
  /** IDs of accepted inputs no turn has taken yet. */
  pendingItems?: string[];
  /** The channel's latest turn ended failed or interrupted and nothing has run since. */
  unresolved?: { turnId: number; status: "failed" | "interrupted"; reason: string; uncertainCallIds: string[] };
  participants: string[];
  messages: Message[];
  requests: InspectedInference[];
}

/** Separate, in-memory observation state. Never feeds model context. */
export function createInspection(systemPrompt: string, tools: readonly ToolDefinition[] = []) {
  const channels = new Map<string, InspectedChannel>();
  let entries: ContextEntry[] = [];
  let base: Message[] = [{ role: "system", content: systemPrompt }];
  let latestRequest: { channelId: string; number: number; at: string; body: unknown } | null = null;
  let session: InspectedSession | null = null;
  const listeners = new Set<() => void>();
  function channel(id: string) {
    let value = channels.get(id);
    if (!value) {
      value = { id, pending: 0, running: false, participants: [],
        messages: [{ role: "system", content: systemPrompt }], requests: [] };
      channels.set(id, value);
    }
    return value;
  }
  function publish() { for (const listener of listeners) listener(); }
  return {
    snapshot: () => structuredClone({
      liveContext: { systemPrompt, tools, entries, base, request: latestRequest },
      channels: [...channels.values()],
      ...(session ? { session } : {}),
    }),
    /** Replace activity fields with the storage's own account, so a reopened
     * session shows its lifecycle, pending input and unfinished turns at once. */
    status(status: SessionStatus, storage: string, participants: Record<string, string[]> = {}) {
      session = { storage, sessionId: status.sessionId, lifecycle: status.lifecycle, execution: status.execution, revision: status.revision };
      for (const state of status.channels) {
        const value = channel(state.channelId);
        value.turn = state.activeTurn?.status;
        value.running = state.activeTurn?.status === "running";
        value.pendingItems = [...state.pendingItemIds];
        value.pending = state.pendingItemIds.length;
        value.unresolved = state.unresolvedInterruption ? structuredClone(state.unresolvedInterruption) : undefined;
        value.error = state.unresolvedInterruption ? `Turn ${state.unresolvedInterruption.turnId} ${state.unresolvedInterruption.status}: ${state.unresolvedInterruption.reason}` : undefined;
        value.participants = [...participants[state.channelId] ?? value.participants];
      }
      publish();
    },
    sharedContext(snapshot: readonly ContextEntry[], renderedBase?: readonly Message[]) {
      entries = structuredClone([...snapshot]);
      if (renderedBase) base = structuredClone([...renderedBase]);
      // Publish the global view and channel projections together so the browser
      // never sees a new shared entry paired with an older channel history.
      for (const id of new Set(entries.map((entry) => entry.channelId))) {
        channel(id).messages = [{ role: "system", content: systemPrompt },
          ...entries.filter((entry) => entry.channelId === id).map((entry) => entry.message)];
      }
      publish();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    accepted(id: string, participant: string) {
      const value = channel(id);
      value.pending++;
      if (!value.participants.includes(participant)) value.participants.push(participant);
      publish();
    },
    running(id: string, running: boolean) { channel(id).running = running; publish(); },
    history(id: string, messages: readonly Message[]) {
      // A shallow array copy would still share message objects with the agent.
      // Deep-copy at capture time so subsequent mutations cannot rewrite a view.
      channel(id).messages = structuredClone([...messages]); publish();
    },
    request(id: string, body: string, turnId?: number) {
      const value = channel(id);
      const request = { number: value.requests.length + 1, turnId, at: new Date().toISOString(), body: JSON.parse(body) };
      value.requests.push(request);
      // Select by actual call order across channels, not by channel creation or
      // response completion. Later store updates must not rewrite this snapshot.
      latestRequest = { channelId: id, ...request };
      publish();
    },
    response(id: string, message: Extract<Message, { role: "assistant" }>) {
      // A channel executes one inference at a time, so its latest request owns
      // this response even while other channels finish in a different order.
      const request = channel(id).requests.at(-1);
      if (request) request.response = structuredClone(message);
      publish();
    },
    finished(id: string, error?: string) {
      const value = channel(id);
      value.pending--;
      if (error) value.error = error;
      publish();
    },
  };
}

export type Inspection = ReturnType<typeof createInspection>;
