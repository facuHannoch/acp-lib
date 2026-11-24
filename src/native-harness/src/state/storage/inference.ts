import type { ContextLimits, ContextTurnOutcome, InferenceRead, InferenceStorageReads } from "../../contracts/context.ts";
import type { TimelineEntry } from "../../contracts/storage.ts";

/** Charge the serialized message, the UTF-8 bytes of variable entry fields,
 * and a fixed allowance for scalar fields and record framing. */
export const entryOverhead = 128;
export const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

export interface ContextRow {
  seq: number;
  bytes: number;
  textBytes?: number;
  kind: "input" | "assistant" | "other";
}

export interface ContextRows {
  contextTurnStart(channelId: string, turnId: number): number | undefined;
  contextTrigger(turnId: number): ContextRow | undefined;
  contextPreviousResponse(turnId: number): number;
  contextInputs(turnId: number, after: number, limit: number): ContextRow[];
  /** Active-turn mixed inputs remain required through tool calls and resume. */
  contextAttachmentInputs(turnId: number, limit: number): ContextRow[];
  contextActive(turnId: number, limit: number): ContextRow[];
  contextLocal(channelId: string, before: number, limit: number): ContextRow[];
  contextRecent(before: number, limit: number, legacy?: boolean): ContextRow[];
  contextShared(channelId: string, candidates: number): ContextRow[];
  contextPolicies(turnId: number, limit: number, bytes: number): { names: string[]; bytes: number } | undefined;
  contextUnfinished(turnId: number, maxBytes: number): { outcome: ContextTurnOutcome; bytes: number } | undefined;
  contextEntry(seq: number): TimelineEntry;
  contextHistoricalEntry(seq: number): TimelineEntry;
}

export function validReadLimits(limits: ContextLimits): boolean {
  return [limits.maxReadRecords, limits.maxReadBytes, limits.maxSharedCandidates, limits.maxInputBytes, limits.maxTakenTextBytes, limits.maxTakenItems]
    .every(n => Number.isSafeInteger(n) && n > 0 && n < Number.MAX_SAFE_INTEGER);
}

/** Every adapter supplies headers first. Only rows charged to the same budget
 * can cross the body-read boundary, including rows discarded after validation. */
export function readInference(rows: ContextRows, input: Parameters<InferenceStorageReads["readInferenceContext"]>[0],
  turnStart: number): InferenceRead | { code: "context_limit" } {
  const { channelId, turnId, limits } = input;
  const { maxReadRecords, maxReadBytes, maxSharedCandidates } = limits;
  const overflow = { code: "context_limit" } as const;
  const trigger = rows.contextTrigger(turnId);
  const taken = rows.contextInputs(turnId, rows.contextPreviousResponse(turnId), maxReadRecords + 1);
  if (taken.length > limits.maxTakenItems ||
      taken.reduce((total, row) => total + (row.textBytes ?? 0), 0) > limits.maxTakenTextBytes ||
      (trigger?.textBytes ?? 0) > limits.maxInputBytes || taken.some(row => (row.textBytes ?? 0) > limits.maxInputBytes)) return overflow;
  const attachmentInputs = rows.contextAttachmentInputs(turnId, maxReadRecords + 1);
  if (attachmentInputs.length > maxReadRecords) return overflow;
  const requiredRows = [...new Map([...(trigger ? [trigger] : []), ...taken, ...attachmentInputs].map(row => [row.seq, row])).values()]
    .sort((a, b) => a.seq - b.seq);
  const requiredBytes = requiredRows.reduce((total, row) => total + row.bytes, 0);
  if (requiredRows.length > maxReadRecords || requiredBytes > maxReadBytes) return overflow;
  const policies = rows.contextPolicies(turnId, maxReadRecords, maxReadBytes - requiredBytes);
  if (!policies) return overflow;

  let records = maxReadRecords - requiredRows.length;
  let bytes = maxReadBytes - requiredBytes - policies.bytes;
  function charge(group: readonly ContextRow[], reserveRecords = 0, reserveBytes = 0) {
    const cost = group.reduce((total, row) => total + row.bytes, 0);
    if (group.length > records - reserveRecords || cost > bytes - reserveBytes) return false;
    records -= group.length;
    bytes -= cost;
    return true;
  }
  const required = requiredRows.map(row => rows.contextEntry(row.seq));
  const bySeq = new Map(required.map(entry => [entry.seq, entry]));
  const takenItemIds = taken.map(row => bySeq.get(row.seq)!.itemId!);
  const requiredSeqs = new Set(requiredRows.map(row => row.seq));

  // The newest bounded suffix can start with orphaned tool results. Start a
  // group only at an assistant row and verify its entire result set after load.
  const groups: ContextRow[][] = [];
  let exchange: ContextRow[] | undefined;
  if (records && bytes) for (const row of rows.contextActive(turnId, maxReadRecords).reverse()) {
    if (row.kind === "assistant") { exchange = [row]; groups.push(exchange); }
    else if (row.kind === "other") exchange?.push(row);
    else if (!requiredSeqs.has(row.seq)) groups.push([row]);
  }
  const optionalTurn: TimelineEntry[] = [];
  for (const group of groups.reverse()) {
    if (!charge(group)) continue;
    const entries = group.map(row => rows.contextEntry(row.seq));
    const first = entries[0]!.message;
    if (first.role === "assistant") {
      const results = new Set(entries.slice(1).flatMap(({ message }) => message.role === "tool" ? [message.callId] : []));
      if (results.size !== entries.length - 1 || results.size !== first.calls.length || first.calls.some(call => !results.has(call.id))) continue;
    }
    optionalTurn.push(...entries);
  }

  const localHistory: TimelineEntry[] = [], sharedHistory: TimelineEntry[] = [];
  if (records && bytes) {
    const local = rows.contextLocal(channelId, turnStart, maxReadRecords);
    const shared = rows.contextShared(channelId, maxSharedCandidates).slice(0, maxReadRecords);
    // Reserve room for a recent shared exchange even when a long local
    // transcript can fill every record slot. Return unused space to local.
    let reserveRecords = 0, reserveBytes = 0;
    const sharedSlots = records > 1 ? Math.max(1, Math.floor(records / 3)) : 0;
    for (const row of shared) {
      if (reserveRecords === sharedSlots) break;
      if (reserveBytes + row.bytes > Math.floor(bytes / 3)) continue;
      reserveRecords++;
      reserveBytes += row.bytes;
    }
    const deferred: ContextRow[] = [];
    for (const row of local) {
      if (charge([row], reserveRecords, reserveBytes))
        localHistory.push(rows.contextHistoricalEntry(row.seq));
      else deferred.push(row);
    }
    for (const row of shared) if (charge([row])) sharedHistory.push(rows.contextHistoricalEntry(row.seq));
    for (const row of deferred) if (charge([row])) localHistory.push(rows.contextHistoricalEntry(row.seq));
  }
  const unfinished: ContextTurnOutcome[] = [];
  const historicalTurns = new Set([...localHistory, ...sharedHistory].sort((a, b) => b.seq - a.seq).map(row => row.turnId));
  for (const id of historicalTurns) {
    if (!records || !bytes) break;
    const record = rows.contextUnfinished(id, bytes);
    if (!record) continue;
    bytes -= record.bytes;
    records--;
    unfinished.push(record.outcome);
  }
  const order = (a: TimelineEntry, b: TimelineEntry) => a.seq - b.seq;
  return { required, optionalTurn: optionalTurn.sort(order), localHistory: localHistory.sort(order),
    sharedHistory: sharedHistory.sort(order), unfinished, takenItemIds, policyNames: policies.names };
}
