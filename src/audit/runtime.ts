import { open, mkdir, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import type { FileHandle } from "node:fs/promises";
import type { AgentSessionId } from "../agent-ids.ts";
import type {
  AgentAuditState,
  AuditOutboxBacklog,
  AuditOutboxItem,
  PersistenceBackend,
} from "../persistence/backend.ts";
import { canonicalizeJson, sha256CanonicalJson } from "../persistence/integrity.ts";
import { SqliteOwnerLock, SqliteOwnerLockConflictError } from "../persistence/sqlite-owner-lock.ts";
import { SubscriptionHub } from "../observation/subscription-hub.ts";
import type { StatefulSubscribable, Unsubscribe } from "../observation/contracts.ts";
import type { ResolvedAgentAuditLogConfig } from "./config.ts";

export interface AgentAuditSegmentHeaderV2 {
  readonly v: 2;
  readonly t: "header";
  readonly auditLogId: string;
  readonly agentSessionId: AgentSessionId;
  readonly generation: number;
  readonly createdAt: string;
  readonly firstAuditSequence: number;
}

export interface AgentAuditEntryV2 {
  readonly v: 2;
  readonly t: "audit";
  readonly auditLogId: string;
  readonly outboxId: string;
  readonly auditSequence: number;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId?: string;
  readonly sourceRecordId?: string;
  readonly operationId?: string;
  readonly occurredAt: string;
  readonly kind: string;
  readonly captureLevel: string;
  readonly captureFingerprint: string;
  readonly payloadSha256: string;
  readonly payload: AuditOutboxItem["payload"];
}

export const AGENT_AUDIT_BATCH_SIZE = 16;

export type AgentAuditRuntimeState = "idle" | "delivering" | "backoff" | "blocked" | "stopped";

export interface AgentAuditSnapshot {
  readonly state: AgentAuditRuntimeState;
  readonly pendingCount: number;
  readonly pendingPayloadBytes: number;
  readonly oldestPendingAt?: string;
  readonly lastAllocatedSequence: number;
  readonly lastDeliveredSequence: number;
  readonly headAttemptCount?: number;
  readonly headLastError?: string;
  readonly activeSegmentGeneration: number;
  readonly activeSegmentBytes: number;
  readonly directory: string;
  readonly filePrefix: string;
  readonly rotation: ResolvedAgentAuditLogConfig["rotation"];
  readonly retry: ResolvedAgentAuditLogConfig["retry"];
  readonly captureFingerprint: string;
}

export type AgentAuditNotificationKind =
  | "pending"
  | "batch_started"
  | "batch_completed"
  | "batch_failed"
  | "backoff_started"
  | "backoff_ended"
  | "rotation"
  | "recovery"
  | "blocked"
  | "flush_completed"
  | "flush_timed_out"
  | "stopped";

export interface AgentAuditNotification {
  readonly kind: AgentAuditNotificationKind;
  readonly at: string;
  readonly snapshot: AgentAuditSnapshot;
}

export interface AgentAuditFlushOptions {
  readonly timeoutMs?: number;
}

export type AgentAuditFlushResult = Readonly<{
  status: "delivered" | "pending" | "blocked" | "timed_out";
  throughSequence: number;
  deliveredThroughSequence: number;
}>;

export class AuditLogDestinationInUseError extends Error {
  constructor(readonly directory: string, readonly filePrefix: string, options?: ErrorOptions) {
    super(`audit log destination is already owned: ${join(directory, filePrefix)}`, options);
    this.name = "AuditLogDestinationInUseError";
  }
}

export class AuditLogIdentityConflictError extends Error {
  constructor(readonly path: string, message: string, options?: ErrorOptions) {
    super(`audit log identity conflict at ${path}: ${message}`, options);
    this.name = "AuditLogIdentityConflictError";
  }
}

export class AuditLogHistoryMissingError extends Error {
  constructor(readonly path: string) {
    super(`delivered audit history is missing: ${path}`);
    this.name = "AuditLogHistoryMissingError";
  }
}

export class AuditLogDestinationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditLogDestinationBlockedError";
  }
}

