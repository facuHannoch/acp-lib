import { isAbsolute } from "node:path";
import type {
  AuditLogCapturePolicy,
  PersistenceLimits,
  TranscriptCapturePolicy,
  TranscriptPreset,
} from "./config.ts";
import {
  validateAuditLogCapturePolicy,
  validatePersistenceLimits,
  validateTranscriptCapturePolicy,
} from "./config.ts";
import {
  validateAgentSessionCheckpoint,
  validateSessionConfigurationCheckpoint,
  type AgentSessionCheckpoint,
  type JsonValue,
  type PersistedProtocol,
  type SessionConfigurationCheckpoint,
} from "./checkpoint.ts";
import { canonicalizeJson, sha256CanonicalJson } from "./integrity.ts";
import type { InternalSessionHistoryEntry } from "./records.ts";

export interface StagedContinuationState {
  readonly adapterId: string;
  readonly mode: "normal" | "degraded";
  readonly internalSessionId: string | null;
  readonly internalSessionActivatedAt: string | null;
  readonly model: string | null;
  readonly sessionConfiguration: SessionConfigurationCheckpoint;
  readonly protocol: PersistedProtocol;
}

interface MaintenanceBase {
  readonly incarnationId: string;
  readonly baseRecordRevision: number | null;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly status: "prepared";
  readonly startedAt: string;
}

export interface CreationMaintenance extends MaintenanceBase {
  readonly kind: "creation";
  readonly baseRecordRevision: null;
  readonly details: {
    readonly transcriptPath: string | null;
    readonly auditLogPath: string | null;
    readonly stagedContinuation?: StagedContinuationState;
    readonly stagedRecord?: AgentSessionRecord;
  };
}

export interface RestorationMaintenance extends MaintenanceBase {
  readonly kind: "restoration";
  readonly baseRecordRevision: number;
  readonly details: {
    readonly transcript:
      | { readonly action: "retain"; readonly path: string }
      | { readonly action: "disable" }
      | { readonly action: "replace"; readonly path: string };
    readonly auditLog:
      | { readonly action: "retain"; readonly path: string }
      | { readonly action: "disable" }
      | { readonly action: "replace"; readonly path: string };
    readonly stagedContinuation?: StagedContinuationState;
    readonly stagedRecord?: AgentSessionRecord;
  };
}

export interface PersistenceReconfigurationMaintenance extends MaintenanceBase {
  readonly kind: "persistence_reconfiguration";
  readonly baseRecordRevision: number;
  readonly details: {
    readonly transcript:
      | null
      | { readonly action: "disable"; readonly previousPath: string }
      | { readonly action: "replace"; readonly previousPath: string; readonly replacementPath: string };
    readonly auditLog:
      | null
      | { readonly action: "disable"; readonly previousPath: string }
      | { readonly action: "replace"; readonly previousPath: string; readonly replacementPath: string };
  };
}

export interface DeletionMaintenance extends MaintenanceBase {
  readonly kind: "deletion";
  readonly baseRecordRevision: number;
  readonly details: {
    readonly deleteTranscript: boolean;
    readonly transcriptPath: string | null;
    readonly deleteAuditLog: boolean;
    readonly auditLogPath: string | null;
    readonly removeRegistryEntry: boolean;
  };
}

export type SessionMaintenance =
  | CreationMaintenance
  | RestorationMaintenance
  | PersistenceReconfigurationMaintenance
  | DeletionMaintenance;

export interface MaintenanceCompletionReceipt {
  readonly agentSessionId: string;
  readonly incarnationId: string;
  readonly kind: SessionMaintenance["kind"];
  readonly operationId: string;
  readonly requestDigest: string;
  readonly outcome: "completed";
  readonly completedAt: string;
}

export type PrepareMaintenanceResult =
  | { readonly status: "prepared"; readonly maintenance: SessionMaintenance }
  | { readonly status: "already_prepared"; readonly maintenance: SessionMaintenance }
  | { readonly status: "already_completed"; readonly receipt: MaintenanceCompletionReceipt };

