import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolvePersistenceRoot } from "./config.ts";
import { validateSessionConfigurationCheckpoint } from "./checkpoint.ts";
import {
  AgentSessionStoreConflictError,
  SessionMaintenanceInProgressError,
  summarizeAgentSessionRecord,
  validateAgentSessionRecord,
  type AgentSessionListPage,
  type AgentSessionRecord,
  type AgentSessionStore,
  type AgentSessionsRegistryFile,
  type ListAgentSessionsOptions,
  type ListSessionMaintenanceOptions,
  type MaintenanceCompletionReceipt,
  type PrepareMaintenanceResult,
  type SessionMaintenance,
  type SessionMaintenancePage,
} from "./registry.ts";
import { canonicalizeJson } from "./integrity.ts";

const REGISTRY_FILENAME = "agent-sessions.json";
const MAX_RECEIPTS_PER_SESSION = 32;
const MAX_RECEIPTS_GLOBAL = 4_096;

export interface RegistryRecoveryNotice {
  readonly source: "backup";
  readonly primaryError: Error;
  readonly recoveredRevision: number;
}

export interface FileAgentSessionStoreOptions {
  readonly root?: string;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
  readonly onRecovery?: (notice: RegistryRecoveryNotice) => void;
  /** Test/embedding clock; it must return canonical ISO-8601. */
  readonly now?: () => string;
}

export class AgentSessionRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentSessionRegistryError";
  }
}

export class AgentSessionRegistryLockError extends AgentSessionRegistryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentSessionRegistryLockError";
  }
}

export class AgentSessionRegistryCursorError extends AgentSessionRegistryError {
  constructor(message: string) {
    super(message);
    this.name = "AgentSessionRegistryCursorError";
  }
}

export class MaintenanceOutcomeUnknownError extends AgentSessionRegistryError {
  constructor(readonly agentSessionId: string, readonly operationId: string) {
    super(`maintenance outcome is unknown for ${agentSessionId}/${operationId}`);
    this.name = "MaintenanceOutcomeUnknownError";
  }
}

/** Atomic full-JSON implementation of the strict AgentSessionStore contract. */
export class FileAgentSessionStore implements AgentSessionStore {
  readonly root: string;
  readonly path: string;
  readonly backupPath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly onRecovery?: (notice: RegistryRecoveryNotice) => void;
  private readonly now: () => string;