/** One agent-owned background writer. Rotation and tail recovery are layered onto this core. */
export class AgentAuditRuntime
  implements StatefulSubscribable<AgentAuditSnapshot, AgentAuditNotification> {
  readonly directory: string;
  readonly filePrefix: string;

  private running = true;
  private runtimeState: AgentAuditRuntimeState = "idle";
  private syncedBatch?: readonly string[];
  private readonly writtenBatchPrefix: string[] = [];
  private wake?: () => void;
  private readonly loop: Promise<void>;
  private readonly subscriptions = new SubscriptionHub<AgentAuditNotification>();
  private currentSnapshot: AgentAuditSnapshot;
  private generation: number;
  private segmentPath: string;
  private file: FileHandle;
  private segmentCreatedAtMs: number;
  private segmentEntryCount: number;
  private segmentBytes: number;
  private constructor(
    private readonly persistence: PersistenceBackend,
    private readonly agentSessionId: AgentSessionId,
    private readonly config: ResolvedAgentAuditLogConfig,
    private readonly auditLogId: string,
    private readonly ownerLock: SqliteOwnerLock,
    active: RecoveredActiveSegment,
    initialSnapshot: AgentAuditSnapshot,
  ) {
    this.directory = config.directory;
    this.filePrefix = config.filePrefix;
    this.generation = active.generation;
    this.segmentPath = active.path;
    this.file = active.file;
    this.segmentCreatedAtMs = Date.parse(active.createdAt);
    this.segmentEntryCount = active.entryCount;
    this.segmentBytes = active.bytes;
    this.currentSnapshot = initialSnapshot;
    this.loop = this.run();
  }

  static async open(input: {
    readonly persistence: PersistenceBackend;
    readonly agentSessionId: AgentSessionId;
    readonly config: ResolvedAgentAuditLogConfig;
    readonly auditState: AgentAuditState;
  }): Promise<AgentAuditRuntime> {
    await mkdir(input.config.directory, { recursive: true });
    const directory = await realpath(input.config.directory);
    const config = Object.freeze({ ...input.config, directory });
    const lockPath = join(directory, `${config.filePrefix}.writer-owner.sqlite`);
    let ownerLock: SqliteOwnerLock;
    try {
      ownerLock = await SqliteOwnerLock.acquire(`audit:${directory}/${config.filePrefix}`, lockPath);
    } catch (error) {
      if (error instanceof SqliteOwnerLockConflictError) {
        throw new AuditLogDestinationInUseError(directory, config.filePrefix, { cause: error });
      }
      throw error;
    }

    try {
      const authoritativeState = await input.persistence.auditOutbox!.state();
      if (!authoritativeState || authoritativeState.auditLogId !== input.auditState.auditLogId) {
        throw new AuditLogIdentityConflictError(
          join(directory, segmentName(config.filePrefix, 1)),
          "SQLite audit identity changed during destination open",
        );
      }
      const recovered = await recoverAuditStream(
        directory,
        config.filePrefix,
        input.agentSessionId,
        authoritativeState,
        input.persistence,
      );
      const refreshedState = await input.persistence.auditOutbox!.state();
      if (!refreshedState) throw new Error("agent audit state is unavailable after recovery");
      const [backlog, segment] = await Promise.all([
        input.persistence.auditOutbox!.backlog(),
        recovered.file.stat(),
      ]);
      const head = await input.persistence.auditOutbox!.head();
      const initialSnapshot = makeSnapshot(
        "idle",
        config,
        refreshedState,
        backlog,
        head,
        recovered.generation,
        segment.size,
      );
      return new AgentAuditRuntime(
        input.persistence,
        input.agentSessionId,
        config,
        refreshedState.auditLogId,
        ownerLock,
        recovered,
        initialSnapshot,
      );
    } catch (error) {
      ownerLock.close();
      throw error;
    }
  }

  notifyPending(): void {
    this.wake?.();
    this.emitCached("pending");
  }

  get snapshot(): AgentAuditSnapshot {
    return this.currentSnapshot;
  }

  subscribe(listener: (event: AgentAuditNotification) => void): Unsubscribe {
    return this.subscriptions.subscribe(listener);
  }

  async status(): Promise<AgentAuditSnapshot> {
    if (this.runtimeState === "stopped") {
      if (this.currentSnapshot.state !== "stopped") {
        this.currentSnapshot = Object.freeze({ ...this.currentSnapshot, state: "stopped" });
      }
      return this.currentSnapshot;
    }
    const [state, backlog, head, segment] = await Promise.all([
      this.persistence.auditOutbox!.state(),
      this.persistence.auditOutbox!.backlog(),
      this.persistence.auditOutbox!.head(),
      this.file.stat(),
    ]);
    if (!state) throw new Error("agent audit state is unavailable");
    this.currentSnapshot = makeSnapshot(
      this.runtimeState,
      this.config,
      state,
      backlog,
      head,
      this.generation,
      segment.size,
    );
    return this.currentSnapshot;
  }

  async flush(options: AgentAuditFlushOptions = {}): Promise<AgentAuditFlushResult> {
    const timeoutMs = boundedNonNegative(options.timeoutMs ?? 30_000, "audit flush timeoutMs");
    const state = await this.persistence.auditOutbox!.state();
    if (!state) throw new Error("agent audit state is unavailable");
    const throughSequence = state.lastAllocatedSequence;
    const deadline = Date.now() + timeoutMs;
    this.notifyPending();
    while (true) {
      const snapshot = await this.status();
      if (snapshot.lastDeliveredSequence >= throughSequence) {
        const result = flushResult("delivered", throughSequence, snapshot.lastDeliveredSequence);
        await this.publish("flush_completed");
        return result;
      }
      if (snapshot.state === "blocked") {
        return flushResult("blocked", throughSequence, snapshot.lastDeliveredSequence);
      }
      if (snapshot.state === "stopped") {
        return flushResult("pending", throughSequence, snapshot.lastDeliveredSequence);
      }
      if (Date.now() >= deadline) {
        const result = flushResult("timed_out", throughSequence, snapshot.lastDeliveredSequence);
        await this.publish("flush_timed_out");
        return result;
      }
      await Bun.sleep(Math.min(20, Math.max(1, deadline - Date.now())));
    }
  }

  async retry(): Promise<void> {
    if (this.runtimeState === "blocked") throw new AuditLogDestinationBlockedError("audit destination is blocked");
    if (!this.running) throw new Error("audit runtime is stopped");
    await this.persistence.auditOutbox!.retryHead();
    if (this.runtimeState === "backoff") {
      this.runtimeState = "idle";
      await this.publish("backoff_ended");
    }
    this.notifyPending();
  }

  async close(): Promise<void> {
    if (!this.running) return;
    await this.flush({ timeoutMs: this.config.shutdownGraceMs });
    this.running = false;
    this.wake?.();
    try {
      await this.loop;
    } finally {
      try {
        await this.file.close();
      } finally {
        this.ownerLock.close();
      }
    }
    this.runtimeState = "stopped";
    await this.publish("stopped");
    this.subscriptions.clear();
  }

  private async run(): Promise<void> {
    while (this.running) {
      if (this.runtimeState === "blocked") {
        await this.waitForWork();
        continue;
      }
      let pending: readonly AuditOutboxItem[];
      try {
        pending = await this.persistence.auditOutbox!.pending(AGENT_AUDIT_BATCH_SIZE);
      } catch (error) {
        this.runtimeState = "blocked";
        await this.publish("blocked");
        await this.waitForWork();
        continue;
      }
      if (pending.length === 0) {
        if (this.runtimeState === "backoff") {
          this.runtimeState = "idle";
          await this.publish("backoff_ended");
        }
        await this.waitForWork();
        continue;
      }
      try {
        this.runtimeState = "delivering";
        await this.publish("batch_started");
        await this.deliver(pending);
        this.runtimeState = "idle";
        await this.publish("batch_completed");
      } catch (error) {
        if (error instanceof AuditLogDestinationBlockedError) {
          this.runtimeState = "blocked";
          await this.publish("blocked");
          await this.waitForWork();
          continue;
        }
        const head = pending[0]!;
        const delay = retryDelay(this.config, head.attemptCount + 1, Math.random());
        const nextAttemptAt = new Date(Date.now() + delay).toISOString();
        await this.persistence.auditOutbox!.markFailed(head.outboxId, safeError(error), nextAttemptAt);
        this.runtimeState = "backoff";
        await this.publish("batch_failed");
        await this.publish("backoff_started");
        await this.waitForWork(delay);
        if (this.runtimeState === "backoff") {
          this.runtimeState = "idle";
          await this.publish("backoff_ended");
        }
      }
    }
  }

  private async deliver(items: readonly AuditOutboxItem[]): Promise<void> {
    const outboxIds = items.map((item) => item.outboxId);
    if (this.syncedBatch) {
      if (
        this.syncedBatch.length !== outboxIds.length
        || this.syncedBatch.some((id, index) => id !== outboxIds[index])
      ) throw new AuditLogDestinationBlockedError("synced audit batch no longer matches the pending head");
      await this.persistence.auditOutbox!.acknowledge(this.syncedBatch);
      this.syncedBatch = undefined;
      this.writtenBatchPrefix.length = 0;
      return;
    }
    const lines = items.map((item) => canonicalizeJson(toAuditEntry(
      this.auditLogId,
      this.agentSessionId,
      item,
    )) + "\n");
    if (this.writtenBatchPrefix.some((id, index) => id !== outboxIds[index])) {
      throw new AuditLogDestinationBlockedError("written audit prefix no longer matches the pending head");
    }
    for (let index = this.writtenBatchPrefix.length; index < items.length; index++) {
      const item = items[index]!;
      const line = lines[index]!;
      if (this.shouldRotate(Buffer.byteLength(line, "utf8"))) await this.rotate(item.auditSequence);
      const beforeBytes = this.segmentBytes;
      const beforeEntries = this.segmentEntryCount;
      try {
        await this.file.writeFile(line, "utf8");
        this.segmentBytes += Buffer.byteLength(line, "utf8");
        this.segmentEntryCount++;
        await this.file.sync();
        await assertSameOpenFile(this.file, this.segmentPath);
      } catch (error) {
        if (error instanceof AuditLogDestinationBlockedError) throw error;
        try {
          await this.file.truncate(beforeBytes);
          await this.file.sync();
          this.segmentBytes = beforeBytes;
          this.segmentEntryCount = beforeEntries;
        } catch (rollbackError) {
          throw new AuditLogDestinationBlockedError(
            `audit entry write failed and its tail could not be restored: ${safeError(rollbackError)}`,
          );
        }
        throw error;
      }
      this.writtenBatchPrefix.push(item.outboxId);
    }
    this.syncedBatch = Object.freeze(outboxIds);
    await this.persistence.auditOutbox!.acknowledge(outboxIds);
    this.syncedBatch = undefined;
    this.writtenBatchPrefix.length = 0;
  }

  private shouldRotate(nextLineBytes: number): boolean {
    if (this.segmentEntryCount === 0) return false;
    const sizeReached = this.config.rotation.maxBytes !== false
      && this.segmentBytes + nextLineBytes > this.config.rotation.maxBytes;
    const ageReached = this.config.rotation.maxAgeMs !== false
      && Date.now() - this.segmentCreatedAtMs >= this.config.rotation.maxAgeMs;
    return sizeReached || ageReached;
  }

  private async rotate(firstAuditSequence: number): Promise<void> {
    await this.file.sync();
    await assertSameOpenFile(this.file, this.segmentPath);
    const generation = this.generation + 1;
    const active = await createSegment(
      this.config.directory,
      this.config.filePrefix,
      generation,
      this.auditLogId,
      this.agentSessionId,
      firstAuditSequence,
    );
    const previous = this.file;
    this.generation = active.generation;
    this.segmentPath = active.path;
    this.file = active.file;
    this.segmentCreatedAtMs = Date.parse(active.createdAt);
    this.segmentEntryCount = 0;
    this.segmentBytes = active.bytes;
    await previous.close();
    await this.publish("rotation");
  }

  private async waitForWork(maxDelayMs = 1_000): Promise<void> {
    if (!this.running) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, maxDelayMs);
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wake === done) self.wake = undefined;
        resolve();
      }
      this.wake = done;
    });
  }

  private async publish(kind: AgentAuditNotificationKind): Promise<void> {
    try {
      await this.status();
    } catch {
      // The state transition remains observable through the cached snapshot.
      this.currentSnapshot = Object.freeze({ ...this.currentSnapshot, state: this.runtimeState });
    }
    this.subscriptions.emit(Object.freeze({
      kind,
      at: new Date().toISOString(),
      snapshot: this.currentSnapshot,
    }));
  }

  private emitCached(kind: AgentAuditNotificationKind): void {
    this.subscriptions.emit(Object.freeze({
      kind,
      at: new Date().toISOString(),
      snapshot: this.currentSnapshot,
    }));
  }
}

