import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { AgentSession, AgentSessionOpenResult } from "../agent-session.ts";
import type { TranscriptPreset } from "../persistence/config.ts";
import type { AgentSessionSummary, DeletionMaintenance, SessionMaintenance } from "../persistence/registry.ts";
import { runAgentSessionRepl } from "../repl/index.ts";
import { SessionManager } from "../session-manager.ts";
import { parseCommandArg, resolveCliAdapter, type CliAdapterSelection } from "./adapter.ts";

interface Common { readonly root?: string }
interface Live extends Common, CliAdapterSelection {
  readonly cwd?: string;
  readonly execPrefix: readonly string[];
  readonly approve: boolean;
  readonly activity: boolean;
  readonly repl: boolean;
}
type Change =
  | { readonly artifact: "transcript"; readonly action: "disable" }
  | { readonly artifact: "transcript"; readonly action: "replace"; readonly preset?: TranscriptPreset }
  | { readonly artifact: "audit"; readonly action: "disable" }
  | { readonly artifact: "audit"; readonly action: "replace"; readonly path: string };

export type ManagedCliCommand =
  | Common & { readonly kind: "sessions"; readonly includeDeleted: boolean; readonly json: boolean }
  | Common & { readonly kind: "info"; readonly agentSessionId: string; readonly includeDeleted: boolean; readonly json: boolean }
  | Common & { readonly kind: "checkpoint"; readonly agentSessionId: string; readonly includeDeleted: boolean; readonly registryProjection: boolean }
  | Common & { readonly kind: "maintenance"; readonly agentSessionId?: string; readonly json: boolean }
  | Live & { readonly kind: "create"; readonly agentSessionId?: string; readonly title?: string; readonly transcript: false | { readonly path?: string; readonly preset?: TranscriptPreset } | undefined; readonly auditLogPath?: string }
  | Live & { readonly kind: "open"; readonly agentSessionId: string }
  | Live & { readonly kind: "restore"; readonly agentSessionId: string; readonly replacementTranscript?: false | { readonly path: string; readonly preset?: TranscriptPreset }; readonly replacementAuditLog?: false | { readonly path: string } }
  | Common & { readonly kind: "reconfigure"; readonly agentSessionId: string; readonly change: Change; readonly yes: boolean }
  | Common & { readonly kind: "delete"; readonly agentSessionId: string; readonly deleteTranscript: boolean; readonly deleteAuditLog: boolean; readonly removeRegistryEntry: boolean; readonly yes: boolean };

export interface ManagedCliIo {
  readonly out?: (text: string) => void;
  readonly error?: (text: string) => void;
  readonly interactive?: boolean;
  readonly confirm?: (prompt: string) => Promise<string>;
  /** Embedding/test seam; defaults to the public one-AgentSession REPL. */
  readonly runSession?: (session: AgentSession, options: { readonly activity: boolean }) => Promise<void>;
}

export class ManagedCliUsageError extends Error {
  constructor(message: string) { super(message); this.name = "ManagedCliUsageError"; }
}

