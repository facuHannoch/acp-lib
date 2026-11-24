import type { ChannelChangeResult, PendingChannelChange } from "../../contracts/protocol.ts";
import type { ChannelStatus, ControlResult, PersistentSession } from "../../contracts/session.ts";

/** A batch the open must refuse (`invalid_params`, `invalid_policy`) or a
 * transition that failed for a reason the contract gives no outcome for. */
export class ChannelChangeFault extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const invalid = (message: string): never => { throw new ChannelChangeFault("invalid_params", message); };
const FIELDS = ["channel", "changeId", "displayName", "policy", "lifecycle"];
const NAME_MAX = 200;

/** Structural validation of the whole batch (decision 0020). Runs before the
 * session is opened, so a malformed batch touches nothing. Policy names need
 * the open's configuration and are checked by `checkPolicies`. */
export function parseChannelChanges(raw: unknown): PendingChannelChange[] {
  if (!Array.isArray(raw)) return invalid("channelChanges must be an array");
  const seen = new Set<string>();
  return raw.map((value, index): PendingChannelChange => {
    const at = `channelChanges[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${at} must be an object`);
    const entry = value as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (!FIELDS.includes(key)) invalid(`${at}: unsupported field ${key}`);
    const word = (name: string) => {
      const field = entry[name];
      if (typeof field !== "string" || !field.trim()) invalid(`${at}.${name} must be a nonempty string`);
      return field as string;
    };
    const channel = word("channel"), changeId = word("changeId");
    if (seen.has(channel)) invalid(`${at}: channel ${channel} appears twice`);
    seen.add(channel);
    const { displayName, policy, lifecycle } = entry;
    // The same bound storage enforces, checked here so no entry can fail
    // validation after an earlier one was applied.
    if (displayName !== undefined && displayName !== null && (typeof displayName !== "string" || !displayName.trim() || displayName.trim().length > NAME_MAX))
      invalid(`${at}.displayName must be null or 1 to ${NAME_MAX} characters`);
    if (policy !== undefined && policy !== null && (typeof policy !== "string" || !policy.trim())) invalid(`${at}.policy must be null or a policy name`);
    if (lifecycle !== undefined && lifecycle !== "open" && lifecycle !== "suspended" && lifecycle !== "retired") invalid(`${at}.lifecycle must be open, suspended or retired`);
    return { channel, changeId,
      ...(displayName === undefined ? {} : { displayName: displayName as string | null }),
      ...(policy === undefined ? {} : { policy: policy as string | null }),
      ...(lifecycle === undefined ? {} : { lifecycle: lifecycle as PendingChannelChange["lifecycle"] }) };
  });
}

/** Unknown policy names reject the whole batch. `policies` is the set the
 * session's configuration defines. */
export function checkPolicies(batch: readonly PendingChannelChange[], policies: readonly string[]) {
  for (const change of batch)
    if (typeof change.policy === "string" && !policies.includes(change.policy)) throw new ChannelChangeFault("invalid_policy", `Unknown policy: ${change.policy}`);
}

/** Two batches are the same request when they ask for the same thing in the same order. */
export const sameBatch = (left: readonly PendingChannelChange[], right: readonly PendingChannelChange[]) =>
  JSON.stringify(left.map(canonical)) === JSON.stringify(right.map(canonical));
const canonical = (change: PendingChannelChange) => [change.channel, change.changeId, change.displayName ?? (change.displayName === null ? null : "\0"),
  change.policy ?? (change.policy === null ? null : "\0"), change.lifecycle ?? "\0"];

type Channels = PersistentSession["channels"];
function done<T>(result: ControlResult<T>): T {
  if (!result.ok) throw new ChannelChangeFault(result.error.code, result.error.message);
  return result.value;
}
const applied = (change: PendingChannelChange): ChannelChangeResult => ({ channel: change.channel, changeId: change.changeId, outcome: "applied" });
const blocked = (change: PendingChannelChange, reason: NonNullable<ChannelChangeResult["reason"]>): ChannelChangeResult =>
  ({ channel: change.channel, changeId: change.changeId, outcome: "blocked", reason });