interface RecoveredActiveSegment {
  readonly generation: number;
  readonly path: string;
  readonly file: FileHandle;
  readonly createdAt: string;
  readonly entryCount: number;
  readonly bytes: number;
}

interface ScannedAuditTuple {
  readonly outboxId: string;
  readonly payloadSha256: string;
}

async function recoverAuditStream(
  directory: string,
  prefix: string,
  agentSessionId: AgentSessionId,
  state: AgentAuditState,
  persistence: PersistenceBackend,
): Promise<RecoveredActiveSegment> {
  const matcher = new RegExp(`^${escapeRegExp(prefix)}\\.([0-9]{6,})\\.jsonl$`);
  const generations = (await readdir(directory))
    .map((name) => ({ name, match: matcher.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
    .map(({ name, match }) => ({ name, generation: Number(match[1]) }))
    .sort((left, right) => left.generation - right.generation);
  for (let index = 0; index < generations.length; index++) {
    if (generations[index]!.generation !== index + 1) {
      throw new AuditLogIdentityConflictError(
        join(directory, generations[index]!.name),
        "segment generations are not contiguous from one",
      );
    }
  }

  if (generations.length === 0) {
    const firstPath = join(directory, segmentName(prefix, 1));
    if (state.lastDeliveredSequence > 0) throw new AuditLogHistoryMissingError(firstPath);
    return await createSegment(directory, prefix, 1, state.auditLogId, agentSessionId, 1);
  }

  const tuples = new Map<number, ScannedAuditTuple>();
  let maximumSequence = 0;
  let replayLength = 0;
  let previousReplaySequence = 0;
  let active: Omit<RecoveredActiveSegment, "file"> | undefined;
  for (let index = 0; index < generations.length; index++) {
    const descriptor = generations[index]!;
    const path = join(directory, descriptor.name);
    let bytes = await readFile(path);
    const highest = index === generations.length - 1;
    const firstNewline = bytes.indexOf(0x0a);
    if (firstNewline < 0) {
      if (!highest) throw new AuditLogIdentityConflictError(path, "sealed segment header is incomplete");
      await unlink(path);
      await syncDirectory(directory);
      if (index === 0) {
        if (state.lastDeliveredSequence > 0) throw new AuditLogHistoryMissingError(path);
        return await createSegment(directory, prefix, 1, state.auditLogId, agentSessionId, 1);
      }
      break;
    }
    if (highest && bytes.at(-1) !== 0x0a) {
      const lastNewline = bytes.lastIndexOf(0x0a);
      const handle = await open(path, "r+");
      try {
        await handle.truncate(lastNewline + 1);
        await handle.sync();
      } finally {
        await handle.close();
      }
      bytes = bytes.subarray(0, lastNewline + 1);
    }
    const text = bytes.toString("utf8");
    const lines = text.slice(0, -1).split("\n");
    const header = parseHeader(lines[0]!, path, state.auditLogId, agentSessionId, descriptor.generation);
    const entries = lines.slice(1).map((line, lineIndex) => parseEntry(
      line,
      path,
      lineIndex + 2,
      state.auditLogId,
      agentSessionId,
    ));
    if (entries[0] && header.firstAuditSequence !== entries[0].auditSequence) {
      throw new AuditLogIdentityConflictError(path, "header firstAuditSequence does not match its first entry");
    }
    for (const entry of entries) {
      const tuple = { outboxId: entry.outboxId, payloadSha256: entry.payloadSha256 };
      if (entry.auditSequence === maximumSequence + 1) {
        tuples.set(entry.auditSequence, tuple);
        maximumSequence = entry.auditSequence;
        replayLength = 0;
        continue;
      }
      const original = tuples.get(entry.auditSequence);
      if (
        !original
        || original.outboxId !== tuple.outboxId
        || original.payloadSha256 !== tuple.payloadSha256
        || (replayLength > 0 && entry.auditSequence !== previousReplaySequence + 1)
      ) throw new AuditLogIdentityConflictError(path, `conflicting audit sequence ${entry.auditSequence}`);
      replayLength++;
      previousReplaySequence = entry.auditSequence;
      if (replayLength > AGENT_AUDIT_BATCH_SIZE) {
        throw new AuditLogIdentityConflictError(path, "physical replay exceeds the delivery batch bound");
      }
    }
    active = {
      generation: descriptor.generation,
      path,
      createdAt: header.createdAt,
      entryCount: entries.length,
      bytes: bytes.byteLength,
    };
  }

  if (maximumSequence < state.lastDeliveredSequence) {
    throw new AuditLogHistoryMissingError(active?.path ?? join(directory, segmentName(prefix, 1)));
  }
  if (maximumSequence > state.lastAllocatedSequence) {
    throw new AuditLogIdentityConflictError(active!.path, "physical stream extends beyond SQLite allocation state");
  }
  const unacknowledged = maximumSequence - state.lastDeliveredSequence;
  if (unacknowledged > AGENT_AUDIT_BATCH_SIZE) {
    throw new AuditLogIdentityConflictError(active!.path, "unacknowledged physical suffix exceeds batch bound");
  }
  if (unacknowledged > 0) {
    const pending = await persistence.auditOutbox!.pending(unacknowledged, "9999-12-31T23:59:59.999Z");
    if (pending.length !== unacknowledged || pending.some((item) => {
      const physical = tuples.get(item.auditSequence);
      return !physical || physical.outboxId !== item.outboxId || physical.payloadSha256 !== item.payloadSha256;
    })) throw new AuditLogIdentityConflictError(active!.path, "physical suffix does not match the pending head");
    await persistence.auditOutbox!.acknowledge(pending.map((item) => item.outboxId));
  }

  if (!active) {
    const previous = generations.at(-2);
    if (!previous) return await createSegment(directory, prefix, 1, state.auditLogId, agentSessionId, 1);
    const path = join(directory, previous.name);
    const bytes = await readFile(path);
    const lines = bytes.toString("utf8").trimEnd().split("\n");
    const header = parseHeader(lines[0]!, path, state.auditLogId, agentSessionId, previous.generation);
    active = { generation: previous.generation, path, createdAt: header.createdAt, entryCount: lines.length - 1, bytes: bytes.byteLength };
  }
  return Object.freeze({ ...active, file: await open(active.path, "a+", 0o600) });
}

async function createSegment(
  directory: string,
  prefix: string,
  generation: number,
  auditLogId: string,
  agentSessionId: AgentSessionId,
  firstAuditSequence: number,
): Promise<RecoveredActiveSegment> {
  const path = join(directory, segmentName(prefix, generation));
  const createdAt = new Date().toISOString();
  const header: AgentAuditSegmentHeaderV2 = {
    v: 2,
    t: "header",
    auditLogId,
    agentSessionId,
    generation,
    createdAt,
    firstAuditSequence,
  };
  const line = canonicalizeJson(header) + "\n";
  const file = await open(path, "ax", 0o600);
  try {
    await file.writeFile(line, "utf8");
    await file.sync();
    await syncDirectory(directory);
    await file.close();
    return Object.freeze({
      generation,
      path,
      file: await open(path, "a+", 0o600),
      createdAt,
      entryCount: 0,
      bytes: Buffer.byteLength(line, "utf8"),
    });
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    await syncDirectory(directory).catch(() => undefined);
    throw error;
  }
}

function parseHeader(
  line: string,
  path: string,
  auditLogId: string,
  agentSessionId: AgentSessionId,
  generation: number,
): AgentAuditSegmentHeaderV2 {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new AuditLogIdentityConflictError(path, "segment header is malformed", { cause: error });
  }
  if (!isMatchingHeader(value, auditLogId, agentSessionId, generation)) {
    throw new AuditLogIdentityConflictError(path, "segment header belongs to another stream");
  }
  const header = value as unknown as AgentAuditSegmentHeaderV2;
  if (!Number.isFinite(Date.parse(header.createdAt)) || !Number.isSafeInteger(header.firstAuditSequence)
    || header.firstAuditSequence < 1) {
    throw new AuditLogIdentityConflictError(path, "segment header fields are invalid");
  }
  return header;
}

function parseEntry(
  line: string,
  path: string,
  lineNumber: number,
  auditLogId: string,
  agentSessionId: AgentSessionId,
): AgentAuditEntryV2 {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new AuditLogIdentityConflictError(path, `audit entry at line ${lineNumber} is malformed`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuditLogIdentityConflictError(path, `audit entry at line ${lineNumber} is invalid`);
  }
  const entry = value as unknown as AgentAuditEntryV2;
  if (
    entry.v !== 2 || entry.t !== "audit" || entry.auditLogId !== auditLogId
    || entry.agentSessionId !== agentSessionId || !entry.outboxId
    || !Number.isSafeInteger(entry.auditSequence) || entry.auditSequence < 1
    || !/^[0-9a-f]{64}$/.test(entry.payloadSha256)
    || sha256CanonicalJson(entry.payload) !== entry.payloadSha256
  ) throw new AuditLogIdentityConflictError(path, `audit entry at line ${lineNumber} failed validation`);
  return entry;
}

function toAuditEntry(
  auditLogId: string,
  agentSessionId: AgentSessionId,
  item: AuditOutboxItem,
): AgentAuditEntryV2 {
  return {
    v: 2,
    t: "audit",
    auditLogId,
    outboxId: item.outboxId,
    auditSequence: item.auditSequence,
    agentSessionId,
    ...(item.agentConversationId ? { agentConversationId: item.agentConversationId } : {}),
    ...(item.sourceRecordId ? { sourceRecordId: item.sourceRecordId } : {}),
    ...(item.operationId ? { operationId: item.operationId } : {}),
    occurredAt: item.occurredAt,
    kind: item.kind,
    captureLevel: item.captureLevel,
    captureFingerprint: item.captureFingerprint,
    payloadSha256: item.payloadSha256,
    payload: item.payload,
  };
}

function isMatchingHeader(
  value: unknown,
  auditLogId: string,
  agentSessionId: AgentSessionId,
  generation: number,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const header = value as Record<string, unknown>;
  return header.v === 2 && header.t === "header" && header.auditLogId === auditLogId
    && header.agentSessionId === agentSessionId && header.generation === generation;
}

function segmentName(prefix: string, generation: number): string {
  return `${prefix}.${String(generation).padStart(6, "0")}.jsonl`;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!isNodeErrorCode(error, "EINVAL") && !isNodeErrorCode(error, "ENOTSUP")) throw error;
  } finally {
    await handle.close();
  }
}

