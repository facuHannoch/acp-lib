import type { Adapter } from "./adapters.ts";

export interface AgentAdapterRegistration {
  readonly id: string;
  readonly adapter: Adapter;
}

/** Mutable agent-scoped adapter directory. IDs are routing names, not trust assertions. */
export class AgentAdapterRegistry {
  private readonly values = new Map<string, Adapter>();

  constructor(registrations: readonly AgentAdapterRegistration[] = []) {
    for (const registration of registrations) this.register(registration.id, registration.adapter);
  }

  register(id: string, adapter: Adapter): void {
    const normalized = normalizeAdapterId(id);
    if (this.values.has(normalized)) throw new Error(`adapter is already registered: ${normalized}`);
    this.values.set(normalized, ownAdapter(adapter));
  }

  replace(id: string, adapter: Adapter): void {
    this.values.set(normalizeAdapterId(id), ownAdapter(adapter));
  }

  remove(id: string): boolean {
    return this.values.delete(normalizeAdapterId(id));
  }

  get(id: string): Adapter | null {
    const adapter = this.values.get(normalizeAdapterId(id));
    return adapter ? ownAdapter(adapter) : null;
  }

  require(id: string): Adapter {
    const adapter = this.get(id);
    if (!adapter) throw new Error(`unknown agent adapter: ${id}`);
    return adapter;
  }

  list(): readonly AgentAdapterRegistration[] {
    return Object.freeze([...this.values].map(([id, adapter]) => Object.freeze({
      id,
      adapter: ownAdapter(adapter),
    })));
  }
}

function normalizeAdapterId(id: string): string {
  const normalized = id.trim();
  if (!normalized) throw new Error("adapter id cannot be blank");
  return normalized;
}

function ownAdapter(adapter: Adapter): Adapter {
  if (!adapter.command.length || adapter.command.some((part) => !part)) {
    throw new Error("adapter command must contain non-empty arguments");
  }
  if (adapter.cancelGraceMs !== undefined && (!Number.isFinite(adapter.cancelGraceMs) || adapter.cancelGraceMs <= 0)) throw new Error("cancelGraceMs must be positive and finite");
  return Object.freeze({
    ...(adapter.cancelGraceMs === undefined ? {} : { cancelGraceMs: adapter.cancelGraceMs }),
    command: Object.freeze([...adapter.command]) as unknown as string[],
    ...(adapter.ptyCommand
      ? { ptyCommand: Object.freeze([...adapter.ptyCommand]) as unknown as string[] }
      : {}),
    ...(adapter.displayName ? { displayName: adapter.displayName } : {}),
  });
}
