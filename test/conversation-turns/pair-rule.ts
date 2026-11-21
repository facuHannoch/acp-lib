/**
 * The one allowed snapshot exception (controller-interface spec, "Which orders are contractual" and
 * Risks; decided 2026-11-13, managed mode widened the same day;
 * findings/11-13-FINDING-metering-vs-presentation-order.md). Today's code writes these on separate
 * paths with no fixed order, so the characterization tests accept the observed alternatives and
 * nothing else:
 *
 * - **managed:** a turn's metering event anywhere among that turn's *response* presentation events
 *   (its presentations other than its user messages, which are written before dispatch). The
 *   canonical form moves the metering event before the contiguous same-turn response presentations
 *   directly ahead of it. It never crosses another kind of event or another turn's events, and the
 *   presentations keep their own order.
 * - **Agent-owned:** a turn's metering record vs that turn's *last in-progress assistant snapshot*
 *   record, either order. Decided on the raw records (kind, turn, role, status, record id). When
 *   the two are adjacent with the snapshot first, they are put metering first; the pair keeps its
 *   own two sequence numbers, ascending. The committed-record bus must list exactly the records'
 *   ids in the records' order (checked first, so no disagreement is hidden); the same pair, by
 *   record id, is swapped on it.
 *
 * Everything else stays as captured. Callers check the raw run's sequence numbers before this.
 */

type Item = Record<string, any>;

/** The turn a presentation item belongs to: `message:<turn>:…` or `<item kind>:<turn>:…`. */
export const presentationTurn = (event: Item) => String(event.id ?? "").split(":")[1];

/** A presentation event of `turn` other than one of its user messages. */
const isResponsePresentation = (event: Item, turn: unknown) =>
  event.kind === "presentation_recorded" && presentationTurn(event) === turn && event.role !== "user";

/** Managed mode: metering moved before the contiguous same-turn response presentations ahead of it. */
export function canonicalManagedEvents(events: readonly Item[]): Item[] {
  const out = [...events];
  for (let index = 0; index < out.length; index += 1) {
    if (out[index]!.kind !== "metering_recorded") continue;
    const turn = out[index]!.operationId;
    let at = index;
    while (at > 0 && isResponsePresentation(out[at - 1]!, turn)) {
      [out[at - 1], out[at]] = [out[at]!, out[at - 1]!];
      at -= 1;
    }
  }
  return out;
}

const isInProgressAssistantSnapshot = (record: Item, turn: unknown) =>
  record.kind === "message" && record.role === "assistant" && record.status === "in_progress"
  && record.operationId === turn && String(record.recordId).includes(":snapshot:");

/**
 * Agent-owned mode: the records with the allowed pair metering first, and the bus with the same
 * pair swapped. Throws if the bus does not list exactly the records' ids in their order.
 */
export function canonicalOwnedRecords(
  records: readonly Item[],
  bus: readonly Item[],
): { records: Item[]; bus: Item[] } {
  const recordIds = records.map((record) => String(record.recordId));
  const busIds = bus.map((entry) => String(entry.recordId));
  if (JSON.stringify(recordIds) !== JSON.stringify(busIds)) {
    throw new Error(`the committed-record bus disagrees with the records: ${JSON.stringify(busIds)} vs ${JSON.stringify(recordIds)}`);
  }
  const out = [...records];
  const swapped: Array<readonly [string, string]> = [];
  for (let index = 1; index < out.length; index += 1) {
    const metering = out[index]!;
    if (metering.kind !== "metering") continue;
    const turn = metering.operationId;
    // The turn's last in-progress assistant snapshot, wherever it is.
    let last = -1;
    for (let at = 0; at < out.length; at += 1) if (isInProgressAssistantSnapshot(out[at]!, turn)) last = at;
    if (last !== index - 1) continue; // not adjacent directly before metering: left as captured
    const snapshot = out[index - 1]!;
    out[index - 1] = { ...metering, sequence: snapshot.sequence };
    out[index] = { ...snapshot, sequence: metering.sequence };
    swapped.push([String(snapshot.recordId), String(metering.recordId)]);
  }
  const outBus = [...bus];
  for (const [snapshotId, meteringId] of swapped) {
    const at = outBus.findIndex((entry) => entry.recordId === snapshotId);
    // Same order as the records (checked above), so the metering entry is the next one.
    if (outBus[at + 1]?.recordId === meteringId) [outBus[at], outBus[at + 1]] = [outBus[at + 1]!, outBus[at]!];
  }
  return { records: out, bus: outBus };
}
