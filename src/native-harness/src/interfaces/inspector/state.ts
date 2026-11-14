import type { Message } from "../../../contracts/loop.ts";

export interface InspectedChannel {
  id: string;
  pending: number;
  running: boolean;
  error?: string;
  participants: string[];
  messages: Message[];
  requests: { number: number; at: string; body: unknown }[];
}

/** Separate, in-memory observation state. Never feeds model context. */
export function createInspection(systemPrompt: string) {
  const channels = new Map<string, InspectedChannel>();
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
    snapshot: () => structuredClone([...channels.values()]),
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
      channel(id).messages = structuredClone([...messages]); publish();
    },
    request(id: string, body: string) {
      const value = channel(id);
      value.requests.push({ number: value.requests.length + 1, at: new Date().toISOString(), body: JSON.parse(body) });
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
