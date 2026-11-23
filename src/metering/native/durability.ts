import type { AgentConversationId } from "../../agent-ids.ts";
import type { MeteringOperationIdentity, PersistenceBackend } from "../../persistence/backend.ts";
import type { MeteringEngine, OpenOperation } from "../engine.ts";
import type { OperationMeteringRecord } from "../record.ts";
import { emptyMeteringState, type AgentSessionMeteringState } from "../state.ts";

export interface NativeMeteringRecovery {
  restore(): Promise<AgentSessionMeteringState>;
  find(operationId: string): Promise<OperationMeteringRecord | MeteringOperationIdentity | null>;
}

/** Persist one write-ahead record in the existing metering state, then commit it normally. */
export class DurableNativeMetering implements NativeMeteringRecovery {
  constructor(
    private readonly persistence: PersistenceBackend,
    private readonly conversationId: AgentConversationId,
    private readonly agentId: string,
    private readonly commit: (record: OperationMeteringRecord) => Promise<void>,
  ) {}

  async restore(): Promise<AgentSessionMeteringState> {
    const before = await this.persistence.metering.state(this.conversationId);
    if (!before?.state.pendingNativeMetering) return before?.state ?? emptyMeteringState(this.agentId);
    const record = before.state.pendingNativeMetering;
    validatePendingNativeMetering(before.state, record);
    await this.commit(record);
    return (await this.persistence.metering.state(this.conversationId))!.state;
  }

  find(operationId: string): Promise<OperationMeteringRecord | MeteringOperationIdentity | null> {
    return this.#find(this.persistence.metering, operationId);
  }

  async record(record: OperationMeteringRecord): Promise<void> {
    const staged = await this.persistence.transaction(async ({ metering }) => {
      if (await this.#find(metering, record.operationId)) return null;
      const persisted = await metering.state(this.conversationId);
      const state = persisted?.state ?? emptyMeteringState(this.agentId);
      const pending = state.pendingNativeMetering;
      if (pending && pending.operationId !== record.operationId) {
        throw new Error("a different native metering operation is awaiting commit");
      }
      const candidate = pending ?? record;
      validatePendingNativeMetering(state, candidate);
      if (!pending) await metering.saveState(this.conversationId, { ...state, pendingNativeMetering: candidate });
      return candidate;
    });
    if (staged) await this.commit(staged);
  }

  async #find(metering: PersistenceBackend["metering"], operationId: string) {
    const record = await metering.get(this.conversationId, operationId);
    if (record) return record;
    return await metering.operationIdentity?.(this.conversationId, operationId) ?? null;
  }
}

/** Restore only committed accounting before touching the turn's ledger or accruing usage. */
export async function recoverNativeClose(
  recovery: NativeMeteringRecovery,
  engine: MeteringEngine,
  open: OpenOperation,
): Promise<OperationMeteringRecord | null> {
  const state = await recovery.restore();
  engine.adoptAccounting(state);
  const existing = await recovery.find(open.operationId);
  if (existing === null || "usage" in existing) return existing;
  return {
    operationId: open.operationId, operationKind: open.operationKind, outcome: existing.outcome,
    startedAt: existing.completedAt, completedAt: existing.completedAt, agentSessionId: state.agentSessionId,
    internalSessionId: open.internalSessionId, provider: { adapterId: existing.adapterId, providerId: null, model: null },
    nativeUsage: { channel: open.nativeChannel!, turnId: null, status: "unavailable", reason: "metering detail was pruned" },
    provenance: { source: "none", measurement: "unavailable", routing: "unknown", attribution: "unavailable" },
    usage: { status: "usage_unavailable", reason: "native metering was already committed and its detail was pruned" },
    pricingStatus: "not_attributable", contextAfter: null, providerCostAfter: null,
    costReconciliation: { status: "unavailable", reason: "metering record detail was pruned" }, nextState: state,
  };
}

function validatePendingNativeMetering(state: AgentSessionMeteringState, record: OperationMeteringRecord): void {
  if (!record.nativeUsage || record.agentSessionId !== state.agentSessionId ||
    record.nextState?.agentSessionId !== state.agentSessionId ||
    record.nextState.operationCount !== state.operationCount + 1 || record.nextState.pendingNativeMetering) {
    throw new Error("Invalid pending native metering operation");
  }
}