export function parseManagedCliCommand(argv: readonly string[]): ManagedCliCommand {
  const rawKind = argv[0];
  const kind = rawKind === "resume" || rawKind === "load" ? "open" : rawKind;
  if (!kind || !COMMANDS.has(kind)) throw new ManagedCliUsageError(`unsupported managed command: ${rawKind ?? "(missing)"}`);
  const v: Parsed = { seen: new Set(), execPrefix: [], approve: false, activity: true, repl: true, includeDeleted: false, json: false, registryProjection: false, yes: false, transcriptDisabled: false, replacementTranscriptDisabled: false, replacementAuditDisabled: false, disableTranscript: false, replaceTranscript: false, disableAudit: false, deleteTranscript: false, deleteAuditLog: false, removeRegistryEntry: false, positionals: [] };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) v.seen.add(arg);
    if (arg === "--root") v.root = required(argv[++i], arg);
    else if (arg === "--json") v.json = true;
    else if (arg === "--all" || arg === "--include-deleted") v.includeDeleted = true;
    else if (arg === "--registry-projection") v.registryProjection = true;
    else if (arg === "--adapter") v.adapterId = required(argv[++i], arg);
    else if (arg === "--adapter-command") v.command = parseCommandArg(argv[++i], arg);
    else if (arg === "--pty-command") v.ptyCommand = parseCommandArg(argv[++i], arg);
    else if (arg === "--adapter-name") v.displayName = required(argv[++i], arg);
    else if (arg === "--cwd") v.cwd = required(argv[++i], arg);
    else if (arg === "--exec") v.execPrefix = required(argv[++i], arg).split(" ").filter(Boolean);
    else if (arg === "--approve") v.approve = true;
    else if (arg === "--no-activity") v.activity = false;
    else if (arg === "--no-repl") v.repl = false;
    else if (arg === "--title") v.title = required(argv[++i], arg);
    else if (arg === "--no-transcript") v.transcriptDisabled = true;
    else if (arg === "--transcript") v.transcriptPath = required(argv[++i], arg);
    else if (arg === "--preset") v.preset = parsePreset(argv[++i]);
    else if (arg === "--audit-log") v.auditLogPath = required(argv[++i], arg);
    else if (arg === "--replacement-transcript") v.replacementTranscriptPath = required(argv[++i], arg);
    else if (arg === "--no-replacement-transcript") v.replacementTranscriptDisabled = true;
    else if (arg === "--replacement-audit-log") v.replacementAuditPath = required(argv[++i], arg);
    else if (arg === "--no-replacement-audit-log") v.replacementAuditDisabled = true;
    else if (arg === "--disable-transcript") v.disableTranscript = true;
    else if (arg === "--replace-transcript") v.replaceTranscript = true;
    else if (arg === "--disable-audit-log") v.disableAudit = true;
    else if (arg === "--replace-audit-log") v.replaceAuditPath = required(argv[++i], arg);
    else if (arg === "--delete-transcript") v.deleteTranscript = true;
    else if (arg === "--delete-audit-log") v.deleteAuditLog = true;
    else if (arg === "--remove-registry-entry") v.removeRegistryEntry = true;
    else if (arg === "--yes") v.yes = true;
    else if (arg?.startsWith("--")) throw new ManagedCliUsageError(`unknown option for ${kind}: ${arg}`);
    else if (arg) v.positionals.push(arg);
  }
  validateOptions(kind, v.seen);
  if (kind === "sessions") { maxArgs(kind, v, 0); return { kind, root: v.root, includeDeleted: v.includeDeleted, json: v.json }; }
  if (kind === "maintenance") { maxArgs(kind, v, 1); return { kind, root: v.root, ...(v.positionals[0] ? { agentSessionId: v.positionals[0] } : {}), json: v.json }; }
  if (kind === "create") {
    maxArgs(kind, v, 1); conflict(v.transcriptDisabled && !!v.transcriptPath, "--no-transcript and --transcript");
    const transcript = v.transcriptDisabled ? false : v.transcriptPath || v.preset ? { ...(v.transcriptPath ? { path: v.transcriptPath } : {}), ...(v.preset ? { preset: v.preset } : {}) } : undefined;
    return { kind, ...live(v), ...(v.positionals[0] ? { agentSessionId: v.positionals[0] } : {}), ...(v.title ? { title: v.title } : {}), transcript, ...(v.auditLogPath ? { auditLogPath: v.auditLogPath } : {}) };
  }
  const agentSessionId = identity(kind, v);
  if (kind === "info") return { kind, root: v.root, agentSessionId, includeDeleted: v.includeDeleted, json: v.json };
  if (kind === "checkpoint") return { kind, root: v.root, agentSessionId, includeDeleted: v.includeDeleted, registryProjection: v.registryProjection };
  if (kind === "open") return { kind, ...live(v), agentSessionId };
  if (kind === "restore") {
    conflict(v.replacementTranscriptDisabled && !!v.replacementTranscriptPath, "replacement transcript flags");
    conflict(v.replacementAuditDisabled && !!v.replacementAuditPath, "replacement audit flags");
    return { kind, ...live(v), agentSessionId,
      ...(v.replacementTranscriptDisabled ? { replacementTranscript: false as const } : v.replacementTranscriptPath ? { replacementTranscript: { path: v.replacementTranscriptPath, ...(v.preset ? { preset: v.preset } : {}) } } : {}),
      ...(v.replacementAuditDisabled ? { replacementAuditLog: false as const } : v.replacementAuditPath ? { replacementAuditLog: { path: v.replacementAuditPath } } : {}) };
  }
  if (kind === "reconfigure") {
    const count = Number(v.disableTranscript) + Number(v.replaceTranscript) + Number(v.disableAudit) + Number(!!v.replaceAuditPath);
    if (count !== 1) throw new ManagedCliUsageError("reconfigure requires exactly one --disable-* or --replace-* operation");
    const change: Change = v.disableTranscript ? { artifact: "transcript", action: "disable" }
      : v.replaceTranscript ? { artifact: "transcript", action: "replace", ...(v.preset ? { preset: v.preset } : {}) }
      : v.disableAudit ? { artifact: "audit", action: "disable" }
      : { artifact: "audit", action: "replace", path: v.replaceAuditPath! };
    return { kind, root: v.root, agentSessionId, change, yes: v.yes };
  }
  return { kind: "delete", root: v.root, agentSessionId, deleteTranscript: v.deleteTranscript, deleteAuditLog: v.deleteAuditLog, removeRegistryEntry: v.removeRegistryEntry, yes: v.yes };
}

