import { attachmentView } from "../../contracts/attachments.ts";
import { OperatorFault, operatorMethods, operatorRead, readValue } from "./operator.ts";
import type { ProtocolEndpoint, RpcRequest, RpcResponse, RpcNotification, RpcSessionNotification, ProtocolConfig, Description, Subscription, DurableErrorCode } from "../../contracts/protocol.ts";
import type { PersistentSession } from "../../contracts/session.ts";
import type { SessionArchive, StorageResult, StoredSession } from "../../contracts/storage.ts";
import type { SessionFilePayload } from "../../contracts/session-file.ts";
import { SessionFileError, validateConfig } from "../../state/storage/session-file.ts";
import { validateManagedConfig } from "../../runtime/config/managed.ts";
import { MAX_FRAME_BYTES } from "./framing.ts";
import { FrameLimit, turnStatus, wireStatus } from "./load.ts";
import { TransferFault, createTransfers, decodeArchive, encodeArchive, readArchiveFile, writeArchiveFile, TRANSFER_LIMITS } from "./transfers.ts";
import type { ChannelChangeResult, PendingChannelChange, TransferLimits } from "../../contracts/protocol.ts";
import { ChannelChangeFault, applyChannelChanges, checkPolicies, parseChannelChanges, sameBatch } from "./channel-changes.ts";
import type { RpcCallbackCancel, RpcCallbackRequest } from "../../contracts/protocol.ts";
import type { ToolCatalogInput } from "../../contracts/tools.ts";
import { CatalogError, parseCatalog, sameCatalog } from "../../capabilities/tools/runtime/catalog.ts";
import { ToolFault, createCallbackBridge, isToolMethod, toolMethods, toolRequest } from "./functions.ts";

import { parseReminderBatch, parseReminderChange, parseReminderList, ReminderShapeError } from "../../runtime/reminder-validation.ts";
import { REMINDER_LIMITS } from "../../util/reminder-schedule.ts";
import type { ReminderChange, ReminderChangeResult, ReminderSessionEvent } from "../../contracts/reminders.ts";
import type { createManagedAttachmentService } from "../../capabilities/attachments/service.ts";
import { AttachmentServiceError } from "../../capabilities/attachments/service.ts";
import { UploadError } from "../../capabilities/attachments/upload.ts";
import { AttachmentReadError } from "../../capabilities/attachments/read.ts";
import { AttachmentInputError, validateMixedParts } from "../../util/attachment-input.ts";
import type { InputPart } from "../../contracts/attachments.ts";
import { ATTACHMENT_LIMITS } from "../../contracts/attachments.ts";

class Fault extends Error {
  constructor(readonly tag: string, message: string, readonly rpc = -32602, readonly expectedOffset?: number) { super(message); }
}
/** Thrown by a session factory to report a typed storage or lifecycle refusal. */
export class SessionOpenError extends Error {
  constructor(readonly code: DurableErrorCode, message: string) { super(message); }
}
export interface SessionRequest { mode: "create" | "open"; sessionId: string; config?: ProtocolConfig; mcpRuntimeHeaders?: unknown;
  /** Decision 0021: a catalog whose shape is valid. The factory checks its names
   * against its built-in tools and passes it to the session. */
  tools?: ToolCatalogInput }
/** `close` releases storage ownership; the endpoint calls it when it is disposed
 * or when a load cannot be answered. */
export interface OpenedSession {
  session: PersistentSession; close(): void;
  config?: ProtocolConfig;
  /** Persist the chosen config only after the response can be produced. */
  commitConfig?(): void;
  /** One consistent logical copy, or `busy`. */
  exportArchive?(): StorageResult<SessionArchive>;
  attachments?: ReturnType<typeof createManagedAttachmentService>;
  imageInput?: boolean;
  webUnavailable?: import("../../contracts/web.ts").WebUnavailable;
  mcpStatus?(): Record<string, import("../../contracts/mcp.ts").McpServerStatus>;
  stopMcp?(): Promise<void>;
}
export interface ProtocolServerOptions {
  durable?: boolean;
  /** Publish a validated archive as a new session with this ID. Enables import. */
  importArchive?(payload: SessionFilePayload<SessionArchive>, sessionId: string): StorageResult<StoredSession>;
  /** Where transfer files live while a transfer is open. Enables transfers. */
  transferDirectory?: string;
  /** Smaller limits for tests; defaults are the contract's. */
  limits?: Partial<{ chunkBytes: number; maxBytes: number; idleMs: number }>;
  /** Decision 0021: the session factory accepts tool catalogs. */
  functions?: boolean;
  attachments?: boolean;
  mcpStdio?: boolean;
  mcpHttps?: boolean;
}

const bad = (message: string): never => { throw new Fault("invalid_params", message); };
function obj(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("Expected an object");
  return value as Record<string, any>;
}
function keys(value: Record<string, unknown>, names: string[]) {
  for (const name of Object.keys(value)) if (!names.includes(name)) bad(`Unsupported field: ${name}`);
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) bad("Expected a nonempty string");
  return value as string;
}
function count(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000) bad("Expected a limit between 1 and 1000");
  return value as number;
}
/** Capabilities describe this server instance: durable acceptance and load are
 * advertised only when its sessions are opened from durable storage. */