async function assertSameOpenFile(file: FileHandle, path: string): Promise<void> {
  let named: FileHandle;
  try {
    named = await open(path, "r");
  } catch (error) {
    throw new AuditLogDestinationBlockedError(`active audit segment is unavailable: ${path}`);
  }
  try {
    const opened = await file.stat();
    const current = await named.stat();
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new AuditLogDestinationBlockedError(`active audit segment was replaced: ${path}`);
    }
  } finally {
    await named.close();
  }
}

function retryDelay(config: ResolvedAgentAuditLogConfig, attempt: number, random: number): number {
  const exponent = Math.max(0, Math.min(30, attempt - 1));
  const base = Math.min(config.retry.maxDelayMs, config.retry.initialDelayMs * 2 ** exponent);
  return Math.max(1, Math.round(base * (0.9 + Math.min(1, Math.max(0, random)) * 0.2)));
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

function makeSnapshot(
  state: AgentAuditRuntimeState,
  config: ResolvedAgentAuditLogConfig,
  audit: AgentAuditState,
  backlog: AuditOutboxBacklog,
  head: AuditOutboxItem | null,
  activeSegmentGeneration: number,
  activeSegmentBytes: number,
): AgentAuditSnapshot {
  return Object.freeze({
    state,
    pendingCount: backlog.pendingCount,
    pendingPayloadBytes: backlog.pendingPayloadBytes,
    ...(backlog.oldestPendingAt ? { oldestPendingAt: backlog.oldestPendingAt } : {}),
    lastAllocatedSequence: audit.lastAllocatedSequence,
    lastDeliveredSequence: audit.lastDeliveredSequence,
    ...(head ? { headAttemptCount: head.attemptCount } : {}),
    ...(head?.lastError ? { headLastError: head.lastError } : {}),
    activeSegmentGeneration,
    activeSegmentBytes,
    directory: config.directory,
    filePrefix: config.filePrefix,
    rotation: config.rotation,
    retry: config.retry,
    captureFingerprint: audit.captureFingerprint,
  });
}

function flushResult(
  status: AgentAuditFlushResult["status"],
  throughSequence: number,
  deliveredThroughSequence: number,
): AgentAuditFlushResult {
  return Object.freeze({ status, throughSequence, deliveredThroughSequence });
}

function boundedNonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