  constructor(options: FileAgentSessionStoreOptions = {}) {
    this.root = resolvePersistenceRoot(options.root);
    this.path = join(this.root, REGISTRY_FILENAME);
    this.backupPath = `${this.path}.bak`;
    this.lockPath = `${this.path}.lock`;
    this.lockTimeoutMs = boundedInteger(options.lockTimeoutMs ?? 5_000, 100, 120_000, "lockTimeoutMs");
    this.lockRetryMs = boundedInteger(options.lockRetryMs ?? 20, 1, 1_000, "lockRetryMs");
    this.onRecovery = options.onRecovery;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async getAgentSessionRecord(agentSessionId: string): Promise<AgentSessionRecord | null> {
    const file = await this.readRegistry();
    const record = file.sessions[agentSessionId];
    return record ? structuredClone(record) : null;
  }

  async getMaintenance(agentSessionId: string): Promise<SessionMaintenance | null> {
    const value = (await this.readRegistry()).maintenance[agentSessionId];
    return value ? structuredClone(value) : null;
  }

  async saveAgentSessionRecord(
    record: AgentSessionRecord,
    options:
      | { readonly expectedRecordRevision: null; readonly expectedIncarnationId: null }
      | { readonly expectedRecordRevision: number; readonly expectedIncarnationId: string },
  ): Promise<AgentSessionRecord> {
    validateAgentSessionRecord(record);
    return this.mutate(async (file) => {
      rejectMaintenance(file, record.agentSessionId);
      const current = file.sessions[record.agentSessionId] ?? null;
      validateRecordCas(current, record, options);
      file.sessions[record.agentSessionId] = structuredClone(record);
      return structuredClone(record);
    });
  }

  async deleteAgentSessionRecord(
    agentSessionId: string,
    options: { readonly expectedRecordRevision: number; readonly expectedIncarnationId: string },
  ): Promise<void> {
    await this.mutate(async (file) => {
      rejectMaintenance(file, agentSessionId);
      const current = file.sessions[agentSessionId];
      if (!current) throw new AgentSessionStoreConflictError("agent-session record does not exist");
      assertExistingCas(current, options.expectedRecordRevision, options.expectedIncarnationId);
      delete file.sessions[agentSessionId];
    });
  }

  async listAgentSessions(options: ListAgentSessionsOptions = {}): Promise<AgentSessionListPage> {
    const file = await this.readRegistry();
    const limit = listLimit(options.limit);
    const order = options.order ?? "updated_desc";
    const includeDeleted = options.includeDeleted ?? false;
    const offset = decodeCursor(options.cursor, "sessions", file.revision, { order, includeDeleted });
    const rows = Object.values(file.sessions)
      .filter((record) => {
        const maintenance = file.maintenance[record.agentSessionId];
        if (!includeDeleted && (record.deletion || maintenance?.kind === "deletion")) return false;
        return true;
      })
      .sort(sessionComparator(order))
      .map((record) => summarizeAgentSessionRecord(record, file.maintenance[record.agentSessionId]));
    const sessions = rows.slice(offset, offset + limit);
    const nextOffset = offset + sessions.length;
    const hasMore = nextOffset < rows.length;
    return {
      sessions,
      nextCursor: hasMore
        ? encodeCursor({ v: 1, kind: "sessions", revision: file.revision, offset: nextOffset, filter: { order, includeDeleted } }) as never
        : null,
      hasMore,
    };
  }

  async listMaintenance(options: ListSessionMaintenanceOptions = {}): Promise<SessionMaintenancePage> {
    const file = await this.readRegistry();
    const limit = listLimit(options.limit);
    const offset = decodeCursor(options.cursor, "maintenance", file.revision, {});
    const rows = Object.entries(file.maintenance)
      .map(([agentSessionId, value]) => ({
        agentSessionId,
        incarnationId: value.incarnationId,
        kind: value.kind,
        operationId: value.operationId,
        startedAt: value.startedAt,
      }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.agentSessionId.localeCompare(b.agentSessionId));
    const maintenance = rows.slice(offset, offset + limit);
    const nextOffset = offset + maintenance.length;
    const hasMore = nextOffset < rows.length;
    return {
      maintenance,
      nextCursor: hasMore
        ? encodeCursor({ v: 1, kind: "maintenance", revision: file.revision, offset: nextOffset, filter: {} }) as never
        : null,
      hasMore,
    };
  }

  async prepareMaintenance(
    agentSessionId: string,
    maintenance: SessionMaintenance,
    options: { readonly expectedRecordRevision: number | null },
  ): Promise<PrepareMaintenanceResult> {
    validateMaintenance(agentSessionId, maintenance);
    return this.mutate(async (file, mutation) => {
      const receipt = findReceipt(file, agentSessionId, maintenance.incarnationId, maintenance.operationId);
      if (receipt) {
        if (receipt.requestDigest !== maintenance.requestDigest) {
          throw new AgentSessionStoreConflictError("maintenance operationId was completed with another request digest");
        }
        mutation.changed = false;
        return { status: "already_completed", receipt: structuredClone(receipt) };
      }
      const prepared = file.maintenance[agentSessionId];
      if (prepared) {
        if (sameMaintenanceIdentity(prepared, maintenance)) {
          if (maintenance.baseRecordRevision !== options.expectedRecordRevision) {
            throw new AgentSessionStoreConflictError("maintenance base revision disagrees with expected revision");
          }
          mutation.changed = false;
          return { status: "already_prepared", maintenance: structuredClone(prepared) };
        }
        throw new SessionMaintenanceInProgressError(agentSessionId);
      }
      if (maintenance.baseRecordRevision !== options.expectedRecordRevision) {
        throw new AgentSessionStoreConflictError("maintenance base revision disagrees with expected revision");
      }
      const current = file.sessions[agentSessionId] ?? null;
      if (maintenance.kind === "creation") {
        if (current || options.expectedRecordRevision !== null) {
          throw new AgentSessionStoreConflictError("creation requires an unused logical identity");
        }
      } else {
        if (!current || options.expectedRecordRevision === null) {
          throw new AgentSessionStoreConflictError("existing-session maintenance requires a record");
        }
        assertExistingCas(current, options.expectedRecordRevision, maintenance.incarnationId);
      }
      file.maintenance[agentSessionId] = structuredClone(maintenance);
      return { status: "prepared", maintenance: structuredClone(maintenance) };
    });
  }

  async updateMaintenance(
    agentSessionId: string,
    expectedIncarnationId: string,
    operationId: string,
    update: SessionMaintenance,
  ): Promise<void> {
    validateMaintenance(agentSessionId, update);
    await this.mutate(async (file) => {
      const current = file.maintenance[agentSessionId];
      if (!current) throw new AgentSessionStoreConflictError("maintenance reservation does not exist");
      assertMaintenanceIdentity(current, expectedIncarnationId, operationId, update.requestDigest);
      validateMaintenanceAdvance(current, update);
      file.maintenance[agentSessionId] = structuredClone(update);
    });
  }

  async finalizeMaintenance(
    agentSessionId: string,
    expectedIncarnationId: string,
    operationId: string,
    requestDigest: string,
    mutation:
      | { readonly save: AgentSessionRecord; readonly deleteRecord?: never }
      | { readonly save?: never; readonly deleteRecord: true },
  ): Promise<void> {
    await this.mutate(async (file, state) => {
      const currentMaintenance = file.maintenance[agentSessionId];
      if (!currentMaintenance) {
        const receipt = findReceipt(file, agentSessionId, expectedIncarnationId, operationId);
        if (receipt?.requestDigest === requestDigest) {
          state.changed = false;
          return;
        }
        if (receipt) throw new AgentSessionStoreConflictError("completed maintenance request digest mismatch");
        throw new MaintenanceOutcomeUnknownError(agentSessionId, operationId);
      }
      assertMaintenanceIdentity(currentMaintenance, expectedIncarnationId, operationId, requestDigest);
      const currentRecord = file.sessions[agentSessionId] ?? null;
      if (currentMaintenance.kind === "creation") {
        if (currentRecord) throw new AgentSessionStoreConflictError("creation finalization found an existing record");
      } else {
        if (!currentRecord) throw new AgentSessionStoreConflictError("maintenance finalization lost its record");
        assertExistingCas(currentRecord, currentMaintenance.baseRecordRevision, expectedIncarnationId);
      }
      if ("save" in mutation && mutation.save !== undefined) {
        validateAgentSessionRecord(mutation.save);
        if (mutation.save.agentSessionId !== agentSessionId || mutation.save.incarnationId !== expectedIncarnationId) {
          throw new AgentSessionStoreConflictError("finalized record identity mismatch");
        }
        const expectedRevision = currentMaintenance.kind === "creation" ? 1 : currentMaintenance.baseRecordRevision + 1;
        if (mutation.save.recordRevision !== expectedRevision) {
          throw new AgentSessionStoreConflictError("finalized recordRevision is invalid");
        }
        if (currentMaintenance.kind === "creation" || currentMaintenance.kind === "restoration") {
          const staged = currentMaintenance.details.stagedRecord;
          if (!staged || canonicalizeJson(staged) !== canonicalizeJson(mutation.save)) {
            throw new AgentSessionStoreConflictError("finalization must publish the exact stagedRecord");
          }
        }
        file.sessions[agentSessionId] = structuredClone(mutation.save);
      } else {
        if (currentMaintenance.kind !== "deletion") {
          throw new AgentSessionStoreConflictError("only deletion maintenance may remove a registry record");
        }
        delete file.sessions[agentSessionId];
      }
      delete file.maintenance[agentSessionId];
      addReceipt(file, {
        agentSessionId,
        incarnationId: expectedIncarnationId,
        kind: currentMaintenance.kind,
        operationId,
        requestDigest,
        outcome: "completed",
        completedAt: this.checkedNow(),
      });
    });
  }

  private async mutate<T>(
    apply: (file: MutableRegistry, state: { changed: boolean }) => Promise<T>,
  ): Promise<T> {
    const lock = await this.acquireLock();
    try {
      const loaded = await this.loadRegistry();
      const existing = loaded.file;
      const file = structuredClone(existing) as MutableRegistry;
      const state = { changed: true };
      const result = await apply(file, state);
      if (state.changed) {
        file.revision = existing.revision + 1;
        file.updatedAt = this.checkedNow();
        validateRegistry(file);
        await this.writeRegistry(file, loaded.primaryValid && existing.revision > 0);
      }
      return result;
    } finally {
      await lock.release();
    }
  }

  private async readRegistry(): Promise<AgentSessionsRegistryFile> {
    return (await this.loadRegistry()).file;
  }

  private async loadRegistry(): Promise<{ file: AgentSessionsRegistryFile; primaryValid: boolean }> {
    let primaryError: Error | null = null;
    try {
      return { file: await readAndValidate(this.path), primaryValid: true };
    } catch (error) {
      if (isMissing(error)) {
        try {
          await stat(this.backupPath);
        } catch (backupError) {
          if (isMissing(backupError)) return { file: emptyRegistry(), primaryValid: false };
        }
      }
      primaryError = asError(error);
    }
    try {
      const recovered = await readAndValidate(this.backupPath);
      try {
        this.onRecovery?.({ source: "backup", primaryError, recoveredRevision: recovered.revision });
      } catch {
        // Observation must not turn a successful, validated recovery into data loss.
      }
      return { file: recovered, primaryValid: false };
    } catch (backupError) {
      throw new AgentSessionRegistryError("primary and backup registries are unavailable or invalid", {
        cause: new AggregateError([primaryError, asError(backupError)]),
      });
    }
  }

  private async writeRegistry(file: AgentSessionsRegistryFile, hadPrimary: boolean): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
    const token = `${process.pid}-${randomUUID()}`;
    const nextPath = join(this.root, `.${REGISTRY_FILENAME}.${token}.tmp`);
    const backupTemp = `${this.backupPath}.${token}.tmp`;
    try {
      await writeSynced(nextPath, `${JSON.stringify(file, null, 2)}\n`);
      if (hadPrimary) {
        await copyFile(this.path, backupTemp);
        await chmod(backupTemp, 0o600).catch(() => undefined);
        await syncFile(backupTemp);
        await rename(backupTemp, this.backupPath);
        await syncDirectory(this.root);
      }
      await rename(nextPath, this.path);
      await syncDirectory(this.root);
    } finally {
      await unlink(nextPath).catch(() => undefined);
      await unlink(backupTemp).catch(() => undefined);
    }
  }

  private async acquireLock(): Promise<{ release(): Promise<void> }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = randomUUID();
    for (;;) {
      let handle;
      try {
        handle = await open(this.lockPath, "wx", 0o600);
      } catch (error) {
        if (!isExists(error)) throw new AgentSessionRegistryLockError("cannot acquire registry lock", { cause: error });
        if (await this.removeProvablyDeadLock()) continue;
        if (Date.now() >= deadline) throw new AgentSessionRegistryLockError("timed out waiting for registry lock");
        await delay(this.lockRetryMs);
        continue;
      }
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: this.checkedNow() }), "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(this.lockPath).catch(() => undefined);
        throw new AgentSessionRegistryLockError("cannot initialize registry lock", { cause: error });
      }
      return {
        release: async () => {
          await handle.close();
          try {
            const current = JSON.parse(await readFile(this.lockPath, "utf8")) as { token?: unknown };
            if (current.token === token) await unlink(this.lockPath);
          } catch {
            // Already released/replaced; never remove a lock whose token is not ours.
          }
        },
      };
    }
  }

  private async removeProvablyDeadLock(): Promise<boolean> {
    try {
      const raw = await readFile(this.lockPath, "utf8");
      const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
      if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) < 1 || typeof parsed.token !== "string") return false;
      try {
        process.kill(parsed.pid as number, 0);
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") return false;
      }
      // Re-read before unlinking so a replaced lock cannot be removed using stale evidence.
      if (await readFile(this.lockPath, "utf8") !== raw) return false;
      await unlink(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  private checkedNow(): string {
    const value = this.now();
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
      throw new AgentSessionRegistryError("registry clock returned a noncanonical timestamp");
    }
    return value;
  }
}

