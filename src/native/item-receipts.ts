import type { ItemsReceipt } from "../conversation-controller/contracts.ts";

type Milestone = ItemsReceipt["milestone"];

/** State stays monotonic when events contain repeated IDs or replay older milestones. */
export function advanceItemReceipts(receipts: Map<string, Milestone>, ids: readonly string[], milestone: Milestone): string[] {
  const advanced: string[] = [];
  for (const id of ids) {
    const previous = receipts.get(id);
    if (previous === milestone || previous === "seen") continue;
    receipts.set(id, milestone);
    advanced.push(id);
  }
  return advanced;
}