/** Apply a validated batch to a session that has NOT been started, reusing the
 * channel controls of decision 0014. Two phases:
 *
 * 1. (awaited) everything except resumes. Suspension returns a promise, but
 *    with no running turn it commits at once; nothing else can run meanwhile
 *    because the session is not started and no resume has happened yet.
 * 2. (the returned function, synchronous) resumes. The caller holds their
 *    committed notifications behind the open response.
 *
 * For each entry the lifecycle step is decided before the name and policy are
 * written, so a blocked entry writes neither. */
export async function applyChannelChanges(session: Pick<PersistentSession, "channels" | "status" | "operatorReads">, batch: readonly PendingChannelChange[]): Promise<() => ChannelChangeResult[]> {
  const channels: Channels = session.channels;
  const results = new Map<string, ChannelChangeResult>();
  const find = (channel: string) => {
    if (!session.operatorReads) {
      const state = session.status().channels.find(value => value.channelId === channel);
      return state && { ...state, pendingCount: state.pendingItemIds.length };
    }
    const result = session.operatorReads.readChannel(channel);
    if (!result.ok && result.error.code === "not_found") return undefined;
    const state = done(result);
    return { ...state.channel, pendingCount: state.pendingCount, activeTurn: state.activeTurn };
  };
  /** Create the channel with its settings, or edit the fields the entry names. */
  const write = (change: PendingChannelChange, existing: ReturnType<typeof find>) => {
    if (!existing) {
      done(channels.create({ channelId: change.channel, ...(typeof change.displayName === "string" ? { displayName: change.displayName } : {}),
        ...(typeof change.policy === "string" ? { policy: change.policy } : {}) }));
      return;
    }
    if (change.displayName === undefined && change.policy === undefined) return;
    // The control replaces the name, so an entry that omits it restates the current one.
    done(channels.edit(change.channel, change.displayName === undefined ? existing.displayName ?? null : change.displayName, change.policy));
  };
  const suspend = async (channel: string) => { done(await channels.suspend(channel)); };

  for (const change of batch) {
    if (change.lifecycle === "open") continue;
    const existing = find(change.channel);
    if (existing?.lifecycle === "retired") {
      results.set(change.channel, change.lifecycle === "retired" ? applied(change) : blocked(change, "channel_retired"));
      continue;
    }
    if (change.lifecycle === "retired") {
      // Busy is decided before anything is written: pending input or a
      // checkpoint must survive, and must not run, so the channel is suspended
      // instead and the host keeps its deletion pending.
      if (existing && (existing.pendingCount || existing.activeTurn)) {
        await suspend(change.channel);
        results.set(change.channel, blocked(change, "channel_busy"));
        continue;
      }
      write(change, existing);
      const retired = channels.delete(change.channel);
      if (!retired.ok && retired.error.code === "channel_busy") {
        await suspend(change.channel);
        results.set(change.channel, blocked(change, "channel_busy"));
        continue;
      }
      done(retired);
    } else {
      write(change, existing);
      if (change.lifecycle === "suspended") await suspend(change.channel);
    }
    results.set(change.channel, applied(change));
  }

  return () => {
    for (const change of batch) {
      if (change.lifecycle !== "open") continue;
      const existing = find(change.channel);
      if (existing?.lifecycle === "retired") { results.set(change.channel, blocked(change, "channel_retired")); continue; }
      if (existing) {
        const resumed = channels.resume(change.channel);
        // The checkpoint, or a stored policy reference, cannot run under this
        // configuration: storage wrote nothing and the channel stays suspended.
        if (!resumed.ok && resumed.error.code === "incompatible") { results.set(change.channel, blocked(change, "incompatible")); continue; }
        done(resumed);
      }
      write(change, existing);
      results.set(change.channel, applied(change));
    }
    return batch.map(change => results.get(change.channel)!);
  };
}
