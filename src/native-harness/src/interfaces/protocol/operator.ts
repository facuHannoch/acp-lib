import type { PersistentSession } from "../../contracts/session.ts";
import type { StorageResult, TimelineEntry } from "../../contracts/storage.ts";
import { MAX_FRAME_BYTES } from "./framing.ts";
import { turnStatus } from "./load.ts";

export class OperatorFault extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const bad = (message: string): never => { throw new OperatorFault("invalid_params", message); };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (value: unknown): unknown[] => {
  if (typeof value !== "string" || value.length > 65536) return bad("Invalid cursor");
  try {
    const data = JSON.parse(Buffer.from(value, "base64url").toString());
    if (Array.isArray(data) && encode(data) === value) return data;
  } catch { /* report a typed parameter error */ }
  return bad("Invalid cursor");
};
export function readValue<T>(result: StorageResult<T>) {
  if (!result.ok) throw new OperatorFault(result.error.code === "invalid_input" ? "invalid_params" : result.error.code, result.error.message);
  return result;
}
const id = (value: unknown): string => typeof value === "string" && value.trim() ? value : bad("Expected an ID");
const sequence = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : bad("Invalid sequence");
const turnId = (value: unknown): number => {
  const text = id(value), n = Number(text);
  return n > 0 && String(sequence(n)) === text ? n : bad("Invalid turn ID");
};
const ids = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return bad("Invalid tracked IDs");
  const list = value.map(id);
  if (new Set(list).size !== list.length) return bad("Duplicate tracked IDs");
  return list;
};