interface MutableRegistry {
  version: 1;
  revision: number;
  updatedAt: string;
  sessions: Record<string, AgentSessionRecord>;
  maintenance: Record<string, SessionMaintenance>;
  maintenanceReceipts: Record<string, MaintenanceCompletionReceipt[]>;
}

function emptyRegistry(): MutableRegistry {
  return { version: 1, revision: 0, updatedAt: "1970-01-01T00:00:00.000Z", sessions: {}, maintenance: {}, maintenanceReceipts: {} };
}

async function readAndValidate(path: string): Promise<AgentSessionsRegistryFile> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  validateRegistry(value);
  return value;
}

function validateRegistry(value: unknown): asserts value is AgentSessionsRegistryFile {
  if (!isRecord(value) || value.version !== 1) throw new AgentSessionRegistryError("unsupported or malformed registry version");
  nonnegativeInteger(value.revision, "registry revision");
  canonicalIso(value.updatedAt, "registry updatedAt");
  if (!isRecord(value.sessions) || !isRecord(value.maintenance) || !isRecord(value.maintenanceReceipts)) {
    throw new AgentSessionRegistryError("registry maps are malformed");
  }
  for (const [id, record] of Object.entries(value.sessions)) {
    try { validateAgentSessionRecord(record); } catch (error) {
      throw new AgentSessionRegistryError(`invalid session record ${id}`, { cause: error });
    }
    if (record.agentSessionId !== id) throw new AgentSessionRegistryError(`session key mismatch for ${id}`);
  }
  for (const [id, maintenance] of Object.entries(value.maintenance)) validateMaintenance(id, maintenance);
  let receiptCount = 0;
  for (const [id, receipts] of Object.entries(value.maintenanceReceipts)) {
    if (!Array.isArray(receipts) || receipts.length > MAX_RECEIPTS_PER_SESSION) throw new AgentSessionRegistryError(`invalid receipt list for ${id}`);
    receiptCount += receipts.length;
    for (const receipt of receipts) validateReceipt(id, receipt);
  }
  if (receiptCount > MAX_RECEIPTS_GLOBAL) throw new AgentSessionRegistryError("global maintenance receipt limit exceeded");
}