export interface AgentSessionRecord {
  readonly agentSessionId: string;
  readonly incarnationId: string;
  readonly recordRevision: number;
  readonly checkpoint: AgentSessionCheckpoint;
  readonly adapterId: string;
  readonly mode: "normal" | "degraded";
  readonly internalSessionId: string | null;
  readonly internalSessionActivatedAt: string | null;
  readonly internalSessionHistory: readonly InternalSessionHistoryEntry[];
  readonly cwd?: string;
  readonly title?: string;
  readonly model: string | null;
  readonly sessionConfiguration: SessionConfigurationCheckpoint;
  /** Immutable persistence policy needed to keep filtering restoration targets after reopen. */
  readonly sessionConfigurationPersistence?: {
    readonly values: "none" | "typed" | "all";
    readonly include: readonly string[];
    readonly exclude: readonly string[];
  };
  readonly protocol: PersistedProtocol;
  readonly agent?: { readonly name?: string; readonly title?: string; readonly version?: string };
  readonly transcript: null | {
    readonly path: string;
    readonly transcriptId: string;
    readonly generation: number;
    readonly preset: TranscriptPreset;
    readonly effectivePolicy: TranscriptCapturePolicy;
    readonly effectiveLimits: PersistenceLimits;
    readonly includeTruncationDigests: boolean;
  };
  readonly auditLog: null | {
    readonly path: string;
    readonly auditLogId: string;
    readonly generation: number;
    readonly effectivePolicy: AuditLogCapturePolicy;
    readonly effectiveLimits: PersistenceLimits;
    readonly includeTruncationDigests: boolean;
  };
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly deletion?: {
    readonly deletedAt: string;
    readonly transcriptDeletedAt?: string;
    readonly auditLogDeletedAt?: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOpenedAt: string;
}

export interface AgentSessionsRegistryFile {
  readonly version: 1;
  readonly revision: number;
  readonly updatedAt: string;
  readonly sessions: Readonly<Record<string, AgentSessionRecord>>;
  readonly maintenance: Readonly<Record<string, SessionMaintenance>>;
  readonly maintenanceReceipts: Readonly<Record<string, readonly MaintenanceCompletionReceipt[]>>;
}

export type AgentSessionListCursor = string & { readonly __agentSessionListCursor: unique symbol };
export type SessionMaintenanceListCursor = string & { readonly __sessionMaintenanceListCursor: unique symbol };

export interface ListAgentSessionsOptions {
  readonly cursor?: AgentSessionListCursor;
  readonly limit?: number;
  readonly includeDeleted?: boolean;
  readonly order?: "updated_desc" | "updated_asc" | "created_desc" | "created_asc";
}

export interface AgentSessionListPage {
  readonly sessions: readonly AgentSessionSummary[];
  readonly nextCursor: AgentSessionListCursor | null;
  readonly hasMore: boolean;
}

export interface ListSessionMaintenanceOptions {
  readonly cursor?: SessionMaintenanceListCursor;
  readonly limit?: number;
}

export interface SessionMaintenanceSummary {
  readonly agentSessionId: string;
  readonly incarnationId: string;
  readonly kind: SessionMaintenance["kind"];
  readonly operationId: string;
  readonly startedAt: string;
}

export interface SessionMaintenancePage {
  readonly maintenance: readonly SessionMaintenanceSummary[];
  readonly nextCursor: SessionMaintenanceListCursor | null;
  readonly hasMore: boolean;
}

export interface AgentSessionSummary {
  readonly agentSessionId: string;
  readonly incarnationId: string;
  readonly recordRevision: number;
  readonly adapterId: string;
  readonly mode: "normal" | "degraded";
  readonly model: string | null;
  readonly title?: string;
  readonly cwd?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly recovery: "clean" | "required";
  readonly transcriptAvailable: boolean;
  readonly auditLogAvailable: boolean;
  readonly lifecycle: "active" | "maintenance_pending" | "deleted";
  readonly maintenance?: {
    readonly kind: SessionMaintenance["kind"];
    readonly operationId: string;
    readonly startedAt: string;
  };
  readonly deletedAt?: string;
}

export interface AgentSessionStore {
  getAgentSessionRecord(agentSessionId: string): Promise<AgentSessionRecord | null>;
  getMaintenance(agentSessionId: string): Promise<SessionMaintenance | null>;
  listMaintenance(options?: ListSessionMaintenanceOptions): Promise<SessionMaintenancePage>;
  saveAgentSessionRecord(
    record: AgentSessionRecord,
    options:
      | { readonly expectedRecordRevision: null; readonly expectedIncarnationId: null }
      | { readonly expectedRecordRevision: number; readonly expectedIncarnationId: string },
  ): Promise<AgentSessionRecord>;
  deleteAgentSessionRecord(
    agentSessionId: string,
    options: { readonly expectedRecordRevision: number; readonly expectedIncarnationId: string },
  ): Promise<void>;
  listAgentSessions(options?: ListAgentSessionsOptions): Promise<AgentSessionListPage>;
  prepareMaintenance(
    agentSessionId: string,
    maintenance: SessionMaintenance,
    options: { readonly expectedRecordRevision: number | null },
  ): Promise<PrepareMaintenanceResult>;
  updateMaintenance(
    agentSessionId: string,
    expectedIncarnationId: string,
    operationId: string,
    update: SessionMaintenance,
  ): Promise<void>;
  finalizeMaintenance(
    agentSessionId: string,
    expectedIncarnationId: string,
    operationId: string,
    requestDigest: string,
    mutation:
      | { readonly save: AgentSessionRecord; readonly deleteRecord?: never }
      | { readonly save?: never; readonly deleteRecord: true },
  ): Promise<void>;
}

export class AgentSessionRecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSessionRecordValidationError";
  }
}