export async function runManagedCliCommand(command: ManagedCliCommand, io: ManagedCliIo = {}, suppliedManager?: SessionManager): Promise<void> {
  const out = io.out ?? ((s: string) => process.stdout.write(s));
  const error = io.error ?? ((s: string) => process.stderr.write(s));
  const manager = suppliedManager ?? await SessionManager.open({ root: command.root });
  if (command.kind === "sessions") {
    const rows = await allSessions(manager, command.includeDeleted);
    if (command.json) out(`${JSON.stringify(rows, null, 2)}\n`); else if (!rows.length) out("No managed agent sessions.\n"); else rows.forEach((row) => out(formatSession(row)));
    return;
  }
  if (command.kind === "info") { const row = await summary(manager, command.agentSessionId, command.includeDeleted); out(command.json ? `${JSON.stringify(row, null, 2)}\n` : formatSession(row)); return; }
  if (command.kind === "checkpoint") {
    const value = await manager.getAgentSessionCheckpoint(command.agentSessionId, { includeDeleted: command.includeDeleted, source: command.registryProjection ? "registry_projection" : "resolved" });
    if (!value) throw missing(command.agentSessionId); out(`${JSON.stringify(value, null, 2)}\n`); return;
  }
  if (command.kind === "maintenance") {
    if (command.agentSessionId) { const value = await manager.getSessionMaintenance(command.agentSessionId); out(command.json ? `${JSON.stringify(value, null, 2)}\n` : value ? formatMaintenance(command.agentSessionId, value) : `No pending maintenance for ${command.agentSessionId}.\n`); return; }
    const rows = await allMaintenance(manager); if (command.json) out(`${JSON.stringify(rows, null, 2)}\n`); else if (!rows.length) out("No pending managed-session maintenance.\n"); else rows.forEach((row) => out(`${row.agentSessionId}\n  ${row.kind} ${row.operationId} · started ${row.startedAt}\n`)); return;
  }
  if (command.kind === "create") {
    const adapter = resolveCliAdapter(command);
    const pending = command.agentSessionId ? await manager.getSessionMaintenance(command.agentSessionId) : null;
    if (pending && pending.kind !== "creation") throw new ManagedCliUsageError(`session has pending ${pending.kind} maintenance; complete it first`);
    const session = await manager.createAgentSession({ adapter: adapter.adapter, adapterId: adapter.adapterId, ...(command.agentSessionId ? { agentSessionId: command.agentSessionId } : {}), ...(pending ? { creationId: pending.operationId } : {}), ...(command.cwd ? { cwd: command.cwd } : {}), ...(command.title ? { title: command.title } : {}), ...(command.execPrefix.length ? { execPrefix: [...command.execPrefix] } : {}), permissions: { default: command.approve ? "allow" : "ask" }, persistence: { ...(command.transcript !== undefined ? { transcript: command.transcript } : {}), ...(command.auditLogPath ? { auditLog: { path: command.auditLogPath } } : {}) } });
    out(`Created managed agent session ${session.agentSessionId}.\n`); await own(session, command, io); return;
  }
  if (command.kind === "open") {
    const row = await summary(manager, command.agentSessionId, false); const adapter = recordedAdapter(command, row);
    const opened = await manager.loadAgentSession(command.agentSessionId, runtime(command, adapter)); reportOpen(opened, error); await own(opened.session, command, io); return;
  }
  if (command.kind === "restore") {
    const [row, pending] = await Promise.all([summary(manager, command.agentSessionId, true), manager.getSessionMaintenance(command.agentSessionId)]);
    if (pending && pending.kind !== "restoration") throw new ManagedCliUsageError(`session has pending ${pending.kind} maintenance; complete it first`);
    if (row.lifecycle !== "deleted" && pending?.kind !== "restoration") throw new ManagedCliUsageError("restore requires a deleted managed session");
    const adapter = recordedAdapter(command, row);
    const replacements = restorationReplacements(command, row, pending);
    const opened = await manager.restoreAgentSession(command.agentSessionId, { ...runtime(command, adapter), restorationId: pending?.operationId ?? `cli-restore-${randomUUID()}`, expectedIncarnationId: pending?.incarnationId ?? row.incarnationId, expectedRecordRevision: pending?.baseRecordRevision ?? row.recordRevision, ...replacements });
    reportOpen(opened, error); await own(opened.session, command, io); return;
  }
  if (command.kind === "reconfigure") {
    const row = await summary(manager, command.agentSessionId, false); if (!command.yes && !await confirm(io, error, row, `About to ${command.change.action} ${command.change.artifact} persistence for ${row.agentSessionId}.\n`, "Reconfiguration")) return;
    const base = { reconfigurationId: `cli-reconfigure-${randomUUID()}`, expectedIncarnationId: row.incarnationId, expectedRecordRevision: row.recordRevision };
    if (command.change.artifact === "transcript") {
      const resolved = await manager.getAgentSessionCheckpoint(command.agentSessionId); if (!resolved?.checkpoint.transcript) throw new ManagedCliUsageError("session has no transcript to reconfigure");
      await manager.reconfigureAgentSessionPersistence(command.agentSessionId, { ...base, transcript: command.change.action === "disable" ? { action: "disable", checkpoint: resolved.checkpoint, deleteExistingLog: true, acknowledgeContinuationLoss: true } : { action: "replace", config: { path: resolved.checkpoint.transcript.path, ...(command.change.preset ? { preset: command.change.preset } : {}) }, checkpoint: resolved.checkpoint, acknowledgeContinuationLoss: true } });
    } else await manager.reconfigureAgentSessionPersistence(command.agentSessionId, { ...base, auditLog: command.change.action === "disable" ? { action: "disable", deleteExistingLog: true, acknowledgeAuditGap: true } : { action: "replace", config: { path: command.change.path }, acknowledgeAuditGap: true } });
    out(`Reconfigured ${command.change.artifact} persistence for ${command.agentSessionId}.\n`); return;
  }
  const [row, pending] = await Promise.all([manager.getAgentSessionInfo(command.agentSessionId, { includeDeleted: true }), manager.getSessionMaintenance(command.agentSessionId)]); if (!row) throw missing(command.agentSessionId);
  const intent = { deleteTranscript: command.deleteTranscript, deleteAuditLog: command.deleteAuditLog, removeRegistryEntry: command.removeRegistryEntry }; const retry = pending ? deletionRetry(pending, intent) : null;
  if (!command.yes && !await confirm(io, error, row, deletionPreview(row, intent), "Deletion")) return;
  await manager.deleteAgentSession(row.agentSessionId, { deletionId: retry?.operationId ?? `cli-delete-${randomUUID()}`, expectedIncarnationId: retry?.incarnationId ?? row.incarnationId, expectedRecordRevision: retry?.baseRecordRevision ?? row.recordRevision, ...intent });
  out(command.removeRegistryEntry ? `Removed managed agent session ${row.agentSessionId}.\n` : `Deleted managed agent session ${row.agentSessionId}; registry tombstone retained.\n`);
}