function validateRecordCas(
  current: AgentSessionRecord | null,
  next: AgentSessionRecord,
  options:
    | { readonly expectedRecordRevision: null; readonly expectedIncarnationId: null }
    | { readonly expectedRecordRevision: number; readonly expectedIncarnationId: string },
): void {
  if (options.expectedRecordRevision === null) {
    if (current) throw new AgentSessionStoreConflictError("agent-session record already exists");
    if (next.recordRevision !== 1) throw new AgentSessionStoreConflictError("new recordRevision must be 1");
    return;
  }
  if (!current) throw new AgentSessionStoreConflictError("agent-session record does not exist");
  assertExistingCas(current, options.expectedRecordRevision, options.expectedIncarnationId);
  if (next.incarnationId !== current.incarnationId || next.recordRevision !== current.recordRevision + 1) {
    throw new AgentSessionStoreConflictError("next agent-session record incarnation/revision is invalid");
  }
}

function assertExistingCas(record: AgentSessionRecord, revision: number, incarnationId: string): void {
  if (record.recordRevision !== revision || record.incarnationId !== incarnationId) {
    throw new AgentSessionStoreConflictError("agent-session record compare-and-swap failed");
  }
}

function rejectMaintenance(file: AgentSessionsRegistryFile, id: string): void {
  if (file.maintenance[id]) throw new SessionMaintenanceInProgressError(id);
}