export function describe(durable: boolean, archives = false, functions = false, attachments = false): Description {
  return {
    ...(attachments ? { attachmentLimits: { fileBytes: ATTACHMENT_LIMITS.fileBytes, chunkBytes: ATTACHMENT_LIMITS.chunkBytes, openUploads: ATTACHMENT_LIMITS.openUploads, uploadIdleMs: ATTACHMENT_LIMITS.uploadIdleMs } } : {}),
    reminderLimits: { ...REMINDER_LIMITS, maxActiveRoutinesPerChannel: 20, maxRoutineCatchUp: 10 },
    configOptions: [], commands: [], policies: [],
    capabilities: { experimental: true, acceptance: durable ? "durable" : "memory", persistence: durable, startupChannelChanges: true, reminders: true, routines: true, unattendedTurnGuard: true, ...(functions ? { functions: true as const } : {}), ...(attachments ? { managedAttachments: true as const, orderedParts: true as const } : {}),
      methods: ["initialize", "config/validate", "session/create", ...(durable ? ["session/open"] : []), ...operatorMethods, "session/status", "reminder/change", "reminder/get", "reminder/list",
        "session/model-calls", "session/message/read", "session/suspend", "session/resume", "session/stop", "channel/push", "channel/notify", "channel/create", "channel/edit", "channel/suspend", "channel/resume", "channel/delete", "channel/withdraw", "channel/interrupt", "approval/respond", "session/idle",
        ...(archives ? ["session/export", "session/import", "transfer/open", "transfer/write", "transfer/read", "transfer/close"] : []), ...(functions ? toolMethods() : []), ...(attachments ? ["attachment/begin", "attachment/write", "attachment/status", "attachment/finalize", "attachment/abort", "attachment/read"] : [])],
      events: ["turn_started", "turn_took", "items_receipt", "text_delta", "text_gap", "text_incomplete", "tool_call", "message_completed", "turn_suspended", "turn_resumed", "turn_ended", "channel_state", "item_withdrawn", "approval_requested", "approval_closed", "reminder_changed", "reminder_fired", "reminder_expired", "reminder_cancelled", "routine_disposition", "routine_migration_blocked", "session/event"] },
  };
}

