import { NATIVE_ADAPTER_COMMAND, isNativeAdapter, type Adapter, type AgentAdapter, type NativeAdapter } from "./adapters.ts";

export interface AgentAdapterRegistration {
  readonly id: string;
  readonly adapter: AgentAdapter;
}

/** Mutable agent-scoped adapter directory. IDs are routing names, not trust assertions. */
export class AgentAdapterRegistry {
  private readonly values = new Map<string, Adapter>();
  /**
   * Native adapters, by id. Each also has an `Adapter`-shaped entry in `values` (a placeholder command
   * that is never spawned), so everything that lists or resolves adapters keeps one shape.
   */
  private readonly natives = new Map<string, NativeAdapter>();

  constructor(registrations: readonly AgentAdapterRegistration[] = []) {
    for (const registration of registrations) this.register(registration.id, registration.adapter);
  }

  register(id: string, adapter: AgentAdapter): void {
    const normalized = normalizeAdapterId(id);
    if (this.values.has(normalized)) throw new Error(`adapter is already registered: ${normalized}`);
    this.store(normalized, adapter);
  }

  replace(id: string, adapter: AgentAdapter): void {
    this.store(normalizeAdapterId(id), adapter);
  }

  remove(id: string): boolean {
    this.natives.delete(normalizeAdapterId(id));
    return this.values.delete(normalizeAdapterId(id));
  }

  /** The native adapter registered under `id`, or null when the id names an external harness (or nothing). */
  native(id: string): NativeAdapter | null {
    return this.natives.get(normalizeAdapterId(id)) ?? null;
  }

  private store(id: string, adapter: AgentAdapter): void {
    if (!isNativeAdapter(adapter)) {
      this.natives.delete(id);
      this.values.set(id, ownAdapter(adapter));
      return;
    }
    if (adapter.defaultPolicy !== undefined && !adapter.defaultPolicy.trim()) throw new Error("defaultPolicy cannot be blank");
    this.natives.set(id, Object.freeze({
      kind: "native" as const,
      ...(adapter.defaultPolicy ? { defaultPolicy: adapter.defaultPolicy } : {}),
      ...(adapter.displayName ? { displayName: adapter.displayName } : {}),
    }));
    this.values.set(id, ownAdapter({ command: [...NATIVE_ADAPTER_COMMAND], ...(adapter.displayName ? { displayName: adapter.displayName } : {}) }));
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

  list(): readonly (AgentAdapterRegistration & { readonly adapter: Adapter })[] {
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