function validateMaintenance(agentSessionId: string, value: unknown): asserts value is SessionMaintenance {
  if (!isRecord(value)) throw new AgentSessionRegistryError("maintenance must be an object");
  canonicalizeJson(value);
  requiredString(agentSessionId, "maintenance agentSessionId");
  requiredString(value.incarnationId, "maintenance incarnationId");
  requiredString(value.operationId, "maintenance operationId");
  sha256(value.requestDigest, "maintenance requestDigest");
  if (value.status !== "prepared") throw new AgentSessionRegistryError("maintenance status must be prepared");
  canonicalIso(value.startedAt, "maintenance startedAt");
  if (!isRecord(value.details)) throw new AgentSessionRegistryError("maintenance details must be an object");
  if (value.kind === "creation") {
    if (value.baseRecordRevision !== null) throw new AgentSessionRegistryError("creation baseRecordRevision must be null");
    validateCreationOrRestorationStages(agentSessionId, {
      kind: "creation",
      incarnationId: value.incarnationId as string,
      baseRecordRevision: null,
    }, value.details);
    nullableAbsolutePath(value.details.transcriptPath, "maintenance transcriptPath");
    nullableAbsolutePath(value.details.auditLogPath, "maintenance auditLogPath");
  } else if (value.kind === "restoration") {
    positiveInteger(value.baseRecordRevision, "maintenance baseRecordRevision");
    validateCreationOrRestorationStages(agentSessionId, {
      kind: "restoration",
      incarnationId: value.incarnationId as string,
      baseRecordRevision: value.baseRecordRevision as number,
    }, value.details);
    validateRestorationTarget(value.details.transcript, "maintenance transcript");
    validateRestorationTarget(value.details.auditLog, "maintenance auditLog");
  } else if (value.kind === "persistence_reconfiguration") {
    positiveInteger(value.baseRecordRevision, "maintenance baseRecordRevision");
    validateReconfigurationTarget(value.details.transcript, "maintenance transcript");
    validateReconfigurationTarget(value.details.auditLog, "maintenance auditLog");
  } else if (value.kind === "deletion") {
    positiveInteger(value.baseRecordRevision, "maintenance baseRecordRevision");
    for (const field of ["deleteTranscript", "deleteAuditLog", "removeRegistryEntry"] as const) {
      if (typeof value.details[field] !== "boolean") throw new AgentSessionRegistryError(`maintenance ${field} must be boolean`);
    }
    nullableAbsolutePath(value.details.transcriptPath, "maintenance transcriptPath");
    nullableAbsolutePath(value.details.auditLogPath, "maintenance auditLogPath");
  } else {
    throw new AgentSessionRegistryError("maintenance kind is invalid");
  }
}

