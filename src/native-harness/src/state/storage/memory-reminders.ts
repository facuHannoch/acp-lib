import type { ReminderWake } from "../../contracts/reminders.ts";
import type { ReminderReceipt } from "./reminder-change.ts";
import type { ReminderRow, ReminderTables } from "./reminder-tables.ts";

export interface MemoryReminderState {
  rows: Map<string, ReminderRow>;
  creates: Map<string, ReminderReceipt>;
  receipts: Map<string, Map<number, ReminderReceipt>>;
  highWater: Map<string, number>;
  listingRevision: number;
  wake: ReminderWake;
}

export const emptyMemoryReminders = (): MemoryReminderState => ({
  rows: new Map(), creates: new Map(), receipts: new Map(), highWater: new Map(), listingRevision: 0,
  wake: { nextDueAt: null, reminderRevision: 0 },
});

export function memoryReminderTables(
  state: MemoryReminderState, log: (undo: () => void) => void, eligible: (channel: string) => boolean,
): ReminderTables {
  function put<K, V>(map: Map<K, V>, key: K, value: V) {
    const previous = map.get(key);
    log(() => { if (previous === undefined) map.delete(key); else map.set(key, previous); });
    map.set(key, structuredClone(value));
  }

  return {
    activate() {},
    archive() {
      return structuredClone({ rows: [...state.rows.values()], receipts: [...state.receipts.values()].flatMap(rows => [...rows.values()]),
        listingRevision: state.listingRevision, wake: state.wake });
    },
    restore(saved) {
      for (const row of saved.rows) this.put(row);
      for (const receipt of saved.receipts) this.saveReceipt(receipt);
      this.setWake(saved.wake);
      const before = state.listingRevision;
      log(() => { state.listingRevision = before; });
      state.listingRevision = saved.listingRevision;
    },
    get: id => structuredClone(state.rows.get(id)),
    put(row) {
      put(state.rows, row.reminder.id, row);
      const before = state.listingRevision++;
      log(() => { state.listingRevision = before; });
    },
    originalCreate: id => structuredClone(state.creates.get(id)),
    receipt: (id, version) => structuredClone(state.receipts.get(id)?.get(version)),
    highWater: id => state.highWater.get(id) ?? 0,
    saveReceipt(receipt) {
      const { reminderId, changeId } = receipt.result;
      if (receipt.fingerprint.startsWith('["create",') && !state.creates.has(reminderId)) put(state.creates, reminderId, receipt);
      const existing = state.receipts.get(reminderId);
      if (existing) put(existing, changeId, receipt);
      else put(state.receipts, reminderId, new Map([[changeId, receipt]]));
      put(state.highWater, reminderId, Math.max(state.highWater.get(reminderId) ?? 0, changeId));
    },
    list: (channel, after, limit) => structuredClone([...state.rows.values()]
      .filter(row => row.sequence > after && (channel === undefined || row.reminder.channel === channel))
      .slice(0, limit)),
    blocked: (channel, after, limit) => structuredClone([...state.rows.values()]
      .filter(row => row.sequence > after && row.reminder.state === "blocked" && row.reminder.blockedReason === "invalid_policy"
        && (channel === undefined || row.reminder.channel === channel))
      .slice(0, limit)),
    eligible: (through, limit) => structuredClone([...state.rows.values()]
      .filter(({ reminder }) => reminder.nextRunAt !== null && (through === null || reminder.nextRunAt <= through) && eligible(reminder.channel))
      .sort((a, b) => a.reminder.nextRunAt!.localeCompare(b.reminder.nextRunAt!) || a.sequence - b.sequence)
      .slice(0, limit)),
    listingRevision: () => state.listingRevision,
    wake: () => structuredClone(state.wake),
    setWake(wake) {
      const before = state.wake;
      log(() => { state.wake = before; });
      state.wake = structuredClone(wake);
    },
  };
}
