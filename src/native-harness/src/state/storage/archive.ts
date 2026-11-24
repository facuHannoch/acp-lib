import { validateReminderArchive } from "./reminder-archive.ts";
import type { SessionArchive, SessionArchiveV1, StoredSession } from "../../contracts/storage.ts";
import { Fail, isJson, signatureOf, type Meta, type Tables } from "./engine.ts";
import { validateConfig } from "./session-file.ts";
import { legacyItemSignature, policyItemSignature } from "./policy-metadata.ts";

const bad = (message: string): never => { throw new Fail("invalid_archive", message); };
const str = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nonblank = (value: unknown): value is string => str(value) && value.trim().length > 0;
const int = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const MILESTONES = ["received", "taken", "delivered", "seen", "withdrawn"];
const CHANNEL_STATES = ["open", "suspended", "retired"];

/** Validate both records before a destination is created or modified. */
export function validateSessionPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "archive,config") bad("Invalid session file payload");
  const payload = value as { archive: SessionArchive; config: unknown };
  if (![2, 3, 4, 5, 6].includes((payload.archive as { archiveVersion?: number })?.archiveVersion ?? 0)) bad("Invalid session file archive version");
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
  if (raw.format !== "harness-session" || ![1, 2, 3, 4, 5, 6].includes(raw.archiveVersion)) bad("Unsupported archive format or version");
  const v1 = raw.archiveVersion === 1;
  const legacy = raw.archiveVersion < 3;
  if (!raw.snapshot || !raw.allocation || !raw.snapshot.session || !Array.isArray(raw.snapshot.channels)) bad("Archive is missing its snapshot or allocation state");
  const policyArchive = legacy ? { ...raw, archiveVersion: 3, snapshot: { ...raw.snapshot,
    session: { ...raw.snapshot.session, formatVersion: 4 },
    channels: v1 ? raw.snapshot.channels.map((channel: any) => ({ ...channel, lifecycle: "open" as const })) : raw.snapshot.channels,
    turns: Array.isArray(raw.snapshot.turns) ? raw.snapshot.turns.map((turn: any) => turn?.state?.status === "suspended"
      ? { ...turn, state: { ...turn.state, checkpoint: { ...turn.state.checkpoint, policyFingerprint: JSON.stringify([["__legacy_allow", "allow", []]]) } } } : turn) : raw.snapshot.turns,
    items: Array.isArray(raw.snapshot.items) ? raw.snapshot.items.map((item: any) => {
      if (!item || item.signature !== legacyItemSignature(item)) bad("Invalid legacy item signature");
      return { ...item, signature: policyItemSignature(item), policy: { resolved: "__legacy_allow", inherited: [] } };
    }) : raw.snapshot.items } } : raw;
  const old = raw.archiveVersion < 4;
  const positions: Record<string, number> = {};
  if (old && Array.isArray(policyArchive.snapshot.timeline)) for (const entry of policyArchive.snapshot.timeline)
    if (entry.message?.role === "assistant") Object.defineProperty(positions, entry.channelId, { value: (Object.hasOwn(positions, entry.channelId) ? positions[entry.channelId]! : 0) + 1, writable: true, configurable: true, enumerable: true });
  const previousFormat = [0, 2, 3, 4, 5, 6, 7][raw.archiveVersion];
  if (raw.snapshot.session.formatVersion !== previousFormat) bad("Unsupported session format");
  const archive: SessionArchive = { ...policyArchive, archiveVersion: raw.archiveVersion === 6 ? 6 : 5, snapshot: { ...policyArchive.snapshot,
    session: { ...policyArchive.snapshot.session, formatVersion: raw.archiveVersion === 6 ? 7 : 6 },
    ...(old ? { modelCalls: [], scriptPositions: positions } : {}) } };
  const snapshot = archive.snapshot, allocation = archive.allocation;
  const { session, revision } = snapshot;
  if ((session.formatVersion !== 6 && session.formatVersion !== 7) || !str(session.sessionId) || !str(session.createdAt) || typeof session.compatibilityKey !== "string")
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
  const calls = new Map<number, { all: Set<string>; outstanding: Set<string> }>();
  previous = 0;
  for (const entry of snapshot.timeline) {
    const turn = entry && turns.get(entry.turnId), message = entry?.message;
    if (!turn || !int(entry.seq) || entry.seq <= previous || entry.seq > revision || entry.channelId !== turn.channelId
      || !str(entry.at) || !str(entry.from) || !message) bad("Invalid timeline entry");
    if (entry.kind === "external_notice" && (raw.archiveVersion < 5 || message.role !== "user"
      || !nonblank(entry.itemId) || entry.sourceChannelId !== undefined || (entry.externalSource !== undefined && !nonblank(entry.externalSource))
      || entry.from !== (entry.externalSource ?? "host"))) bad("Invalid external timeline entry");
    if (entry.kind !== "external_notice" && entry.externalSource !== undefined) bad("Unexpected external attribution");
    if (message.role === "user") { if (typeof message.content !== "string") bad("Invalid input entry"); }
    else if (message.role === "assistant") {
      if (!Array.isArray(message.calls)) bad("Invalid assistant entry");
      const state = calls.get(entry.turnId) ?? { all: new Set<string>(), outstanding: new Set<string>() };
      for (const call of message.calls) {
        if (!str(call.id) || state.all.has(call.id)) bad("Invalid or duplicate tool call ID");
        state.all.add(call.id); state.outstanding.add(call.id);
      }
      calls.set(entry.turnId, state);
    } else if (message.role === "tool") {
      if (!str(message.callId) || !calls.get(entry.turnId)?.outstanding.delete(message.callId)) bad("Tool result has no matching call");
    } else bad("Invalid timeline message");
    previous = entry.seq; entries.set(entry.seq, entry);
  }
  for (const turn of snapshot.turns) {
    const { all, outstanding } = calls.get(turn.turnId) ?? { all: new Set<string>(), outstanding: new Set<string>() };
    const dispatched = (turn.state as { dispatchedCallIds?: unknown }).dispatchedCallIds;
    if (dispatched !== undefined && (!Array.isArray(dispatched) || dispatched.some(id => !str(id) || !all.has(id))
      || new Set(dispatched).size !== dispatched.length)) bad("Invalid dispatched call evidence");
    if (turn.state.status === "suspended" && outstanding.size) bad("Checkpoint has an unanswered tool call");
  }

  const revoked = (snapshot as { revokedTools?: unknown }).revokedTools;
  if (revoked !== undefined && (!Array.isArray(revoked) || revoked.some(name => !str(name)) || new Set(revoked).size !== revoked.length
    || JSON.stringify([...revoked].sort()) !== JSON.stringify(revoked))) bad("Invalid revoked tools");
  if (!Array.isArray(snapshot.modelCalls) || !snapshot.scriptPositions || typeof snapshot.scriptPositions !== "object" || Array.isArray(snapshot.scriptPositions)) bad("Invalid model execution records");
  for (const [channel, next] of Object.entries(snapshot.scriptPositions))
    if (!channels.has(channel) || !Number.isSafeInteger(next) || (next as number) < 0) bad("Invalid scripted position");
  const callIds = new Set<string>(), messageIds = new Set<string>(), reservations = new Set<string>();
  let previousCallId = 0;
  for (const call of snapshot.modelCalls) {
    if (!call || !/^[1-9]\d*$/.test(call.callId) || !Number.isSafeInteger(Number(call.callId)) || callIds.has(call.callId)
      || !str(call.messageId) || messageIds.has(call.messageId) || !turns.has(Number(call.turnId)) || turns.get(Number(call.turnId))!.channelId !== call.channel
      || !str(call.startedAt) || !str(call.endedAt) || !["succeeded", "failed", "incomplete", "output_limit", "timeout", "interrupted"].includes(call.outcome)
      || !Array.isArray(call.attempts) || call.attempts.length > 2) bad("Invalid model call");
    if (Number(call.callId) <= previousCallId) bad("Model calls are not in creation order");
    previousCallId = Number(call.callId);
    if (call.messageId !== `model:${call.callId}`) bad("Invalid reserved message ID");
    callIds.add(call.callId); messageIds.add(call.messageId);
    for (const [ordinal, attempt] of call.attempts.entries()) {
      if (!attempt || attempt.ordinal !== ordinal || attempt.attemptId !== `${call.callId}:${ordinal}` || !str(attempt.startedAt) || !str(attempt.endedAt)
        || !["succeeded", "transient_failure", "invalid_request", "invalid_config", "provider_failure", "incomplete", "output_limit", "timeout", "interrupted"].includes(attempt.outcome)
        || (attempt.providerRequestId !== undefined && !str(attempt.providerRequestId)) || (attempt.retryReason !== undefined && !str(attempt.retryReason))
        || (attempt.scriptStep !== undefined && (!Number.isSafeInteger(attempt.scriptStep) || attempt.scriptStep < 0))) bad("Invalid model attempt");
      if (attempt.scriptStep !== undefined) {
        const key = `${call.channel}\0${attempt.scriptStep}`;
        if (reservations.has(key) || attempt.scriptStep >= (Object.hasOwn(snapshot.scriptPositions, call.channel) ? snapshot.scriptPositions[call.channel]! : 0)) bad("Invalid script reservation");
        reservations.add(key);
      }
      if (attempt.usage && (typeof attempt.usage !== "object" || Object.keys(attempt.usage).some(key => !["inputTokens", "outputTokens", "totalTokens"].includes(key))
        || Object.values(attempt.usage).some(value => !Number.isSafeInteger(value) || (value as number) < 0))) bad("Invalid model usage");
    }
    const succeeded = call.attempts.filter(attempt => attempt.outcome === "succeeded");
    if (call.outcome === "succeeded" ? succeeded.length !== 1 || call.attempts.at(-1)?.outcome !== "succeeded" : succeeded.length !== 0)
      bad("Call and attempt outcomes disagree");
    const matched = snapshot.timeline.filter(entry => entry.messageId === call.messageId);
    if (call.outcome === "succeeded" ? matched.length !== 1 || matched[0]!.message.role !== "assistant" || matched[0]!.turnId !== Number(call.turnId) : matched.length !== 0)
      bad("Model call and committed response disagree");
  }
  for (const entry of snapshot.timeline) if (entry.messageId && !messageIds.has(entry.messageId)) bad("Unknown model message ID");

  const ids = new Set<string>(), accepted = new Set<number>(), externalEntries = new Set<number>();
  for (const item of [...snapshot.items].sort((a, b) => (a?.entrySeq ?? 0) - (b?.entrySeq ?? 0))) {
    if (!item || !str(item.itemId) || ids.has(item.itemId) || !channels.has(item.channelId) || !MILESTONES.includes(item.milestone)
      || !int(item.acceptedSeq) || item.acceptedSeq > revision || accepted.has(item.acceptedSeq) || !str(item.acceptedAt)
      || (v1 && item.milestone === "withdrawn") || (item.milestone === "withdrawn") !== (item.withdrawnAt !== undefined)
      || (item.withdrawnAt !== undefined && !str(item.withdrawnAt))) bad("Invalid or duplicate item");
    accepted.add(item.acceptedSeq);
    if (item.kind === "external_notice") {
      const names = item.inheritedPolicyNames;
      if (raw.archiveVersion < 5 || item.sourceChannelId !== undefined || item.sourceTurnId !== undefined
        || item.explicitPolicy !== undefined || item.senderId !== (item.externalSource ?? "host")
        || !nonblank(item.itemId) || !nonblank(item.text)
        || (item.externalSource !== undefined && !nonblank(item.externalSource))
        || !Array.isArray(names) || names.some(name => !nonblank(name) || name === "__legacy_allow")
        || JSON.stringify(names) !== JSON.stringify([...new Set(names)].sort())
        || JSON.stringify(names) !== JSON.stringify(item.policy?.inherited)) bad("Invalid external notice metadata");
    } else if (!["participant_message", "channel_notice"].includes(item.kind)
      || item.externalSource !== undefined || item.inheritedPolicyNames !== undefined) bad("Invalid item kind or attribution");
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
      if (item.kind === "external_notice" && (entry!.kind !== item.kind || entry!.externalSource !== item.externalSource
        || entry!.channelId !== item.channelId || entry!.message.content !== item.text)) bad("External notice and timeline disagree");
      if (item.kind === "external_notice") externalEntries.add(entry!.seq);
      turn!.itemIds.push(item.itemId);
    }
  }
  for (const entry of snapshot.timeline)
    if (entry.kind === "external_notice" && !externalEntries.has(entry.seq)) bad("External timeline entry has no inbox item");
  for (const turn of snapshot.turns)
    if (JSON.stringify(turn.itemIds) !== JSON.stringify(turns.get(turn.turnId)!.itemIds)) bad(`Turn ${turn.turnId} does not match its items`);
  if (archive.archiveVersion === 6) validateReminderArchive(archive.reminderState, snapshot);
  else if (raw.reminderState !== undefined) bad("Reminder state requires archive version 6");
  return archive;
}

export function archiveMeta(archive: SessionArchive, sessionId?: string): Meta {
  const { session, revision } = archive.snapshot;
  return { sessionId: sessionId ?? session.sessionId, formatVersion: session.formatVersion, createdAt: session.createdAt,
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
    const entryIds = Object.fromEntries(snapshot.timeline.filter(entry => entry.messageId).map(entry => [String(entry.seq), entry.messageId!]));
    const max = snapshot.modelCalls.reduce((n, call) => Math.max(n, Number(call.callId) || 0), 0);
    tables.setModelState({ nextCall: max + 1, calls: snapshot.modelCalls, itemIds: {}, scriptPositions: snapshot.scriptPositions, entryIds });
    if (archive.reminderState) tables.reminders.restore(archive.reminderState);
    if (snapshot.revokedTools !== undefined) tables.setRevokedTools(snapshot.revokedTools);
  });
}

export function storedSession(meta: Meta): StoredSession {
  return { sessionId: meta.sessionId, formatVersion: meta.formatVersion === 7 ? 7 : 6, createdAt: meta.createdAt, lifecycle: meta.lifecycle, compatibilityKey: meta.compatibilityKey };
}