function validateCreationOrRestorationStages(
  agentSessionId: string,
  maintenance: {
    kind: "creation" | "restoration";
    incarnationId: string;
    baseRecordRevision: number | null;
  },
  details: Record<string, unknown>,
): void {
  const stagedContinuation = details.stagedContinuation;
  const stagedRecord = details.stagedRecord;
  if (stagedRecord !== undefined && stagedContinuation === undefined) {
    throw new AgentSessionRegistryError("stagedRecord requires stagedContinuation");
  }
  if (stagedContinuation !== undefined) validateStagedContinuation(stagedContinuation);
  if (stagedRecord !== undefined) {
    validateAgentSessionRecord(stagedRecord);
    if (stagedRecord.agentSessionId !== agentSessionId || stagedRecord.incarnationId !== maintenance.incarnationId) {
      throw new AgentSessionRegistryError("stagedRecord identity mismatch");
    }
    const expectedRevision = maintenance.baseRecordRevision === null ? 1 : maintenance.baseRecordRevision + 1;
    if (stagedRecord.recordRevision !== expectedRevision) throw new AgentSessionRegistryError("stagedRecord revision mismatch");
    const matchingFields = maintenance.kind === "creation"
      ? ["adapterId", "mode", "internalSessionId", "internalSessionActivatedAt", "model", "sessionConfiguration", "protocol"] as const
      : ["adapterId", "mode", "internalSessionId", "internalSessionActivatedAt", "protocol"] as const;
    for (const field of matchingFields) {
      if (canonicalizeJson(stagedRecord[field]) !== canonicalizeJson((stagedContinuation as Record<string, unknown>)[field])) {
        throw new AgentSessionRegistryError(`stagedRecord ${field} disagrees with stagedContinuation`);
      }
    }
  }
}

