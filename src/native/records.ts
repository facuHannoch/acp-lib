/**
 * What the native host must remember across a harness restart (acp-client integration spec,
 * "Changes made while stopped" and "Sending, approval, and interruption"):
 *
 * - the newest desired state of each channel that the harness has not confirmed, and
 * - every input handed to the harness whose outcome is not settled, with its exact payload.
 *
 * Both are written BEFORE the request that depends on them, so a lost response or a dead process
 * leaves enough to retry with the same id and payload. The store is behind an interface: the default
 * lives in memory (it survives a harness restart, not an acp-client restart); `createFileHostRecords`
 * keeps the same data in one JSON file for hosts that need it across their own restarts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChannelDesire, PendingChange } from "../persistence/channels.ts";
export type { ChannelDesire, PendingChange } from "../persistence/channels.ts";

/** One input as it is pushed: saved before the push, replayed unchanged after a lost response. */
export interface Submission {
  readonly id: string;
  readonly channel: string;
  readonly sender: string;
  readonly text: string;
  readonly policy?: string;
  /**
   * `saved`: recorded, and no push for it has been written yet; the harness cannot have it.
   * `unknown`: a push was written and its outcome is not known (no receipt): the harness may or may
   * not hold the input, so it is reconciled or retried with this id and payload.
   * `accepted`: a receipt or the reconciled harness state confirmed it; from then on it settles from
   * the turn that takes it.
   */
  state: "saved" | "unknown" | "accepted";
}

export interface NativeHostRecords {
  /** Merges `desire` into the channel's pending state (newest value of each field wins). Returns the new version. */
  desire(channel: string, desire: ChannelDesire): PendingChange;
  pendingChange(channel: string): PendingChange | undefined;
  pendingChanges(): PendingChange[];
  /** Clears the channel's pending change only if `version` is still its newest: an older confirmation never clears a newer edit. */
  confirmChange(channel: string, version: number): boolean;

  saveSubmission(submission: Submission): void;
  submission(id: string): Submission | undefined;
  submissions(channel?: string): Submission[];
  /** A push for it is about to be written: from now on its outcome is unknown until confirmed. */
  markSent(id: string): void;
  markAccepted(id: string): void;
  /** The input reached a terminal outcome (its turn ended, or it was withdrawn or refused): nothing left to retry. */
  settleSubmission(id: string): void;
}

interface State { changes: Record<string, { version: number; desire: ChannelDesire }>; submissions: Record<string, Submission>; versions: number }

function build(state: State, commit: () => void): NativeHostRecords {
  return {
    desire(channel, desire) {
      const previous = state.changes[channel]?.desire ?? {};
      // Versions never repeat, even after a confirmation removed the channel's entry: a late
      // confirmation of an old version can then never match a newer change.
      const next = { version: ++state.versions, desire: { ...previous, ...desire } };
      state.changes[channel] = next;
      commit();
      return { channel, version: next.version, desire: { ...next.desire } };
    },
    pendingChange(channel) {
      const change = state.changes[channel];
      return change && { channel, version: change.version, desire: { ...change.desire } };
    },
    pendingChanges() {
      return Object.entries(state.changes).map(([channel, change]) => ({ channel, version: change.version, desire: { ...change.desire } }));
    },
    confirmChange(channel, version) {
      if (state.changes[channel]?.version !== version) return false;
      delete state.changes[channel];
      commit();
      return true;
    },
    saveSubmission(submission) {
      // A repeat of the same id keeps the original: the payload a retry sends must be the first one.
      if (state.submissions[submission.id]) return;
      state.submissions[submission.id] = { ...submission };
      commit();
    },
    submission(id) { const found = state.submissions[id]; return found && { ...found }; },
    submissions(channel) {
      return Object.values(state.submissions).filter((submission) => channel === undefined || submission.channel === channel).map((submission) => ({ ...submission }));
    },
    markSent(id) {
      const found = state.submissions[id];
      if (found?.state !== "saved") return;
      found.state = "unknown";
      commit();
    },
    markAccepted(id) {
      const found = state.submissions[id];
      if (!found || found.state === "accepted") return;
      found.state = "accepted";
      commit();
    },
    settleSubmission(id) {
      if (!state.submissions[id]) return;
      delete state.submissions[id];
      commit();
    },
  };
}

const empty = (): State => ({ changes: {}, submissions: {}, versions: 0 });
const fileChanges = new WeakMap<NativeHostRecords, () => boolean>();

export function fileHasPendingChannelChanges(records: NativeHostRecords): boolean {
  return fileChanges.get(records)?.() ?? false;
}

/** Keep submission storage usable while preventing access to a second channel store. */
export function submissionRecords(records: NativeHostRecords): NativeHostRecords {
  const unavailable = () => {
    throw new Error("Native host channel records use persistence. Read them with pendingChannelChanges().");
  };
  return {
    desire: unavailable,
    pendingChange: unavailable,
    pendingChanges: unavailable,
    confirmChange: unavailable,
    saveSubmission: records.saveSubmission.bind(records),
    submission: records.submission.bind(records),
    submissions: records.submissions.bind(records),
    markSent: records.markSent.bind(records),
    markAccepted: records.markAccepted.bind(records),
    settleSubmission: records.settleSubmission.bind(records),
  };
}

export function createMemoryHostRecords(): NativeHostRecords {
  return build(empty(), () => undefined);
}

/** The same records in one JSON file, rewritten atomically (write, then rename) on every change. */
export function createFileHostRecords(path: string): NativeHostRecords {
  let state = empty();
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
    state = { changes: parsed.changes ?? {}, submissions: parsed.submissions ?? {}, versions: parsed.versions ?? 0 };
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  const records = build(state, () => {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, path);
  });
  fileChanges.set(records, () => Object.keys(state.changes).length !== 0);
  return records;
}