export const operatorMethods = ["channel/observe", "channel/reconcile", "channel/messages", "session/timeline"] as const;
export function operatorRead(session: PersistentSession, method: string, p: Record<string, unknown>, approvalConsumer: boolean) {
  const storage = session.operatorReads;
  if (!storage) throw new OperatorFault("invalid_state", "Focused reads are unavailable");
  const header = readValue(storage.readSession());
  const scope = header.value.sessionId;
  const channel = method === "session/timeline" ? undefined : id(p.channel);
  const position = (entry: TimelineEntry) => encode([scope, entry.channelId, entry.seq]);
  const messageId = (entry: TimelineEntry) => entry.itemId ? `item:${entry.itemId}` : entry.messageId ?? String(entry.seq);
  const budget = MAX_FRAME_BYTES - 1024;
  if (method === "channel/observe") {
    const found = readValue(storage.readChannel(channel!));
    const { channelId, ...state } = found.value.channel;
    const turn = found.value.activeTurn;
    const phase = turn && session.turnPhase?.(turn.turnId);
    return { revision: found.revision, sessionLifecycle: header.value.lifecycle,
      channel: { channel: channelId, ...state, pendingCount: found.value.pendingCount,
        waitingForResume: (state.lifecycle !== "open" || header.value.lifecycle !== "running") && (found.value.pendingCount > 0 || turn?.state.status === "suspended"),
        ...(turn ? { activeTurn: { turnId: String(turn.turnId), state: turn.state.status, ...(phase ? { phase } : {}) } } : {}) },
      approvals: approvalConsumer ? (session.approvals.waiting?.() ?? []).filter(request => request.channel === channel) : [] };
  }
  if (method === "channel/reconcile") {
    const cursor = p.cursor === undefined ? undefined : decode(p.cursor);
    if (cursor && (cursor.length !== 6 || cursor[0] !== scope || cursor[1] !== method || cursor[2] !== channel || p.itemIds !== undefined || p.turnIds !== undefined)) return bad("Invalid reconcile cursor");
    const inputIds = ids(p.itemIds), turns = ids(cursor?.[5] ?? p.turnIds).map(turnId);
    if (inputIds.length + turns.length > 100) return bad("Too many tracked IDs");
    const revision = cursor ? sequence(cursor[3]) : header.revision;
    const tracked = cursor ? undefined : readValue(storage.readTracked(channel!, inputIds, turns)).value;
    const page = readValue(storage.readTimeline({ kind: "replies", channel, turnIds: turns, direction: "newer", throughRevision: revision,
      exclusiveSeq: cursor ? sequence(cursor[4]) : undefined, limit: 50 })).value;
    const items = tracked?.items.map(item => ({ id: item.itemId, channel: item.channelId, kind: item.kind, sender: item.senderId,
      milestone: item.milestone, ...(item.policy ? { policy: item.policy } : {}), ...(item.turnId !== undefined ? { turnId: String(item.turnId) } : {}) })) ?? [];
    const foundTurns = tracked?.turns.map(turnStatus) ?? [];
    const result = { revision, items, turns: foundTurns, unknownItemIds: inputIds.filter(id => !items.some(item => item.id === id)),
      unknownTurnIds: cursor ? [] : turns.map(String).filter(id => !foundTurns.some(turn => turn.turnId === id)),
      replies: page.entries.map(entry => ({ messageId: messageId(entry), turnId: String(entry.turnId), position: position(entry) })),
      ...(page.more ? { next: encode([scope, method, channel, revision, page.entries.at(-1)!.seq, turns.map(String)]) } : {}) };
    if (Buffer.byteLength(JSON.stringify(result)) > budget) throw new OperatorFault("transfer_limit", "Tracked view exceeds the response budget");
    return result;
  }
  const limit = p.limit === undefined ? 50 : sequence(p.limit);
  if (limit < 1 || limit > 100) return bad("Expected a limit between 1 and 100");
  const cursor = p.cursor === undefined ? undefined : decode(p.cursor);
  if (cursor && (cursor.length !== 6 || cursor[0] !== scope || cursor[1] !== method || cursor[2] !== (channel ?? null)
    || p.after !== undefined || p.throughRevision !== undefined || !["older", "newer"].includes(String(cursor[3])))) return bad("Invalid history cursor");
  if ((p.after === undefined) !== (p.throughRevision === undefined) || (!channel && p.after !== undefined)) return bad("Invalid catch-up bounds");
  const after = p.after === undefined ? undefined : decode(p.after);
  if (after && (after.length !== 3 || after[0] !== scope || after[1] !== channel)) return bad("Position belongs to another session or channel");
  const direction = cursor?.[3] === "newer" || after ? "newer" : "older";
  const throughRevision = cursor ? sequence(cursor[4]) : after ? sequence(p.throughRevision) : header.revision;
  const exclusiveSeq = cursor ? sequence(cursor[5]) : after ? sequence(after[2]) : undefined;
  if (direction === "newer" && exclusiveSeq !== undefined && exclusiveSeq > throughRevision) return bad("Position exceeds revision");
  const page = readValue(storage.readTimeline({ kind: channel ? "conversation" : "timeline", channel, throughRevision, exclusiveSeq, direction, limit })).value;
  let size = 0, last = 0;
  const records = [];
  for (const entry of page.entries) {
    const participant = entry.kind === "participant_message";
    const actor = participant ? { kind: "participant", id: entry.from } : { kind: "agent", id: entry.sourceChannelId ?? scope };
    const base = { channel: entry.channelId, turnId: String(entry.turnId), actor, position: position(entry) };
    const message = entry.message;
    const content = participant && message.role === "user" ? message.content.slice(`Participant: ${JSON.stringify(entry.from)}\n\n`.length) : message.content;
    const identity = { ...base, messageId: messageId(entry), ...(participant ? { itemId: entry.itemId } : {}) };
    const activity = { ...base, ...(entry.sourceChannelId ? { sourceChannel: entry.sourceChannelId } : {}),
      kind: entry.kind ?? (message.role === "tool" ? "tool_result" : message.role === "assistant" && !message.content ? "tool_call" : "assistant_message"),
      ...(message.role === "assistant" || participant ? { messageId: messageId(entry) } : {}) };
    let record: object = channel ? { ...identity, parts: [{ type: "text", text: content }] } : { ...activity, payload: message };
    let bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (bytes > budget) {
      record = channel ? { ...identity, ...(participant ? { omitted: true } : { reference: true }) } : { ...activity, omitted: true,
        ...(message.role === "tool" && message.outcome?.reference ? { resultReference: message.outcome.reference } : {}) };
      bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
      if (bytes > budget && !channel) { record = { ...activity, omitted: true }; bytes = Buffer.byteLength(JSON.stringify(record)) + 1; }
    }
    if (size + bytes > budget) {
      if (!records.length) throw new OperatorFault("transfer_limit", "Record identity exceeds the response budget");
      break;
    }
    records.push(record); last = entry.seq; size += bytes;
  }
  const next = page.more || records.length < page.entries.length ? encode([scope, method, channel ?? null, direction, throughRevision, last]) : undefined;
  if (direction === "older") records.reverse();
  return { [channel ? "messages" : "events"]: records, ...(next ? { next } : {}) };
}