export class AgentSessionStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSessionStoreConflictError";
  }
}

export class SessionMaintenanceInProgressError extends Error {
  constructor(readonly agentSessionId: string) {
    super(`session ${agentSessionId} has a prepared maintenance operation`);
    this.name = "SessionMaintenanceInProgressError";
  }
}

/** A non-void maintenance retry found a durable completion receipt. */
export class MaintenanceAlreadyCompletedError extends Error {
  constructor(readonly receipt: MaintenanceCompletionReceipt) {
    super(`managed ${receipt.kind} ${receipt.operationId} already completed; load or inspect the persisted session`);
    this.name = "MaintenanceAlreadyCompletedError";
  }
}

export function internalSessionHistoryDigest(
  entries: readonly InternalSessionHistoryEntry[],
): string {
  return sha256CanonicalJson(entries);
}

export function summarizeAgentSessionRecord(
  record: AgentSessionRecord,
  maintenance?: SessionMaintenance,
): AgentSessionSummary {
  const lifecycle = maintenance ? "maintenance_pending" : record.deletion ? "deleted" : "active";
  return {
    agentSessionId: record.agentSessionId,
    incarnationId: record.incarnationId,
    recordRevision: record.recordRevision,
    adapterId: record.adapterId,
    mode: record.mode,
    model: record.model,
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    recovery: record.checkpoint.boundary.status === "settled" ? "clean" : "required",
    transcriptAvailable: record.transcript !== null && record.deletion?.transcriptDeletedAt === undefined,
    auditLogAvailable: record.auditLog !== null && record.deletion?.auditLogDeletedAt === undefined,
    lifecycle,
    ...(maintenance ? { maintenance: { kind: maintenance.kind, operationId: maintenance.operationId, startedAt: maintenance.startedAt } } : {}),
    ...(record.deletion ? { deletedAt: record.deletion.deletedAt } : {}),
  };
}