export function createProtocolServer(open: (request: SessionRequest) => Promise<OpenedSession>, options: ProtocolServerOptions = {}): ProtocolEndpoint & { dispose(): Promise<void> } {
  const limits = { ...TRANSFER_LIMITS, ...options.limits } as TransferLimits;
  const transfers = options.importArchive && options.transferDirectory ? createTransfers(options.transferDirectory, limits) : undefined;
  const description = describe(!!options.durable, !!transfers, !!options.functions, !!options.attachments);
  if (options.mcpStdio) description.capabilities.mcpServers = { stdio: true, http: !!options.mcpHttps, sse: false };
  let initialized = false;
  let approvalConsumer = false;
  let opening = false;
  let current: OpenedSession | undefined;
  // Decision 0020: the batch this connection's open applied, kept so a repeated
  // load reports the same results without applying anything again.
  let startup: { batch: PendingChannelChange[]; results: ChannelChangeResult[] } | undefined;
  let reminderStartup: { batch: ReminderChange[]; results: ReminderChangeResult[] } | undefined;
  let activeConfig: ProtocolConfig | undefined;
  let subscription: Subscription = { text: "final", tools: "full" };
  const listeners = new Set<(notification: RpcNotification) => void>();
  const sessionListeners = new Set<(notification: RpcSessionNotification) => void>();
  // While a load response is on its way out, later notifications wait behind it.
  let held: (() => void)[] | undefined;
  const publish = (deliver: () => void) => { if (held) held.push(deliver); else deliver(); };
  // Decision 0021: callbacks to this connection's host share the event order.
  const callbackListeners = new Set<(message: RpcCallbackRequest | RpcCallbackCancel) => void>();
  const bridge = createCallbackBridge(message => publish(() => { for (const listener of callbackListeners) listener(structuredClone(message)); }));
  let served: string[] | undefined, startupTools: ToolCatalogInput | undefined;
  const catalogOf = (raw: unknown) => {
    if (raw === undefined) return undefined;
    if (!options.functions) bad("This server does not accept tool catalogs");
    try {
      const parsed = parseCatalog(raw, []);
      if (parsed.catalog.some(tool => tool.name.startsWith("mcp__"))) bad("MCP tool names are reserved");
      return parsed;
    } catch (error) { throw error instanceof CatalogError ? new Fault(error.code, error.message) : error; }
  };

  async function attach(request: SessionRequest): Promise<OpenedSession> {
    if (current || opening) throw new Fault("already_exists", "One session per endpoint");
    opening = true;
    let opened: OpenedSession;
    // On success `opening` stays set: the caller clears it once the session is
    // published as `current` (or abandoned), leaving no gap for a second open.
    try { opened = await open(request); }
    catch (error) { opening = false; throw error instanceof SessionOpenError || error instanceof CatalogError ? new Fault(error.code, error.message) : new Fault("invalid_config", String(error)); }
    // Handlers are bound before any recovered work can start.
    opened.session.tools?.serve(served ?? [], served ? bridge.executor : undefined);
    startupTools = request.tools;
    opened.session.subscribe(value => {
      const event = structuredClone(value);
      if (!approvalConsumer && (event.event.type === "approval_requested" || event.event.type === "approval_closed")) return;
      // Filtering is downstream of inference and its retry cutoff: a final-mode
      // consumer must never see ephemeral stream events it cannot interpret.
      if (subscription.text === "final" && (event.event.type === "text_delta" || event.event.type === "text_gap" || event.event.type === "text_incomplete")) return;
      if (event.event.type === "message_completed" && event.event.parts && new TextEncoder().encode(JSON.stringify(event)).length > MAX_FRAME_BYTES - 1024) {
        const { parts: _parts, ...completion } = event.event;
        event.event = { ...completion, reference: true };
      }
      if (event.event.type === "tool_call") {
        if (subscription.tools === "none") return;
        if (subscription.tools === "summary") { delete event.event.input; delete event.event.output; }
      }
      const message: RpcNotification = { jsonrpc: "2.0", method: "channel/event", params: event };
      publish(() => { for (const listener of listeners) { try { listener(structuredClone(message)); } catch { /* Isolate clients. */ } } });
    });
    const sendSession = (event: Parameters<Parameters<PersistentSession["subscribeSession"]>[0]>[0] | ReminderSessionEvent) => {
      const message: RpcSessionNotification = { jsonrpc: "2.0", method: "session/event", params: event };
      publish(() => { for (const listener of sessionListeners) { try { listener(structuredClone(message)); } catch { /* Isolate clients. */ } } });
    };
    opened.session.subscribeSession(sendSession);
    opened.session.reminders?.subscribeWake(sendSession);
    opened.session.approvals.setConsumer(approvalConsumer);
    activeConfig = structuredClone(opened.config ?? request.config);
    return opened;
  }

  /** Apply the open's batch to a session that is attached but not started.
   * `opening` stays set by the caller until the session is published as
   * `current`, so no other request can reach the session, or open a second
   * one, while a suspension is awaited. The returned function applies the
   * resumes and must run in the same synchronous block as the load view. */
  async function prepare(opened: OpenedSession, batch: PendingChannelChange[]) {
    checkPolicies(batch, Object.keys(activeConfig?.policies ?? { __legacy_allow: true }));
    return applyChannelChanges(opened.session, batch);
  }
  /** An open that fails after attaching releases the session. With a batch,
   * stop first: a resume in it may already have handed a turn to an executor. */
  async function abandon(opened: OpenedSession, batch: boolean) {
    if (batch) { try { opened.session.stop("Open failed"); } catch { /* Storage may be the failure. */ } }
    try { await opened.stopMcp?.(); } finally { opened.close(); }
  }

  /** Read one snapshot, then keep every later notification behind the response.
   * The response is handed to the transport in a microtask after this request
   * resolves; a timer runs after all of those, so releasing held notifications
   * (and, for a first load, starting execution) there places them after it. */
  function ready(opened: OpenedSession) {
    const reads = opened.session.operatorReads;
    if (!reads) throw new Fault("invalid_state", "Focused reads are unavailable");
    const { value, revision } = readValue(reads.readSession());
    const image = opened.imageInput && (opened.session.reminders?.executable() ?? true)
      ? { imageInput: true as const, imageLimits: { formats: ["image/png", "image/jpeg", "image/webp"], fileBytes: ATTACHMENT_LIMITS.fileBytes,
        turnBytes: ATTACHMENT_LIMITS.imageBytesPerTurn, maxImages: ATTACHMENT_LIMITS.references, maxSide: ATTACHMENT_LIMITS.imageSide, maxPixels: ATTACHMENT_LIMITS.imagePixels } } : {};
    return { sessionId: value.sessionId, lifecycle: value.lifecycle, revision, ...image, ...(opened.webUnavailable ? { webUnavailable: opened.webUnavailable } : {}), ...(opened.mcpStatus ? { mcpServers: opened.mcpStatus() } : {}) };
  }

  function holdAfterResponse(start?: () => void) {
    if (held) { if (start) held.push(start); return; }
    held = [];
    setTimeout(() => {
      const waiting = held ?? []; held = undefined;
      for (const deliver of waiting) deliver();
      start?.();
    }, 0);
  }

  function reminderView(session: PersistentSession, results: ReminderChangeResult[] = []) {
    const reminders = session.reminders;
    if (!reminders) return {};
    const page = readValue(reminders.listReminders({})).value;
    const guard = reminders.executable() ? readValue(reminders.unattendedGuard()).value : undefined;
    return { reminderChanges: results, reminders: page.reminders, ...(page.next ? { remindersNext: page.next } : {}),
      ...(reminders.executable() ? readValue(reminders.reminderWake()).value : {}),
      ...(reminders.executable() ? { unattendedTurnGuard: guard === undefined ? null : { maxConsecutiveTurns: guard } } : {}) };
  }

  function prepareReminders(session: PersistentSession, batch: ReminderChange[]) {
    const reminders = session.reminders;
    if (batch.length && !reminders?.executable()) throw new Fault("incompatible", "Reminders cannot change in an inspection-only session");
    const results = batch.map(change => readValue(reminders!.change(change)).value);
    reminders?.processStartup();
    const view = reminderView(session, results);
    reminderStartup = { batch, results };
    return view;
  }

  async function dispatch(method: string, raw: unknown): Promise<unknown> {
    if (!description.capabilities.methods.includes(method)) throw new Fault("method_not_found", `Unsupported method: ${method}`, -32601);
    const p = obj(raw);
    if (method === "initialize") {
      keys(p, ["protocolVersion", "host", "callbacks", "subscription", "approval", "functions"]);
      if (p.protocolVersion !== 1) throw new Fault("version_mismatch", "Only experimental protocol version 1 is supported");
      if (initialized) throw new Fault("already_exists", "Already initialized");
      const host = obj(p.host); keys(host, ["name", "version"]); text(host.name); text(host.version);
      const callbacks = Array.isArray(p.callbacks) && (p.callbacks.length === 0 || (options.functions && p.callbacks.length === 1 && p.callbacks[0] === "functions/call"));
      if (!callbacks) bad(options.functions ? "The only supported host callback is functions/call" : "Host callbacks are not supported yet");
      const handlers = p.functions === undefined ? [] : p.functions;
      if (!Array.isArray(handlers) || handlers.some((name: unknown) => typeof name !== "string" || !name.trim()) || new Set(handlers).size !== handlers.length) bad("functions must list distinct handler names");
      if (handlers.length && !p.callbacks.length) bad("functions needs the functions/call callback");
      served = p.callbacks.length ? [...handlers] : undefined;
      const sub = obj(p.subscription); keys(sub, ["text", "tools"]);
      if (!["final", "stream"].includes(sub.text) || !["none", "summary", "full"].includes(sub.tools)) bad("Only final/stream text and none/summary/full tools are supported");
      subscription = { text: sub.text, tools: sub.tools };
      approvalConsumer = p.approval === true;
      initialized = true;
      return { protocolVersion: 1, harness: { version: "0.0.0" }, description };
    }
    if (!initialized) throw new Fault("not_ready", "Initialize first");
    if (method === "config/validate") {
      keys(p, ["config"]);
      try { validateManagedConfig(p.config); } catch (error) { throw new Fault("invalid_config", String(error)); }
      return { valid: true };
    }
    if (method === "session/create") {
      keys(p, ["sessionId", "config", "participants", "channels", "channelChanges", "tools", "reminderChanges", "mcpRuntimeHeaders"]);
      const reminderBatch = parseReminderBatch(p.reminderChanges);
      const tools = catalogOf(p.tools);
      const sessionId = text(p.sessionId);
      if (current || opening) throw new Fault("already_exists", "One session per endpoint");
      if (p.config !== undefined) { try { validateManagedConfig(p.config); } catch (error) { throw new Fault("invalid_config", String(error)); } }
      if (!Array.isArray(p.participants)) bad("participants must be an array");
      const ids = new Set<string>();
      for (const value of p.participants) {
        const participant = obj(value); keys(participant, ["id", "kind"]); const id = text(participant.id);
        if (ids.has(id) || !["person", "agent", "worker", "host"].includes(participant.kind)) bad("Invalid or duplicate participant");
        ids.add(id);
      }
      if (Object.keys(obj(p.channels)).length) bad("Initial channel settings are not supported; channels are created on push");
      // Reject an invalid batch before the session exists. Policy names are
      // checked here when the configuration is inline, and again once the
      // effective configuration is known.
      const batch = p.channelChanges === undefined ? undefined : parseChannelChanges(p.channelChanges);
      if (batch && p.config?.policies) checkPolicies(batch, Object.keys(p.config.policies));
      const opened = await attach({ mode: "create", sessionId, config: p.config, mcpRuntimeHeaders: p.mcpRuntimeHeaders, ...(tools ? { tools } : {}) });
      let results: ChannelChangeResult[] | undefined;
      let reminderResult: ReturnType<typeof reminderView>;
      try {
        const finish = batch && await prepare(opened, batch);
        opened.commitConfig?.();
        if (opened.session.reminders) holdAfterResponse();
        results = finish?.();
        reminderResult = prepareReminders(opened.session, reminderBatch);
        current = opened;
        if (batch) startup = { batch, results: results! };
      } catch (error) { try { await abandon(opened, !!batch); } catch { /* Preserve startup failure. */ } throw error; }
      finally { opening = false; }
      if (batch?.length || opened.session.reminders) holdAfterResponse(() => { if (current === opened) opened.session.start(); });
      else opened.session.start();
      return { ...(opened.session.operatorReads ? ready(opened) : { sessionId }), ...reminderResult, ...(results ? { channelChanges: results } : {}) };
    }
    if (method === "session/open") {
      keys(p, ["sessionId", "config", "channelChanges", "tools", "reminderChanges", "mcpRuntimeHeaders"]);
      const reminderBatch = parseReminderBatch(p.reminderChanges);
      const tools = catalogOf(p.tools);
      const sessionId = text(p.sessionId);
      const batch = p.channelChanges === undefined ? undefined : parseChannelChanges(p.channelChanges);
      // A repeated load of the open session is a fresh view of it, nothing more:
      // the batch was applied by the open and is only reported again. A new
      // batch belongs to the live channel API.
      if (current) {
        if (p.mcpRuntimeHeaders !== undefined) bad("Runtime material requires a new executable open");
        if (ready(current).sessionId !== sessionId) throw new Fault("already_exists", "One session per endpoint");
        if (batch && !sameBatch(startup?.batch ?? [], batch)) throw new Fault("invalid_state", "The session is already open; send newer channel changes through the channel methods");
        if (tools && !(startupTools && sameCatalog(startupTools, tools))) throw new Fault("invalid_state", "The session is already open with another tool catalog; use the tool methods");
        if (p.reminderChanges !== undefined && JSON.stringify(reminderBatch) !== JSON.stringify(reminderStartup?.batch ?? [])) throw new Fault("invalid_state", "The session is already open; send changes through reminder/change");
        return { ...ready(current), ...reminderView(current.session, reminderStartup?.results), ...(startup ? { channelChanges: startup.results } : {}) };
      }
      const opened = await attach({ mode: "open", sessionId, config: p.config, mcpRuntimeHeaders: p.mcpRuntimeHeaders, ...(tools ? { tools } : {}) });
      try {
        const finish = batch && await prepare(opened, batch);
        // From here to the end of the block nothing is awaited: the resumes, the
        // view and the hold on later notifications are one synchronous step.
        if (opened.session.reminders) holdAfterResponse();
        const results = finish?.();
        opened.commitConfig?.();
        const reminderResult = prepareReminders(opened.session, reminderBatch);
        const result = ready(opened);
        holdAfterResponse(() => { if (current === opened) opened.session.start(); });
        current = opened;
        if (batch) startup = { batch, results: results! };
        return { ...result, ...reminderResult, ...(results ? { channelChanges: results } : {}) };
      }
      // Work was not started; release the session so no partial load is observable.
      catch (error) { try { await abandon(opened, !!batch); } catch { /* Preserve startup failure. */ } throw error; }
      finally { opening = false; }
    }
    if (transfers && method.startsWith("transfer/")) {
      if (method === "transfer/open") { keys(p, ["bytes", "sha256"]); return { transferId: transfers.openUpload(p.bytes, p.sha256), limits }; }
      if (method === "transfer/write") { keys(p, ["transferId", "offset", "data"]); return { received: transfers.write(p.transferId, p.offset, p.data) }; }
      if (method === "transfer/read") { keys(p, ["transferId", "offset"]); return transfers.read(p.transferId, p.offset); }
      keys(p, ["transferId"]); transfers.close(p.transferId); return {};
    }
    if (transfers && method === "session/import") {
      keys(p, ["from", "sessionId"]);
      const from = obj(p.from);
      if (p.sessionId !== undefined) text(p.sessionId);
      // Whole file first, whole validation next, and only then one atomic publish.
      let bytes: Uint8Array;
      if (from.type === "path") { keys(from, ["type", "path"]); bytes = readArchiveFile(text(from.path), limits.maxBytes); }
      else if (from.type === "transfer") { keys(from, ["type", "transferId"]); bytes = transfers.consume(from.transferId); }
      else return bad("Import source must be a path or a transfer");
      const payload = decodeArchive(bytes, limits.maxBytes) as SessionFilePayload<SessionArchive>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).sort().join() !== "archive,config" || ![2, 3, 4, 5, 6, 7, 8].includes(payload.archive?.archiveVersion))
        throw new Fault("invalid_archive", "Invalid session file payload");
      try { validateConfig(payload.config, (payload.archive as { archiveVersion: number }).archiveVersion === 2); } catch (error) { throw new Fault("invalid_archive", String(error)); }
      const sessionId = p.sessionId ?? payload.archive?.snapshot?.session?.sessionId;
      if (typeof sessionId !== "string" || !sessionId.trim()) throw new Fault("invalid_archive", "Archive does not name a session");
      const imported = options.importArchive!(payload, sessionId);
      if (!imported.ok) throw new Fault(imported.error.code === "invalid_input" ? "invalid_params" : imported.error.code, imported.error.message);
      return { sessionId: imported.value.sessionId, lifecycle: imported.value.lifecycle, revision: imported.revision };
    }
    if (method === "channel/notify") {
      keys(p, ["channel", "notice"]);
      const channel = text(p.channel), notice = obj(p.notice);
      keys(notice, ["id", "text", "source", "policyNames"]);
      const id = text(notice.id), content = text(notice.text);
      const source = notice.source === undefined ? undefined : text(notice.source);
      if (!Array.isArray(notice.policyNames)) bad("Expected a policy name array");
      const policyNames = notice.policyNames.map((name: unknown) => text(name));
      if (!current) throw new Fault("invalid_state", "Open a session first");
      const session = current.session;
      const result = session.agent.notifyExternal({ channelId: channel, itemId: id, text: content, source, policyNames });
      if (!result.accepted) throw new Fault(result.code === "invalid_input" ? "invalid_params" : result.code, result.error);
      const saved = session.operatorReads
        ? readValue(session.operatorReads.readTracked(channel, [id], [])).value.items[0]
        : session.snapshot().items.find(item => item.itemId === id);
      return { accepted: true, duplicate: result.duplicate, item: { id, channel, kind: "external_notice", sender: source ?? "host",
        ...(source === undefined ? {} : { externalSource: source }), ...(saved?.policy ? { policy: saved.policy } : {}),
        milestone: result.milestone, ...(result.turnId === undefined ? {} : { turnId: String(result.turnId) }) } };
    }
    if (!current) throw new Fault("not_ready", "Create or load a session first");
    if (method.startsWith("attachment/")) {
      const service = current.attachments;
      if (!service) throw new Fault("incompatible", "Managed attachments are unavailable");
      const channel = text(p.channel);
      if (method === "attachment/begin") {
        keys(p, ["channel", "filename", "mediaType", "bytes", "sha256"]);
        return service.begin({ channel, filename: p.filename, mediaType: text(p.mediaType), bytes: p.bytes, sha256: text(p.sha256) });
      }
      if (method === "attachment/read") { keys(p, ["channel", "id", "offset"]); return service.read(channel, text(p.id), p.offset); }
      const uploadId = text(p.uploadId);
      if (method === "attachment/status") { keys(p, ["channel", "uploadId"]); return service.status(channel, uploadId); }
      if (method === "attachment/write") { keys(p, ["channel", "uploadId", "offset", "data"]); return service.write(channel, uploadId, p.offset, text(p.data)); }
      if (method === "attachment/finalize") { keys(p, ["channel", "uploadId"]); return service.finalize(channel, uploadId); }
      if (method === "attachment/abort") { keys(p, ["channel", "uploadId"]); service.abort(channel, uploadId); return {}; }
    }
    if (transfers && method === "session/export") {
      keys(p, ["to"]);
      const to = obj(p.to);
      if (to.type === "path") { keys(to, ["type", "path"]); text(to.path); }
      else if (to.type === "transfer") keys(to, ["type"]);
      else bad("Export destination must be a path or a transfer");
      const exported = current.exportArchive?.() ?? { ok: false as const, error: { code: "invalid_state" as const, message: "This session cannot be exported" } };
      if (!exported.ok) throw new Fault(exported.error.code, exported.error.message);
      const { bytes, sha256 } = encodeArchive({ archive: exported.value, config: activeConfig! }, limits.maxBytes);
      if (to.type === "path") { writeArchiveFile(to.path, bytes); return { bytes: bytes.length, sha256 }; }
      return { bytes: bytes.length, sha256, transferId: transfers.offer(bytes, sha256) };
    }
    const session = current.session;
    if (operatorMethods.some(name => name === method)) {
      const allowed = method === "channel/observe" ? ["channel"] : method === "channel/reconcile" ? ["channel", "itemIds", "turnIds", "cursor"]
        : method === "channel/messages" ? ["channel", "limit", "cursor", "after", "throughRevision"] : ["limit", "cursor"];
      keys(p, allowed);
      const result = operatorRead(session, method, p, approvalConsumer);
      if (method === "channel/observe") holdAfterResponse();
      return result;
    }
    if (isToolMethod(method)) return toolRequest(session, method, p);
    if (method === "approval/respond") {
      keys(p, ["requestId", "decision"]);
      if (!approvalConsumer) throw new Fault("invalid_state", "Connection has no approval authority");
      if (p.decision !== "allow_once" && p.decision !== "deny") bad("Expected allow_once or deny");
      if (!session.approvals.respond(text(p.requestId), p.decision)) throw new Fault("not_found", "Approval request is no longer available");
      return { accepted: true };
    }
    if (method.startsWith("channel/") && method !== "channel/push" && method !== "channel/notify") {
      const channel = text(p.channel);
      let result;
      if (method === "channel/create") {
        keys(p, ["channel", "displayName", "policy"]);
        result = session.channels.create({ channelId: channel, ...(p.displayName === undefined ? {} : { displayName: text(p.displayName) }), ...(p.policy === undefined ? {} : { policy: text(p.policy) }) });
      } else if (method === "channel/edit") {
        keys(p, ["channel", "displayName", "policy"]);
        result = session.channels.edit(channel, p.displayName === null ? null : text(p.displayName), p.policy === undefined || p.policy === null ? p.policy : text(p.policy));
      } else if (method === "channel/suspend") {
        keys(p, ["channel"]); result = await session.channels.suspend(channel);
      } else if (method === "channel/resume") {
        keys(p, ["channel"]); result = session.channels.resume(channel);
      } else if (method === "channel/delete") {
        keys(p, ["channel"]); result = session.channels.delete(channel);
      } else if (method === "channel/withdraw") {
        keys(p, ["channel", "item"]); const outcome = session.channels.withdraw(channel, text(p.item));
        if (!outcome.ok) throw new Fault(outcome.error.code, outcome.error.message);
        const { item } = outcome.value;
        return { outcome: outcome.value.outcome, item: { id: item.itemId, channel: item.channelId, kind: item.kind, sender: item.senderId, milestone: item.milestone,
          ...(item.policy === undefined ? {} : { policy: item.policy }),
          ...(item.turnId === undefined ? {} : { turnId: String(item.turnId) }) },
          ...(outcome.value.outcome === "withdrawn" ? { repeated: outcome.value.repeated } : {}) };
      } else {
        keys(p, ["channel", "turn", "reason"]); const rawTurn = text(p.turn), turn = Number(rawTurn);
        if (!Number.isSafeInteger(turn) || turn < 1 || String(turn) !== rawTurn) bad("Expected a turn ID");
        const outcome = session.channels.interrupt(channel, turn, p.reason === undefined ? undefined : text(p.reason));
        if (!outcome.ok) throw new Fault(outcome.error.code, outcome.error.message);
        return { interrupted: outcome.value.interrupted, turn: turnStatus(outcome.value.turn) };
      }
      if (!result.ok) throw new Fault(result.error.code, result.error.message);
      const status = wireStatus(session.status(), session.operatorReads ? readValue(session.operatorReads.readExecution()).value : session.snapshot()).channels.find(value => value.channel === channel)!;
      return { channel: status, ...(method === "channel/create" ? { created: (result.value as { created: boolean }).created } : {}) };
    }
    if (method === "session/idle") { keys(p, []); return { idle: session.agent.idle() && session.status().execution !== "working" }; }
    if (method === "session/status") {
      keys(p, []);
      return { ...wireStatus(session.status(), session.operatorReads ? readValue(session.operatorReads.readExecution()).value : session.snapshot()),
        ...(current.webUnavailable ? { webUnavailable: current.webUnavailable } : {}),
        ...(current.mcpStatus ? { mcpServers: current.mcpStatus() } : {}) };
    }
    if (method === "session/suspend" || method === "session/resume") {
      keys(p, []);
      // Suspend answers only once `suspended` is committed, after in-flight
      // iterations settle; a refusal changes nothing and consumes nothing.
      const outcome = method === "session/suspend" ? await session.suspend() : session.resume();
      if (!outcome.ok) throw new Fault(outcome.error.code, outcome.error.message);
      return wireStatus(outcome.status, session.operatorReads ? readValue(session.operatorReads.readExecution()).value : session.snapshot());
    }
    if (method.startsWith("reminder/")) {
      const reminders = session.reminders;
      if (!reminders) throw new Fault("invalid_state", "Reminders are unavailable");
      if (method === "reminder/list") return readValue(reminders.listReminders(parseReminderList(p))).value;
      if (method === "reminder/get") {
        keys(p, ["id"]);
        const reminder = readValue(reminders.readReminder(text(p.id))).value;
        if (!reminder) throw new Fault("not_found", "Unknown reminder");
        return { reminder };
      }
      if (!reminders.executable()) throw new Fault("incompatible", "Reminders cannot change in this session");
      return readValue(reminders.change(parseReminderChange(p))).value;
    }
    if (method === "session/stop" && Object.keys(p).length) {
      keys(p, ["ifIdle", "unlessDueWithinMs"]);
      const windowMs = p.unlessDueWithinMs ?? 0;
      if (p.ifIdle !== true || p.unlessDueWithinMs === null || !Number.isSafeInteger(windowMs) || windowMs < 0) bad("Invalid conditional stop");
      if (!session.reminders) throw new Fault("invalid_state", "Conditional stop is unavailable");
      return session.reminders.conditionalStop(windowMs);
    }
    if (method === "session/stop") {
      keys(p, []);
      const status = session.stop("Stopped by the host");
      await current.stopMcp?.();
      return wireStatus(status, session.operatorReads ? readValue(session.operatorReads.readExecution()).value : session.snapshot());
    }
    if (method === "session/model-calls") {
      keys(p, ["after", "limit"]);
      const after = p.after === undefined ? undefined : text(p.after);
      const limit = p.limit === undefined ? 100 : count(p.limit, 100); if (limit > 100) bad("Limit exceeds 100");
      const { calls, next } = readValue(session.readModelCalls(after, limit)).value;
      const page = []; let bytes = 0;
      for (const call of calls) {
        const size = new TextEncoder().encode(JSON.stringify(call)).length + 1;
        if (size > MAX_FRAME_BYTES - 1024) {
          if (page.length) break;
          throw new Fault("transfer_limit", "Call summary exceeds frame limit");
        }
        if (bytes + size > MAX_FRAME_BYTES - 1024) break;
        page.push(call); bytes += size;
      }
      return { calls: page, ...(next !== undefined || page.length < calls.length ? { next: page.at(-1)!.callId } : {}) };
    }
    if (method === "session/message/read") {
      keys(p, ["messageId", "offset"]); const id = text(p.messageId), offset = p.offset;
      if (!Number.isSafeInteger(offset) || offset < 0) bad("Invalid byte offset");
      const entry = session.snapshot().timeline.find(value => (value.messageId ?? String(value.seq)) === id && value.message.role === "assistant");
      if (!entry || entry.message.role !== "assistant" || entry.message.content === null) throw new Fault("not_found", "Unknown text message");
      const bytes = new TextEncoder().encode(entry.message.content); if (offset > bytes.length) bad("Invalid byte offset");
      const end = Math.min(bytes.length, offset + 524288);
      return { messageId: id, offset, data: Buffer.from(bytes.subarray(offset, end)).toString("base64"), ...(end < bytes.length ? { nextOffset: end } : {}) };
    }
    keys(p, ["channel", "item"]);
    const channel = text(p.channel), item = obj(p.item);
    keys(item, ["id", "kind", "sender", "content", "policy", "delivery", "wake"]);
    const id = text(item.id), sender = text(item.sender);
    // One delivery behavior: the two legacy fields are checked, then ignored.
    if (item.kind !== "user_message" || (item.delivery !== undefined && item.delivery !== "queue") || (item.wake !== undefined && item.wake !== true)) bad("Only waking, queued user messages are supported");
    if (!Array.isArray(item.content) || !item.content.length) bad("Expected text parts");
    const mixed = item.content.some((value: unknown) => !!value && typeof value === "object" && (value as { type?: unknown }).type === "attachment");
    const parts: InputPart[] = mixed ? validateMixedParts(item.content) : item.content.map((value: unknown) => { const part = obj(value); keys(part, ["type", "text"]);
      if (part.type !== "text") bad("Only text parts are supported"); return { type: "text" as const, text: text(part.text) }; });
    // send returns once the item is committed to the inbox (Received) or
    // refused. It never waits for inference; the outcome arrives as events.
    const result = session.agent.send({ channelId: channel, participantId: sender, itemId: id, ...(item.policy == null ? {} : { policy: text(item.policy) }),
      text: parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"), ...(mixed ? { parts } : {}) });
    if (!result.accepted) throw new Fault(result.code === "invalid_input" ? "invalid_params" : result.code, result.error);
    const saved = session.operatorReads
      ? readValue(session.operatorReads.readTracked(channel, [id], [])).value.items[0]
      : session.snapshot().items.find(value => value.itemId === id);
    const policy = saved?.policy;
    return { accepted: true, duplicate: result.duplicate, item: { id, channel, kind: "participant_message", sender, milestone: result.milestone,
      ...(policy === undefined ? {} : { policy }),
      ...(saved?.parts ? { parts: attachmentView(saved.parts, session.operatorReads?.readManagedAttachment, { ownerChannel: channel }) } : {}),
      ...(result.turnId === undefined ? {} : { turnId: String(result.turnId) }) } };
  }
  return {
    async request(request: RpcRequest): Promise<RpcResponse> {
      const id = request && Number.isSafeInteger(request.id) ? request.id : null;
      try {
        if (!request || request.jsonrpc !== "2.0" || !Number.isSafeInteger(request.id) || typeof request.method !== "string") throw new Fault("invalid_request", "Invalid request envelope", -32600);
        const result = await dispatch(request.method, request.params);
        return { jsonrpc: "2.0", id: request.id, result };
      } catch (error) {
        const fault = error instanceof FrameLimit ? new Fault("transfer_limit", error.message)
          : error instanceof ReminderShapeError || error instanceof AttachmentInputError ? new Fault(error instanceof AttachmentInputError ? error.code : "invalid_params", error.message)
          : error instanceof UploadError ? new Fault(error.code, error.message, -32602, error.expectedOffset)
          : error instanceof AttachmentReadError || error instanceof AttachmentServiceError ? new Fault(error.code, error.message)
          : error instanceof TransferFault || error instanceof SessionFileError || error instanceof OperatorFault || error instanceof ChannelChangeFault || error instanceof ToolFault ? new Fault(error.code, error.message) : error;
        return { jsonrpc: "2.0", id, error: { code: fault instanceof Fault ? fault.rpc : -32603,
          message: String(fault), data: { code: fault instanceof Fault ? fault.tag : "internal_error", ...(fault instanceof Fault && fault.expectedOffset !== undefined ? { expectedOffset: fault.expectedOffset } : {}) } } };
      }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeSession(listener) { sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
    subscribeCallbacks(listener) { callbackListeners.add(listener); return () => { callbackListeners.delete(listener); }; },
    respond(response) { bridge.respond(response); },
    // A connection that is gone serves no handler and answers no callback.
    disconnect() { approvalConsumer = false; current?.session.approvals.disconnect(); current?.session.tools?.serve([]); bridge.disconnect(); },
    async dispose() {
      const opened = current;
      current = undefined;
      approvalConsumer = false;
      opened?.session.approvals.disconnect();
      bridge.disconnect();
      transfers?.dispose();
      opened?.session.reminders?.releaseTimer();
      if (opened?.stopMcp) await opened.stopMcp();
      opened?.close();
    },
  };
}