interface Parsed {
  seen: Set<string>;
  root?: string; adapterId?: string; command?: string[]; ptyCommand?: string[]; displayName?: string; cwd?: string; execPrefix: string[]; approve: boolean; activity: boolean; repl: boolean; includeDeleted: boolean; json: boolean; registryProjection: boolean; yes: boolean; title?: string; transcriptDisabled: boolean; transcriptPath?: string; preset?: TranscriptPreset; auditLogPath?: string; replacementTranscriptDisabled: boolean; replacementTranscriptPath?: string; replacementAuditDisabled: boolean; replacementAuditPath?: string; disableTranscript: boolean; replaceTranscript: boolean; disableAudit: boolean; replaceAuditPath?: string; deleteTranscript: boolean; deleteAuditLog: boolean; removeRegistryEntry: boolean; positionals: string[];
}
const COMMANDS = new Set(["sessions", "info", "checkpoint", "maintenance", "create", "open", "restore", "reconfigure", "delete"]);
function live(v: Parsed): Live { return { root: v.root, ...(v.adapterId ? { adapterId: v.adapterId } : {}), ...(v.command ? { command: v.command } : {}), ...(v.ptyCommand ? { ptyCommand: v.ptyCommand } : {}), ...(v.displayName ? { displayName: v.displayName } : {}), ...(v.cwd ? { cwd: v.cwd } : {}), execPrefix: v.execPrefix, approve: v.approve, activity: v.activity, repl: v.repl }; }
function runtime(command: Live, adapter: ReturnType<typeof resolveCliAdapter>) { return { adapter: adapter.adapter, adapterId: adapter.adapterId, ...(command.cwd ? { cwd: command.cwd } : {}), ...(command.execPrefix.length ? { execPrefix: [...command.execPrefix] } : {}), permissions: { default: command.approve ? "allow" as const : "ask" as const } }; }
function recordedAdapter(command: Live, row: AgentSessionSummary) { if (command.adapterId && command.adapterId !== row.adapterId && !command.command) throw new ManagedCliUsageError(`recorded adapter is ${row.adapterId}; changing adapters requires an explicit continuation strategy`); return resolveCliAdapter({ adapterId: command.adapterId ?? row.adapterId, command: command.command ? [...command.command] : undefined, ptyCommand: command.ptyCommand ? [...command.ptyCommand] : undefined, displayName: command.displayName }); }
async function own(session: AgentSession, command: Live, io: ManagedCliIo) { try { if (command.repl) io.runSession ? await io.runSession(session, { activity: command.activity }) : await runAgentSessionRepl(session, { activity: command.activity }); } finally { await session.stop(); } }
function reportOpen(opened: AgentSessionOpenResult, error: (s: string) => void) { error(`Continuation: ${opened.continuation.outcome.kind}; recovery: ${opened.recovery.kind}; configuration: ${opened.configuration.kind}; promptable: ${opened.promptability.promptable}.\n`); opened.repairs.forEach((repair) => error(`Persistence repair: ${JSON.stringify(repair)}\n`)); }
async function allSessions(manager: SessionManager, includeDeleted: boolean) { const rows: AgentSessionSummary[] = []; let cursor; do { const page = await manager.listAgentSessions({ cursor, limit: 100, includeDeleted }); rows.push(...page.sessions); cursor = page.nextCursor ?? undefined; } while (cursor); return rows; }
async function allMaintenance(manager: SessionManager) { const rows: Array<{ agentSessionId: string; kind: SessionMaintenance["kind"]; operationId: string; startedAt: string }> = []; let cursor; do { const page = await manager.listSessionMaintenance({ cursor, limit: 100 }); rows.push(...page.maintenance); cursor = page.nextCursor ?? undefined; } while (cursor); return rows; }
async function summary(manager: SessionManager, id: string, includeDeleted: boolean) { const row = await manager.getAgentSessionInfo(id, { includeDeleted }); if (!row) throw missing(id); return row; }
function missing(id: string) { return new ManagedCliUsageError(`managed agent session not found: ${id}`); }
function formatSession(row: AgentSessionSummary) { const state = row.lifecycle === "active" ? `active, recovery ${row.recovery}` : row.lifecycle === "deleted" ? `deleted ${row.deletedAt ?? ""}`.trim() : `maintenance pending (${row.maintenance?.kind ?? "unknown"})`; return `${row.agentSessionId}\n  ${row.adapterId}/${row.mode}${row.model ? ` · ${row.model}` : ""}\n  ${state} · transcript ${row.transcriptAvailable ? "available" : "unavailable"} · audit ${row.auditLogAvailable ? "available" : "unavailable"}\n  updated ${row.updatedAt}\n`; }
function formatMaintenance(id: string, value: SessionMaintenance) { return `${id}\n  ${value.kind} ${value.operationId} · started ${value.startedAt}\n`; }
function deletionPreview(row: AgentSessionSummary, intent: { deleteTranscript: boolean; deleteAuditLog: boolean; removeRegistryEntry: boolean }) { const actions = ["tombstone the managed session"]; if (intent.deleteTranscript) actions.push("permanently delete its transcript"); if (intent.deleteAuditLog) actions.push("permanently delete its audit log"); if (intent.removeRegistryEntry) actions.push("permanently remove its registry entry"); return `About to ${actions.join(", ")} for ${row.agentSessionId}.\n`; }
async function confirm(io: ManagedCliIo, error: (s: string) => void, row: AgentSessionSummary, preview: string, label: string) { if (io.interactive === false || (io.interactive === undefined && !process.stdin.isTTY)) throw new ManagedCliUsageError("refusing non-interactive destructive operation without --yes"); error(preview); const answer = io.confirm ? await io.confirm(`Type ${row.agentSessionId} to confirm: `) : await prompt(`Type ${row.agentSessionId} to confirm: `); if (answer.trim() === row.agentSessionId) return true; error(`${label} cancelled.\n`); return false; }
function deletionRetry(value: SessionMaintenance, intent: { deleteTranscript: boolean; deleteAuditLog: boolean; removeRegistryEntry: boolean }): DeletionMaintenance { if (value.kind !== "deletion") throw new ManagedCliUsageError(`session has pending ${value.kind} maintenance; complete it first`); if (value.details.deleteTranscript !== intent.deleteTranscript || value.details.deleteAuditLog !== intent.deleteAuditLog || value.details.removeRegistryEntry !== intent.removeRegistryEntry) throw new ManagedCliUsageError("session has a different pending deletion; repeat the original deletion flags"); return value; }
function restorationReplacements(command: Extract<ManagedCliCommand, { kind: "restore" }>, row: AgentSessionSummary, pending: Extract<SessionMaintenance, { kind: "restoration" }> | null) {
  const transcript = command.replacementTranscript ?? (pending ? pending.details.transcript.action === "retain" ? undefined : pending.details.transcript.action === "disable" ? false : { path: pending.details.transcript.path } : row.transcriptAvailable ? undefined : false);
  const auditLog = command.replacementAuditLog ?? (pending ? pending.details.auditLog.action === "retain" ? undefined : pending.details.auditLog.action === "disable" ? false : { path: pending.details.auditLog.path } : row.auditLogAvailable ? undefined : false);
  return { replacementTranscript: transcript, replacementAuditLog: auditLog };
}
async function prompt(text: string) { const rl = createInterface({ input: process.stdin, output: process.stderr }); try { return await rl.question(text); } finally { rl.close(); } }
function identity(kind: string, v: Parsed) { maxArgs(kind, v, 1); if (!v.positionals[0]?.trim()) throw new ManagedCliUsageError(`${kind} requires AGENT_SESSION_ID`); return v.positionals[0]; }
function maxArgs(kind: string, v: Parsed, max: number) { if (v.positionals.length > max) throw new ManagedCliUsageError(`unexpected argument for ${kind}: ${v.positionals[max]}`); }
function required(value: string | undefined, flag: string) { if (!value?.trim()) throw new ManagedCliUsageError(`${flag} requires a value`); return value; }
function parsePreset(value: string | undefined): TranscriptPreset { const p = required(value, "--preset"); if (p !== "conversation" && p !== "activity" && p !== "detailed" && p !== "diagnostic") throw new ManagedCliUsageError(`unknown transcript preset: ${p}`); return p; }
function conflict(condition: boolean, description: string) { if (condition) throw new ManagedCliUsageError(`conflicting options: ${description}`); }
function validateOptions(kind: string, seen: ReadonlySet<string>) {
  const common = ["--root"];
  const live = ["--adapter", "--adapter-command", "--pty-command", "--adapter-name", "--cwd", "--exec", "--approve", "--no-activity", "--no-repl"];
  const byKind: Record<string, readonly string[]> = {
    sessions: ["--all", "--include-deleted", "--json"],
    info: ["--all", "--include-deleted", "--json"],
    checkpoint: ["--all", "--include-deleted", "--registry-projection"],
    maintenance: ["--json"],
    create: [...live, "--title", "--no-transcript", "--transcript", "--preset", "--audit-log"],
    open: live,
    restore: [...live, "--replacement-transcript", "--no-replacement-transcript", "--replacement-audit-log", "--no-replacement-audit-log", "--preset"],
    reconfigure: ["--disable-transcript", "--replace-transcript", "--disable-audit-log", "--replace-audit-log", "--preset", "--yes"],
    delete: ["--delete-transcript", "--delete-audit-log", "--remove-registry-entry", "--yes"],
  };
  const allowed = new Set([...common, ...(byKind[kind] ?? [])]);
  for (const flag of seen) if (!allowed.has(flag)) throw new ManagedCliUsageError(`unknown option for ${kind}: ${flag}`);
}