export function validateAgentSessionRecord(value: unknown): asserts value is AgentSessionRecord {
  if (!isRecord(value)) fail("agent-session record must be an object");
  try {
    canonicalizeJson(value);
    validateAgentSessionCheckpoint(value.checkpoint, {
      agentSessionId: requiredString(value.agentSessionId, "agentSessionId"),
      incarnationId: requiredString(value.incarnationId, "incarnationId"),
      adapterId: requiredString(value.adapterId, "adapterId"),
    });
  } catch (error) {
    fail(`record or checkpoint is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  positiveInteger(value.recordRevision, "recordRevision");
  oneOf(value.mode, ["normal", "degraded"], "mode");
  if (!Array.isArray(value.internalSessionHistory)) fail("internalSessionHistory must be an array");
  const checkpoint = value.checkpoint as AgentSessionCheckpoint;
  for (const field of ["adapterId", "mode", "internalSessionId", "internalSessionActivatedAt", "model", "protocol", "sessionConfiguration"] as const) {
    if (canonicalizeJson(value[field]) !== canonicalizeJson(checkpoint[field])) {
      fail(`${field} projection disagrees with checkpoint`);
    }
  }
  if (value.internalSessionHistory.length !== checkpoint.internalSessionHistoryRevision) {
    fail("internalSessionHistory revision disagrees with checkpoint");
  }
  if (internalSessionHistoryDigest(value.internalSessionHistory as InternalSessionHistoryEntry[]) !== checkpoint.internalSessionHistoryDigest) {
    fail("internalSessionHistory digest disagrees with checkpoint");
  }
  try {
    validateSessionConfigurationCheckpoint(value.sessionConfiguration, value.adapterId as string);
  } catch (error) {
    fail(`sessionConfiguration is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateLogMetadata(value.transcript, "transcript", checkpoint);
  validateLogMetadata(value.auditLog, "auditLog", checkpoint);
  optionalString(value.cwd, "cwd");
  optionalString(value.title, "title");
  iso(value.createdAt, "createdAt");
  iso(value.updatedAt, "updatedAt");
  iso(value.lastOpenedAt, "lastOpenedAt");
  if (Date.parse(value.createdAt as string) > Date.parse(value.updatedAt as string)) fail("createdAt cannot be after updatedAt");
  if (value.deletion !== undefined) validateDeletion(value.deletion);
}

function validateLogMetadata(
  value: unknown,
  kind: "transcript" | "auditLog",
  checkpoint: AgentSessionCheckpoint,
): void {
  if (value === null) {
    if (kind === "transcript" && checkpoint.transcript !== null) fail("transcript projection disagrees with checkpoint");
    return;
  }
  if (!isRecord(value)) fail(`${kind} must be null or an object`);
  if (typeof value.path !== "string" || !isAbsolute(value.path)) fail(`${kind}.path must be absolute`);
  positiveInteger(value.generation, `${kind}.generation`);
  if (!isRecord(value.effectivePolicy) || !isRecord(value.effectiveLimits)) fail(`${kind} policy and limits must be objects`);
  if (typeof value.includeTruncationDigests !== "boolean") fail(`${kind}.includeTruncationDigests must be boolean`);
  try {
    validatePersistenceLimits(value.effectiveLimits as unknown as PersistenceLimits);
    if (kind === "transcript") {
      requiredString(value.transcriptId, "transcript.transcriptId");
      oneOf(value.preset, ["conversation", "activity", "detailed", "diagnostic"], "transcript.preset");
      validateTranscriptCapturePolicy(value.effectivePolicy as unknown as TranscriptCapturePolicy);
      if (checkpoint.transcript === null) fail("transcript projection disagrees with checkpoint");
      if (value.path !== checkpoint.transcript.path || value.transcriptId !== checkpoint.transcript.transcriptId || value.generation !== checkpoint.transcript.generation) {
        fail("transcript identity projection disagrees with checkpoint");
      }
    } else {
      requiredString(value.auditLogId, "auditLog.auditLogId");
      validateAuditLogCapturePolicy(value.effectivePolicy as unknown as AuditLogCapturePolicy);
    }
  } catch (error) {
    if (error instanceof AgentSessionRecordValidationError) throw error;
    fail(`${kind} metadata is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateDeletion(value: unknown): void {
  if (!isRecord(value)) fail("deletion must be an object");
  iso(value.deletedAt, "deletion.deletedAt");
  if (value.transcriptDeletedAt !== undefined) iso(value.transcriptDeletedAt, "deletion.transcriptDeletedAt");
  if (value.auditLogDeletedAt !== undefined) iso(value.auditLogDeletedAt, "deletion.auditLogDeletedAt");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be nonblank`);
  return value;
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") fail(`${label} must be a string`);
}

function positiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive safe integer`);
}

function iso(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} must be canonical ISO-8601`);
  }
}

function oneOf(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) fail(`${label} is invalid`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new AgentSessionRecordValidationError(message);
}
