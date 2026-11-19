import type { SessionArchive, StoredSession } from "../../contracts/storage.ts";
import { Fail, isJson, signatureOf, type Meta, type Tables } from "./engine.ts";

const bad = (message: string): never => { throw new Fail("invalid_archive", message); };
const str = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const int = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const MILESTONES = ["received", "taken", "delivered", "seen"];

/** Check the whole logical archive before anything is written. Rejects every
 * state a legal export cannot produce, including a `suspending` lifecycle or a
 * running turn, which the next open would treat as an unclean exit. */
export function validateArchive(value: unknown): SessionArchive {
  if (!isJson(value) || !value || typeof value !== "object") bad("Archive is not JSON data");
  const archive = value as SessionArchive;
  if (archive.format !== "harness-session" || archive.archiveVersion !== 1) bad("Unsupported archive format or version");
  const snapshot = archive.snapshot, allocation = archive.allocation;
  if (!snapshot || !allocation || !snapshot.session) bad("Archive is missing its snapshot or allocation state");
  const { session, revision } = snapshot;
  if (session.formatVersion !== 2 || !str(session.sessionId) || !str(session.createdAt) || typeof session.compatibilityKey !== "string")
    bad("Unsupported session format");
  if (session.lifecycle !== "running" && session.lifecycle !== "suspended") bad("Archive was not exported from an idle or suspended session");
  if (!Number.isSafeInteger(revision) || revision < 0 || allocation.nextSeq !== revision + 1 || !int(allocation.nextTurnId) || !int(allocation.nextItemNumber))
    bad("Inconsistent allocation state");
  for (const list of [snapshot.channels, snapshot.participants, snapshot.turns, snapshot.items, snapshot.timeline])
    if (!Array.isArray(list)) bad("Archive lists are malformed");
  const channels = new Set<string>();
  for (const channel of snapshot.channels) {
    if (!channel || !str(channel.channelId) || channels.has(channel.channelId)) bad("Invalid or duplicate channel");
    channels.add(channel.channelId);
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
      if (session.lifecycle !== "suspended" || live.has(turn.channelId) || state.checkpoint?.nextStep !== "inference" || !int(state.checkpoint.afterSeq))
        bad("Invalid checkpoint");
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

  const ids = new Set<string>();
  for (const item of [...snapshot.items].sort((a, b) => (a?.entrySeq ?? 0) - (b?.entrySeq ?? 0))) {
    if (!item || !str(item.itemId) || ids.has(item.itemId) || !channels.has(item.channelId) || !MILESTONES.includes(item.milestone)
      || !int(item.acceptedSeq) || item.acceptedSeq > revision || !str(item.acceptedAt)) bad("Invalid or duplicate item");
    if (![item.kind, item.senderId, item.text].every(str) || item.signature !== signatureOf(item)) bad(`Item ${item.itemId} does not match its signature`);
    ids.add(item.itemId);
    const auto = /^auto:(0|[1-9]\d*)$/.exec(item.itemId);
    if (auto && Number(auto[1]) >= allocation.nextItemNumber) bad("Item counter would reissue an allocated ID");
    if (item.milestone === "received") {
      if (item.turnId !== undefined || item.entrySeq !== undefined) bad("Pending item is linked to a turn");
      if (session.lifecycle === "running") bad("Archive of a running session holds pending input");
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
  return { sessionId: sessionId ?? session.sessionId, formatVersion: 2, createdAt: session.createdAt,
    compatibilityKey: session.compatibilityKey, lifecycle: session.lifecycle, revision,
    nextTurnId: archive.allocation.nextTurnId, nextItemNumber: archive.allocation.nextItemNumber };
}

/** Write a validated archive into empty tables that already hold `archiveMeta`. */
export function restoreArchive(tables: Tables, archive: SessionArchive): void {
  const snapshot = archive.snapshot;
  tables.transaction(() => {
    for (const channel of snapshot.channels) tables.addChannel(channel.channelId);
    for (const participant of snapshot.participants) tables.addParticipant(participant.participantId);
    for (const { itemIds: _derived, ...turn } of snapshot.turns) tables.putTurn(turn);
    for (const entry of snapshot.timeline) tables.addEntry(entry);
    for (const item of snapshot.items) tables.putItem(item);
  });
}

export function storedSession(meta: Meta): StoredSession {
  return { sessionId: meta.sessionId, formatVersion: 2, createdAt: meta.createdAt, lifecycle: meta.lifecycle, compatibilityKey: meta.compatibilityKey };
}
