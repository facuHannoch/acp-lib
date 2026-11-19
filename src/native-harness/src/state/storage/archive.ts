import type { SessionArchive, SessionArchiveV1, StoredSession } from "../../contracts/storage.ts";
import { Fail, isJson, signatureOf, type Meta, type Tables } from "./engine.ts";
import { validateConfig } from "./session-file.ts";
import { legacyItemSignature, policyItemSignature } from "./policy-metadata.ts";

const bad = (message: string): never => { throw new Fail("invalid_archive", message); };
const str = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const int = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const MILESTONES = ["received", "taken", "delivered", "seen", "withdrawn"];
const CHANNEL_STATES = ["open", "suspended", "retired"];

/** Validate both records before a destination is created or modified. */
export function validateSessionPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "archive,config") bad("Invalid session file payload");
  const payload = value as { archive: SessionArchive; config: unknown };
  if (![2, 3].includes((payload.archive as { archiveVersion?: number })?.archiveVersion ?? 0)) bad("Invalid session file archive version");
  const archive = validateArchive(payload.archive);
  let config: ReturnType<typeof validateConfig>;
  try { config = validateConfig(payload.config, (payload.archive as { archiveVersion: number }).archiveVersion === 2); } catch (error) { return bad(String(error)); }
  return { archive, config };
}

/** Check the whole logical archive before anything is written, and return it
 * in the current (version 2) shape. Version 1, written by the persistence
 * revision, reads as every channel `open` and unnamed. Rejects every state a
 * legal export cannot produce, including a `suspending` lifecycle or channel, a
 * running turn, a checkpoint nothing holds, or a live turn on a retired channel,
 * which the next open would treat as an unclean exit or must never run. */
