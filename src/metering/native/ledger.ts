import { untilAborted } from "../../connection-attempt.ts";
import type { ModelCallSummary } from "../../native-harness/src/client.ts";

type LedgerPage = { readonly calls: readonly ModelCallSummary[]; readonly next?: string };
type ReadPage = (query: { readonly after?: string }, signal: AbortSignal) => Promise<LedgerPage>;

interface LedgerBounds {
  readonly timeoutMs: number;
  readonly maxPages: number;
}

export interface NativeLedgerPosition {
  /** An accounted prefix supplied by the caller. A scan never advances it by itself. */
  readonly after?: string;
  readonly signal?: AbortSignal;
}

interface NativeLedgerRead {
  readonly calls: readonly ModelCallSummary[];
  readonly lastSeenCallId?: string;
  /** Same-channel rows in ledger order, through the last call of the requested turn. */
  readonly prefix: readonly ModelCallSummary[];
}

const defaultBounds: LedgerBounds = { timeoutMs: 15_000, maxPages: 1_000 };

/** A shared, stateless reader. A stalled pull owns only its own deadline. */
export class NativeUsageLedger {
  constructor(
    private readonly openRead: () => ReadPage,
    private readonly bounds: LedgerBounds = defaultBounds,
  ) {}

  async readTurn(channel: string, turnId: string, position: NativeLedgerPosition = {}): Promise<NativeLedgerRead> {
    const timeout = AbortSignal.timeout(this.bounds.timeoutMs);
    const signal = position.signal ? AbortSignal.any([position.signal, timeout]) : timeout;
    let after = position.after;
    const seenIds = new Set(after === undefined ? [] : [after]);
    const calls: ModelCallSummary[] = [];
    const channelCalls: ModelCallSummary[] = [];

    try {
      const readPage = this.openRead();
      for (let count = 0; count < this.bounds.maxPages; count++) {
        signal.throwIfAborted();
        const page = await untilAborted(readPage(after === undefined ? {} : { after }, signal), signal);
        signal.throwIfAborted();
        const seenThrough = collectPage(page, channel, turnId, seenIds, calls, channelCalls);
        if (page.next === undefined) {
          return { calls, lastSeenCallId: seenThrough ?? after, prefix: turnPrefix(channelCalls, turnId) };
        }
        after = page.next;
      }
      throw new Error("Native usage ledger exceeded its page budget");
    } catch (error) {
      if (timeout.aborted) throw new Error("Native usage ledger read timed out", { cause: error });
      if (position.signal?.aborted) throw new Error("Native usage ledger read cancelled", { cause: error });
      throw error;
    }
  }
}

function turnPrefix(calls: readonly ModelCallSummary[], turnId: string): readonly ModelCallSummary[] {
  const lastOwn = calls.findLastIndex(call => call.turnId === turnId);
  if (lastOwn >= 0) return calls.slice(0, lastOwn + 1);
  // Harness v1 allocates positive decimal turn IDs. With no target row, stop at the first
  // same-channel row that cannot be proved to precede the target.
  if (!/^[1-9]\d*$/.test(turnId)) return [];
  const target = BigInt(turnId);
  const firstUnproven = calls.findIndex(call => !/^[1-9]\d*$/.test(call.turnId) || BigInt(call.turnId) >= target);
  return firstUnproven < 0 ? calls : calls.slice(0, firstUnproven);
}

function collectPage(
  page: LedgerPage,
  channel: string,
  turnId: string,
  seenIds: Set<string>,
  selected: ModelCallSummary[],
  channelCalls: ModelCallSummary[],
): string | undefined {
  if (!Array.isArray(page?.calls)) throw new Error("Invalid native usage ledger page");
  const seenThrough = page.calls.at(-1)?.callId;
  if (page.next !== undefined && (!seenThrough || page.next !== seenThrough)) {
    throw new Error("Native usage ledger cursor did not advance to the last call");
  }
  for (const call of page.calls) {
    if (typeof call?.callId !== "string" || !call.callId || seenIds.has(call.callId)) {
      throw new Error("Native usage ledger returned an invalid or repeated call ID");
    }
    if (typeof call.channel !== "string" || !call.channel || typeof call.turnId !== "string" || !call.turnId) {
      throw new Error("Native usage ledger returned a call without channel or turn ownership");
    }
    seenIds.add(call.callId);
    if (call.channel !== channel) continue;
    channelCalls.push(call);
    if (call.turnId === turnId) selected.push(call);
  }
  return seenThrough;
}
