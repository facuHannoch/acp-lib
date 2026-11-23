import type { Message, ToolDefinition } from "../../contracts/loop.ts";
import type { ContextCapture } from "../../contracts/context.ts";
import type { InspectionStorageReads } from "../../contracts/inspection.ts";
import type { StorageResult } from "../../contracts/storage.ts";
import { composeSystemPrompt } from "../../capabilities/context/load-instructions.ts";
import { buildSharedContext } from "../../capabilities/context/build.ts";

interface InspectedInference {
  number: number;
  turnId?: number;
  at: string;
  body: unknown;
  context?: Pick<ContextCapture, "estimatedInputBytes" | "omitted" | "records"> & { revision: number; offeredTools: string[]; modelCallId?: string };
  response?: Extract<Message, { role: "assistant" }> | { omitted: true };
}

const CAPTURE_LIMIT = 8;
const CAPTURE_BYTES = 128 * 1024;
function read<T>(result: StorageResult<T>) {
  if (!result.ok) throw new Error(result.error.message);
  return { ...result.value, revision: result.revision };
}

/** Capture state is process-local. A notification marks the requested view
 * dirty. Only HTTP reads request data from storage. */
export function createInspection(systemPrompt: string, tools: readonly ToolDefinition[],
  reads: InspectionStorageReads, storage: string) {
  const instructions = composeSystemPrompt(systemPrompt);
  const captures = new Map<string, { turnId: number; metadata: NonNullable<InspectedInference["context"]> }>();
  const channels = new Map<string, InspectedInference[]>();
  const listeners = new Set<() => void>();
  let stopped = false;
  const invalidate = () => { for (const listener of listeners) listener(); };
  return {
    invalidate,
    stopped() { stopped = true; invalidate(); },
    status() {
      const { revision, session, channels: status } = read(reads.readInspectionStatus());
      const execution = stopped ? "stopped" : session.lifecycle !== "running" ? session.lifecycle
        : status.some(channel => channel.turn === "running" || (channel.lifecycle === "open" && channel.pending > 0)) ? "working" : "idle";
      return { session: { sessionId: session.sessionId, lifecycle: session.lifecycle, execution, revision, storage },
        channels: status.map(channel => ({ ...channel, running: channel.turn === "running",
          ...(channel.unresolved ? { error: `Turn ${channel.unresolved.turnId} ${channel.unresolved.status}: ${channel.unresolved.reason}` } : {}) })) };
    },
    liveContext() {
      const { entries, unfinished, revision } = read(reads.readInspectionPage());
      const selected = entries.filter(entry => "message" in entry).reverse();
      return { revision, entries: selected, tools, base: buildSharedContext(selected, instructions, unfinished) };
    },
    timeline(before?: number) {
      const { entries, next, revision } = read(reads.readInspectionPage(before));
      return { entries, next, revision };
    },
    channel: (id: string) => ({ requests: structuredClone(channels.get(id) ?? []) }),
    modelCalls(id: string) {
      const result = reads.readInspectionCalls(id);
      if (!result.ok) throw new Error(result.error.message);
      return { modelCalls: result.value };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    capture(value: ContextCapture) {
      const { channelId, turnId, timelineRevision } = value.context;
      captures.set(channelId, { turnId, metadata: { revision: timelineRevision, estimatedInputBytes: value.estimatedInputBytes,
        omitted: value.omitted, records: value.records, offeredTools: value.context.tools.map(tool => tool.name) } });
    },
    modelCall(channelId: string, turnId: number, callId: string) {
      const capture = captures.get(channelId);
      if (capture?.turnId === turnId) capture.metadata.modelCallId = callId;
    },
    request(id: string, body: string, turnId?: number) {
      let requests = channels.get(id);
      if (!requests) { requests = []; channels.set(id, requests); }
      const capture = captures.get(id);
      requests.push({ ...(capture && capture.turnId === turnId ? { context: capture.metadata } : {}),
        number: (requests.at(-1)?.number ?? 0) + 1, turnId, at: new Date().toISOString(),
        body: Buffer.byteLength(body) <= CAPTURE_BYTES ? JSON.parse(body) : { omitted: true } });
      if (requests.length > CAPTURE_LIMIT) requests.shift();
      invalidate();
    },
    response(id: string, message: Extract<Message, { role: "assistant" }>) {
      const request = channels.get(id)?.at(-1);
      if (!request) return;
      request.response = Buffer.byteLength(JSON.stringify(message)) <= CAPTURE_BYTES ? structuredClone(message) : { omitted: true };
      invalidate();
    },
  };
}

export type Inspection = ReturnType<typeof createInspection>;