function validateStagedContinuation(value: unknown): void {
  if (!isRecord(value)) throw new AgentSessionRegistryError("stagedContinuation must be an object");
  requiredString(value.adapterId, "stagedContinuation adapterId");
  if (value.mode !== "normal" && value.mode !== "degraded") throw new AgentSessionRegistryError("stagedContinuation mode is invalid");
  if (value.internalSessionId !== null) requiredString(value.internalSessionId, "stagedContinuation internalSessionId");
  if (value.internalSessionActivatedAt !== null) canonicalIso(value.internalSessionActivatedAt, "stagedContinuation internalSessionActivatedAt");
  if ((value.internalSessionId === null) !== (value.internalSessionActivatedAt === null)) throw new AgentSessionRegistryError("stagedContinuation internal identity/time mismatch");
  if (value.model !== null) requiredString(value.model, "stagedContinuation model");
  if (!isRecord(value.protocol) || (value.protocol.name !== "pty" && value.protocol.name !== "acp")) throw new AgentSessionRegistryError("stagedContinuation protocol is invalid");
  if (value.protocol.name === "acp") positiveInteger(value.protocol.version, "stagedContinuation protocol version");
  try { validateSessionConfigurationCheckpoint(value.sessionConfiguration, value.adapterId as string); } catch (error) {
    throw new AgentSessionRegistryError("stagedContinuation configuration is invalid", { cause: error });
  }
}

function validateRestorationTarget(value: unknown, label: string): void {
  if (!isRecord(value) || !["retain", "disable", "replace"].includes(value.action as string)) throw new AgentSessionRegistryError(`${label} target is invalid`);
  if (value.action === "retain" || value.action === "replace") absolutePath(value.path, `${label} path`);
}

function validateReconfigurationTarget(value: unknown, label: string): void {
  if (value === null) return;
  if (!isRecord(value) || !["disable", "replace"].includes(value.action as string)) throw new AgentSessionRegistryError(`${label} target is invalid`);
  absolutePath(value.previousPath, `${label} previousPath`);
  if (value.action === "replace") absolutePath(value.replacementPath, `${label} replacementPath`);
}

function validateMaintenanceAdvance(current: SessionMaintenance, next: SessionMaintenance): void {
  if (!sameMaintenanceIdentity(current, next) || current.startedAt !== next.startedAt || current.baseRecordRevision !== next.baseRecordRevision || current.kind !== next.kind) {
    throw new AgentSessionStoreConflictError("maintenance update changed immutable transaction identity");
  }
  if (current.kind !== "creation" && current.kind !== "restoration") {
    if (canonicalizeJson(current) !== canonicalizeJson(next)) throw new AgentSessionStoreConflictError("this maintenance kind has no staged update");
    return;
  }
  const currentDetails = current.details as { stagedContinuation?: unknown; stagedRecord?: unknown };
  const nextDetails = next.details as { stagedContinuation?: unknown; stagedRecord?: unknown };
  if (currentDetails.stagedContinuation === undefined && nextDetails.stagedRecord !== undefined) {
    throw new AgentSessionStoreConflictError("stagedContinuation must be committed before stagedRecord");
  }
  for (const field of ["stagedContinuation", "stagedRecord"] as const) {
    if (currentDetails[field] !== undefined && canonicalizeJson(currentDetails[field]) !== canonicalizeJson(nextDetails[field])) {
      throw new AgentSessionStoreConflictError(`maintenance update changed ${field}`);
    }
  }
  const stripStaged = (details: Record<string, unknown>) => Object.fromEntries(Object.entries(details).filter(([key]) => key !== "stagedContinuation" && key !== "stagedRecord"));
  if (canonicalizeJson(stripStaged(current.details)) !== canonicalizeJson(stripStaged(next.details))) {
    throw new AgentSessionStoreConflictError("maintenance update changed normalized targets");
  }
}

function sameMaintenanceIdentity(a: SessionMaintenance, b: SessionMaintenance): boolean {
  return a.incarnationId === b.incarnationId && a.operationId === b.operationId && a.requestDigest === b.requestDigest && a.kind === b.kind;
}

function assertMaintenanceIdentity(value: SessionMaintenance, incarnationId: string, operationId: string, requestDigest: string): void {
  if (value.incarnationId !== incarnationId || value.operationId !== operationId || value.requestDigest !== requestDigest) {
    throw new AgentSessionStoreConflictError("maintenance identity mismatch");
  }
}

function findReceipt(file: AgentSessionsRegistryFile, id: string, incarnationId: string, operationId: string): MaintenanceCompletionReceipt | undefined {
  return file.maintenanceReceipts[id]?.find((receipt) => receipt.incarnationId === incarnationId && receipt.operationId === operationId);
}