export function validateArchive(value: unknown): SessionArchive {
  if (!isJson(value) || !value || typeof value !== "object") bad("Archive is not JSON data");
  const raw = value as any;
  if (raw.format !== "harness-session" || ![1, 2, 3].includes(raw.archiveVersion)) bad("Unsupported archive format or version");
  const v1 = raw.archiveVersion === 1;
  const legacy = raw.archiveVersion !== 3;
  if (!raw.snapshot || !raw.allocation || !raw.snapshot.session || !Array.isArray(raw.snapshot.channels)) bad("Archive is missing its snapshot or allocation state");
  const archive: SessionArchive = legacy ? { ...raw, archiveVersion: 3, snapshot: { ...raw.snapshot,
    session: { ...raw.snapshot.session, formatVersion: 4 },
    channels: v1 ? raw.snapshot.channels.map((channel: any) => ({ ...channel, lifecycle: "open" as const })) : raw.snapshot.channels,
    turns: Array.isArray(raw.snapshot.turns) ? raw.snapshot.turns.map((turn: any) => turn?.state?.status === "suspended"
      ? { ...turn, state: { ...turn.state, checkpoint: { ...turn.state.checkpoint, policyFingerprint: JSON.stringify([["__legacy_allow", "allow", []]]) } } } : turn) : raw.snapshot.turns,
    items: Array.isArray(raw.snapshot.items) ? raw.snapshot.items.map((item: any) => {
      if (!item || item.signature !== legacyItemSignature(item)) bad("Invalid legacy item signature");
      return { ...item, signature: policyItemSignature(item), policy: { resolved: "__legacy_allow", inherited: [] } };
    }) : raw.snapshot.items } } : raw as SessionArchive;
  const snapshot = archive.snapshot, allocation = archive.allocation;
  const { session, revision } = snapshot;
  if (session.formatVersion !== 4 || !str(session.sessionId) || !str(session.createdAt) || typeof session.compatibilityKey !== "string")
    bad("Unsupported session format");
  if (session.lifecycle !== "running" && session.lifecycle !== "suspended") bad("Archive was not exported from an idle or suspended session");
  if (!Number.isSafeInteger(revision) || revision < 0 || allocation.nextSeq !== revision + 1 || !int(allocation.nextTurnId) || !int(allocation.nextItemNumber))
    bad("Inconsistent allocation state");
  for (const list of [snapshot.channels, snapshot.participants, snapshot.turns, snapshot.items, snapshot.timeline])
    if (!Array.isArray(list)) bad("Archive lists are malformed");
  const channels = new Map<string, string>();
  for (const channel of snapshot.channels) {
    if (!channel || !str(channel.channelId) || channels.has(channel.channelId)) bad("Invalid or duplicate channel");
    if (!CHANNEL_STATES.includes(channel.lifecycle) || (channel.displayName !== undefined && !str(channel.displayName)))
      bad(`Channel ${channel.channelId} has an invalid lifecycle or name`);
    if (channel.policy !== undefined && !str(channel.policy)) bad(`Channel ${channel.channelId} has invalid policy`);
    channels.set(channel.channelId, channel.lifecycle);
  }
  if (snapshot.participants.some(participant => !participant || !str(participant.participantId))) bad("Invalid participant");

  const turns = new Map<number, { channelId: string; itemIds: string[] }>(), live = new Set<string>();
  let previous = 0;
  for (const turn of snapshot.turns) {
    if (!turn || !int(turn.turnId) || turn.turnId <= previous || turn.turnId >= allocation.nextTurnId || !channels.has(turn.channelId)
      || !int(turn.startedSeq) || turn.startedSeq > revision || !str(turn.startedAt) || typeof turn.compatibilityKey !== "string"
      || !Array.isArray(turn.itemIds) || !turn.state) bad("Invalid turn record");
    previous = turn.turnId;
    const state = turn.state;
    if (state.status === "suspended") {
      // Held by the session suspension, or by the channel's own committed one.
      if (channels.get(turn.channelId) === "retired") bad(`Retired channel ${turn.channelId} holds a checkpoint`);
      if ((session.lifecycle !== "suspended" && channels.get(turn.channelId) !== "suspended") || live.has(turn.channelId)
        || state.checkpoint?.nextStep !== "inference" || !int(state.checkpoint.afterSeq) || typeof state.checkpoint.policyFingerprint !== "string") bad("Invalid checkpoint");
      live.add(turn.channelId);
    } else if (state.status === "failed" || state.status === "interrupted") {
      if (!str(state.reason) || !Array.isArray(state.uncertainCallIds) || state.uncertainCallIds.some(id => !str(id))) bad("Invalid turn outcome");
    } else if (state.status !== "completed") bad("Archive holds a turn that is still running");
    turns.set(turn.turnId, { channelId: turn.channelId, itemIds: [] });
  }

  const entries = new Map<number, (typeof snapshot.timeline)[number]>();
  previous = 0;
  for (const entry of snapshot.timeline) {
    const turn = entry && turns.get(entry.turnId), message = entry?.message;
    if (!turn || !int(entry.seq) || entry.seq <= previous || entry.seq > revision || entry.channelId !== turn.channelId
      || !str(entry.at) || !str(entry.from) || !message) bad("Invalid timeline entry");
    if (message.role === "user") { if (typeof message.content !== "string") bad("Invalid input entry"); }
    else if (message.role === "assistant") { if (!Array.isArray(message.calls)) bad("Invalid assistant entry"); }
    else if (message.role !== "tool" || !str(message.callId)) bad("Invalid timeline message");
    previous = entry.seq; entries.set(entry.seq, entry);
  }

  const ids = new Set<string>(), accepted = new Set<number>();
  for (const item of [...snapshot.items].sort((a, b) => (a?.entrySeq ?? 0) - (b?.entrySeq ?? 0))) {
    if (!item || !str(item.itemId) || ids.has(item.itemId) || !channels.has(item.channelId) || !MILESTONES.includes(item.milestone)
      || !int(item.acceptedSeq) || item.acceptedSeq > revision || accepted.has(item.acceptedSeq) || !str(item.acceptedAt)
      || (v1 && item.milestone === "withdrawn") || (item.milestone === "withdrawn") !== (item.withdrawnAt !== undefined)
      || (item.withdrawnAt !== undefined && !str(item.withdrawnAt))) bad("Invalid or duplicate item");
    accepted.add(item.acceptedSeq);
    if (![item.kind, item.senderId, item.text].every(str) || item.signature !== signatureOf(item)) bad(`Item ${item.itemId} does not match its signature`);
    if (!item.policy || !str(item.policy.resolved) || !Array.isArray(item.policy.inherited) || item.policy.inherited.some(name => !str(name))
      || (item.policy.explicit !== undefined && !str(item.policy.explicit)) || (item.policy.explicit ?? null) !== (item.explicitPolicy ?? null)) bad(`Item ${item.itemId} has invalid policy metadata`);
    ids.add(item.itemId);
    const auto = /^auto:(0|[1-9]\d*)$/.exec(item.itemId);
    if (auto && Number(auto[1]) >= allocation.nextItemNumber) bad("Item counter would reissue an allocated ID");
    if (item.milestone === "received" || item.milestone === "withdrawn") {
      if (item.turnId !== undefined || item.entrySeq !== undefined) bad(`${item.milestone === "received" ? "Pending" : "Withdrawn"} item is linked to a turn`);
      if (item.milestone === "received" && channels.get(item.channelId) === "retired") bad("Retired channel holds pending input");
      if (item.milestone === "received" && session.lifecycle === "running") bad("Archive of a running session holds pending input");
    } else {
      const entry = entries.get(item.entrySeq as number), turn = turns.get(item.turnId as number);
      if (!turn || !entry || entry.itemId !== item.itemId || entry.turnId !== item.turnId) bad(`Item ${item.itemId} has no matching timeline entry`);
      turn!.itemIds.push(item.itemId);
    }
  }
  for (const turn of snapshot.turns)
    if (JSON.stringify(turn.itemIds) !== JSON.stringify(turns.get(turn.turnId)!.itemIds)) bad(`Turn ${turn.turnId} does not match its items`);
  return archive;
}

export function archiveMeta(archive: SessionArchive, sessionId?: string): Meta {
  const { session, revision } = archive.snapshot;
  return { sessionId: sessionId ?? session.sessionId, formatVersion: 4, createdAt: session.createdAt,
    compatibilityKey: session.compatibilityKey, lifecycle: session.lifecycle, revision,
    nextTurnId: archive.allocation.nextTurnId, nextItemNumber: archive.allocation.nextItemNumber };
}

/** Write a validated archive into empty tables that already hold `archiveMeta`. */
export function restoreArchive(tables: Tables, archive: SessionArchive): void {
  const snapshot = archive.snapshot;
  tables.transaction(() => {
    for (const { participantIds: _derived, ...channel } of snapshot.channels) tables.putChannel(channel);
    for (const participant of snapshot.participants) tables.addParticipant(participant.participantId);
    for (const { itemIds: _derived, ...turn } of snapshot.turns) tables.putTurn(turn);
    for (const entry of snapshot.timeline) tables.addEntry(entry);
    for (const item of snapshot.items) tables.putItem(item);
  });
}

export function storedSession(meta: Meta): StoredSession {
  return { sessionId: meta.sessionId, formatVersion: 4, createdAt: meta.createdAt, lifecycle: meta.lifecycle, compatibilityKey: meta.compatibilityKey };
}
