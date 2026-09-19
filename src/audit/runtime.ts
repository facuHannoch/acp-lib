import { open, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { AgentSessionId } from "../agent-ids.ts";
import type {
  AgentAuditState,
  AuditOutboxItem,
  PersistenceBackend,
} from "../persistence/backend.ts";
import { canonicalizeJson } from "../persistence/integrity.ts";
import { SqliteOwnerLock, SqliteOwnerLockConflictError } from "../persistence/sqlite-owner-lock.ts";
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

/** One agent-owned background writer. Rotation and tail recovery are layered onto this core. */
export class AgentAuditRuntime {
  readonly directory: string;
  readonly filePrefix: string;

  private running = true;
  private wake?: () => void;
  private readonly loop: Promise<void>;
  private constructor(
    private readonly persistence: PersistenceBackend,
    private readonly agentSessionId: AgentSessionId,
    private readonly config: ResolvedAgentAuditLogConfig,
    private readonly auditState: AgentAuditState,
    private readonly ownerLock: SqliteOwnerLock,
    private readonly segmentPath: string,
    private readonly file: FileHandle,
  ) {
    this.directory = config.directory;
    this.filePrefix = config.filePrefix;
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

    const segmentPath = join(directory, segmentName(config.filePrefix, 1));
    try {
      await initializeFirstSegment(segmentPath, directory, input.agentSessionId, input.auditState);
      const file = await open(segmentPath, "a+", 0o600);
      return new AgentAuditRuntime(
        input.persistence,
        input.agentSessionId,
        config,
        input.auditState,
        ownerLock,
        segmentPath,
        file,
      );
    } catch (error) {
      ownerLock.close();
      throw error;
    }
  }

  notifyPending(): void {
    this.wake?.();
  }

  async close(): Promise<void> {
    if (!this.running) return;
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
  }

  private async run(): Promise<void> {
    while (this.running) {
      const pending = await this.persistence.auditOutbox!.pending(100);
      if (pending.length === 0) {
        await this.waitForWork();
        continue;
      }
      try {
        await this.deliver(pending);
      } catch (error) {
        const head = pending[0]!;
        const delay = retryDelay(this.config, head.attemptCount + 1);
        const nextAttemptAt = new Date(Date.now() + delay).toISOString();
        await this.persistence.auditOutbox!.markFailed(head.outboxId, safeError(error), nextAttemptAt);
        await this.waitForWork(delay);
      }
    }
  }

  private async deliver(items: readonly AuditOutboxItem[]): Promise<void> {
    const lines = items.map((item) => canonicalizeJson(toAuditEntry(
      this.auditState.auditLogId,
      this.agentSessionId,
      item,
    )) + "\n");
    await this.file.writeFile(lines.join(""), "utf8");
    await this.file.sync();
    await assertSameOpenFile(this.file, this.segmentPath);
    await this.persistence.auditOutbox!.acknowledge(items.map((item) => item.outboxId));
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
}

async function initializeFirstSegment(
  path: string,
  directory: string,
  agentSessionId: AgentSessionId,
  state: AgentAuditState,
): Promise<void> {
  const header: AgentAuditSegmentHeaderV2 = {
    v: 2,
    t: "header",
    auditLogId: state.auditLogId,
    agentSessionId,
    generation: 1,
    createdAt: new Date().toISOString(),
    firstAuditSequence: 1,
  };
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
  }
  if (existing === undefined) {
    if (state.lastDeliveredSequence > 0) throw new AuditLogHistoryMissingError(path);
    const file = await open(path, "ax", 0o600);
    try {
      await file.writeFile(canonicalizeJson(header) + "\n", "utf8");
      await file.sync();
      await syncDirectory(directory);
      return;
    } finally {
      await file.close();
    }
  }

  const newline = existing.indexOf("\n");
  if (newline < 0) throw new AuditLogIdentityConflictError(path, "segment header is incomplete");
  let actual: unknown;
  try {
    actual = JSON.parse(existing.slice(0, newline));
  } catch (error) {
    throw new AuditLogIdentityConflictError(path, "segment header is malformed", { cause: error });
  }
  if (!isMatchingHeader(actual, state.auditLogId, agentSessionId, 1)) {
    throw new AuditLogIdentityConflictError(path, "segment header belongs to another stream");
  }
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
  const [opened, named] = await Promise.all([file.stat(), open(path, "r")]);
  try {
    const current = await named.stat();
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`active audit segment was replaced: ${path}`);
    }
  } finally {
    await named.close();
  }
}

function retryDelay(config: ResolvedAgentAuditLogConfig, attempt: number): number {
  const exponent = Math.max(0, Math.min(30, attempt - 1));
  return Math.min(config.retry.maxDelayMs, config.retry.initialDelayMs * 2 ** exponent);
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}