function addReceipt(file: MutableRegistry, receipt: MaintenanceCompletionReceipt): void {
  const list = [...(file.maintenanceReceipts[receipt.agentSessionId] ?? []), receipt]
    .sort(receiptComparator)
    .slice(-MAX_RECEIPTS_PER_SESSION);
  file.maintenanceReceipts[receipt.agentSessionId] = list;
  const all = Object.values(file.maintenanceReceipts).flat().sort(receiptComparator);
  while (all.length > MAX_RECEIPTS_GLOBAL) {
    const evicted = all.shift()!;
    file.maintenanceReceipts[evicted.agentSessionId] = file.maintenanceReceipts[evicted.agentSessionId]!.filter((item) => item !== evicted);
    if (file.maintenanceReceipts[evicted.agentSessionId]!.length === 0) delete file.maintenanceReceipts[evicted.agentSessionId];
  }
}

function receiptComparator(a: MaintenanceCompletionReceipt, b: MaintenanceCompletionReceipt): number {
  return a.completedAt.localeCompare(b.completedAt) || a.agentSessionId.localeCompare(b.agentSessionId) || a.operationId.localeCompare(b.operationId);
}

function validateReceipt(id: string, value: unknown): asserts value is MaintenanceCompletionReceipt {
  if (!isRecord(value) || value.agentSessionId !== id || value.outcome !== "completed") throw new AgentSessionRegistryError(`invalid receipt for ${id}`);
  requiredString(value.incarnationId, "receipt incarnationId");
  requiredString(value.operationId, "receipt operationId");
  sha256(value.requestDigest, "receipt requestDigest");
  canonicalIso(value.completedAt, "receipt completedAt");
  if (!["creation", "restoration", "persistence_reconfiguration", "deletion"].includes(value.kind as string)) throw new AgentSessionRegistryError("receipt kind is invalid");
}

function sessionComparator(order: NonNullable<ListAgentSessionsOptions["order"]>) {
  const field = order.startsWith("created") ? "createdAt" : "updatedAt";
  const direction = order.endsWith("desc") ? -1 : 1;
  return (a: AgentSessionRecord, b: AgentSessionRecord) => direction * (a[field].localeCompare(b[field]) || a.agentSessionId.localeCompare(b.agentSessionId));
}

interface CursorPayload { v: 1; kind: "sessions" | "maintenance"; revision: number; offset: number; filter: unknown }
function encodeCursor(value: CursorPayload): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decodeCursor(cursor: string | undefined, kind: CursorPayload["kind"], revision: number, filter: unknown): number {
  if (!cursor) return 0;
  try {
    if (Buffer.byteLength(cursor, "utf8") > 16_384) throw new Error("too large");
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (value.v !== 1 || value.kind !== kind || value.revision !== revision || !Number.isSafeInteger(value.offset) || value.offset < 0 || canonicalizeJson(value.filter) !== canonicalizeJson(filter)) throw new Error("mismatch");
    return value.offset;
  } catch {
    throw new AgentSessionRegistryCursorError("registry cursor is invalid or stale");
  }
}

async function writeSynced(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
}
async function syncFile(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function isExists(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "EEXIST"; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function boundedInteger(value: number, min: number, max: number, name: string): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new AgentSessionRegistryError(`${name} must be ${min}..${max}`); return value; }
function listLimit(value: number | undefined): number { return boundedInteger(value ?? 50, 1, 500, "list limit"); }
function nonnegativeInteger(value: unknown, label: string): void { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AgentSessionRegistryError(`${label} is invalid`); }
function positiveInteger(value: unknown, label: string): void { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new AgentSessionRegistryError(`${label} is invalid`); }
function requiredString(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new AgentSessionRegistryError(`${label} is invalid`); return value; }
function sha256(value: unknown, label: string): void { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new AgentSessionRegistryError(`${label} is invalid`); }
function canonicalIso(value: unknown, label: string): void { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new AgentSessionRegistryError(`${label} is invalid`); }
function absolutePath(value: unknown, label: string): void { if (typeof value !== "string" || !isAbsolute(value)) throw new AgentSessionRegistryError(`${label} must be absolute`); }
function nullableAbsolutePath(value: unknown, label: string): void { if (value !== null) absolutePath(value, label); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
