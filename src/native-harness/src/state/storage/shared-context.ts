import type { ContextEntry, SharedContextStore } from "../../contracts/context.ts";

export function createSharedContextStore(): SharedContextStore {
  const entries: ContextEntry[] = [];
  const listeners = new Set<() => void>();
  return {
    append(entry) {
      // Capture values now: later mutation of provider responses or inspection
      // snapshots must never rewrite the agent's recorded experience.
      entries.push({ ...structuredClone(entry), seq: entries.length + 1, at: new Date().toISOString() });
      for (const listener of listeners) listener();
    },
    snapshot: () => structuredClone(entries),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
