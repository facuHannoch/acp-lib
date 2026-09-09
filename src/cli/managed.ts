import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type {
  AgentSessionSummary,
  DeletionMaintenance,
  SessionMaintenance,
} from "../persistence/registry.ts";
import { SessionManager } from "../session-manager.ts";

export type ManagedCliCommand =
  | {
      readonly kind: "sessions";
      readonly root?: string;
      readonly includeDeleted: boolean;
      readonly json: boolean;
    }
  | {
      readonly kind: "delete";
      readonly root?: string;
      readonly agentSessionId: string;
      readonly deleteTranscript: boolean;
      readonly deleteAuditLog: boolean;
      readonly removeRegistryEntry: boolean;
      readonly yes: boolean;
    };

export interface ManagedCliIo {
  readonly out?: (text: string) => void;
  readonly error?: (text: string) => void;
  readonly interactive?: boolean;
  readonly confirm?: (prompt: string) => Promise<string>;
}

export class ManagedCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedCliUsageError";
  }
}

export function parseManagedCliCommand(argv: readonly string[]): ManagedCliCommand {
  const kind = argv[0];
  if (kind !== "sessions" && kind !== "delete") {
    throw new ManagedCliUsageError(`unsupported managed command: ${kind ?? "(missing)"}`);
  }
  let root: string | undefined;
  let includeDeleted = false;
  let json = false;
  let deleteTranscript = false;
  let deleteAuditLog = false;
  let removeRegistryEntry = false;
  let yes = false;
  let agentSessionId: string | undefined;

  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--root") root = requiredValue(argv[++index], "--root");
    else if (kind === "sessions" && (arg === "--all" || arg === "--include-deleted")) includeDeleted = true;
    else if (kind === "sessions" && arg === "--json") json = true;
    else if (kind === "delete" && arg === "--delete-transcript") deleteTranscript = true;
    else if (kind === "delete" && arg === "--delete-audit-log") deleteAuditLog = true;
    else if (kind === "delete" && arg === "--remove-registry-entry") removeRegistryEntry = true;
    else if (kind === "delete" && arg === "--yes") yes = true;
    else if (arg?.startsWith("--")) throw new ManagedCliUsageError(`unknown option for ${kind}: ${arg}`);
    else if (kind === "delete" && arg && agentSessionId === undefined) agentSessionId = arg;
    else throw new ManagedCliUsageError(`unexpected argument for ${kind}: ${arg ?? "(missing)"}`);
  }

  if (kind === "sessions") return { kind, root, includeDeleted, json };
  if (!agentSessionId?.trim()) {
    throw new ManagedCliUsageError(
      "usage: acp-client delete AGENT_SESSION_ID [--delete-transcript] " +
        "[--delete-audit-log] [--remove-registry-entry] [--yes]",
    );
  }
  return {
    kind,
    root,
    agentSessionId,
    deleteTranscript,
    deleteAuditLog,
    removeRegistryEntry,
    yes,
  };
}

export async function runManagedCliCommand(
  command: ManagedCliCommand,
  io: ManagedCliIo = {},
  suppliedManager?: SessionManager,
): Promise<void> {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  const error = io.error ?? ((text: string) => process.stderr.write(text));
  const manager = suppliedManager ?? await SessionManager.open({ root: command.root });
  if (command.kind === "sessions") {
    const sessions = await readAllSessions(manager, command.includeDeleted);
    if (command.json) {
      out(`${JSON.stringify(sessions, null, 2)}\n`);
      return;
    }
    if (sessions.length === 0) {
      out("No managed agent sessions.\n");
      return;
    }
    for (const session of sessions) out(formatSession(session));
    return;
  }

  const [summary, pending] = await Promise.all([
    manager.getAgentSessionInfo(command.agentSessionId, { includeDeleted: true }),
    manager.getSessionMaintenance(command.agentSessionId),
  ]);
  if (!summary) throw new ManagedCliUsageError(`managed agent session not found: ${command.agentSessionId}`);
  const intent = {
    deleteTranscript: command.deleteTranscript,
    deleteAuditLog: command.deleteAuditLog,
    removeRegistryEntry: command.removeRegistryEntry,
  };
  const retry = pending === null ? null : deletionRetry(pending, intent);
  if (!command.yes) {
    if (io.interactive === false || (io.interactive === undefined && !process.stdin.isTTY)) {
      throw new ManagedCliUsageError("refusing non-interactive deletion without --yes");
    }
    error(deletionPreview(summary, intent));
    const answer = io.confirm
      ? await io.confirm(`Type ${summary.agentSessionId} to confirm: `)
      : await promptForConfirmation(`Type ${summary.agentSessionId} to confirm: `);
    if (answer.trim() !== summary.agentSessionId) {
      error("Deletion cancelled.\n");
      return;
    }
  }

  await manager.deleteAgentSession(summary.agentSessionId, {
    deletionId: retry?.operationId ?? `cli-delete-${randomUUID()}`,
    expectedIncarnationId: retry?.incarnationId ?? summary.incarnationId,
    expectedRecordRevision: retry?.baseRecordRevision ?? summary.recordRevision,
    ...intent,
  });
  out(command.removeRegistryEntry
    ? `Removed managed agent session ${summary.agentSessionId}.\n`
    : `Deleted managed agent session ${summary.agentSessionId}; registry tombstone retained.\n`);
}

async function readAllSessions(
  manager: SessionManager,
  includeDeleted: boolean,
): Promise<AgentSessionSummary[]> {
  const sessions: AgentSessionSummary[] = [];
  let cursor;
  do {
    const page = await manager.listAgentSessions({ cursor, limit: 100, includeDeleted });
    sessions.push(...page.sessions);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return sessions;
}

function formatSession(session: AgentSessionSummary): string {
  const state = session.lifecycle === "active"
    ? `active, recovery ${session.recovery}`
    : session.lifecycle === "deleted"
      ? `deleted ${session.deletedAt ?? ""}`.trim()
      : `maintenance pending (${session.maintenance?.kind ?? "unknown"})`;
  return [
    `${session.agentSessionId}\n`,
    `  ${session.adapterId}/${session.mode}${session.model ? ` · ${session.model}` : ""}\n`,
    `  ${state} · transcript ${availability(session.transcriptAvailable)} · audit ${availability(session.auditLogAvailable)}\n`,
    `  updated ${session.updatedAt}\n`,
  ].join("");
}

function availability(available: boolean): string {
  return available ? "available" : "unavailable";
}

function deletionPreview(
  summary: AgentSessionSummary,
  intent: { deleteTranscript: boolean; deleteAuditLog: boolean; removeRegistryEntry: boolean },
): string {
  const actions = ["tombstone the managed session"];
  if (intent.deleteTranscript) actions.push("permanently delete its transcript");
  if (intent.deleteAuditLog) actions.push("permanently delete its audit log");
  if (intent.removeRegistryEntry) actions.push("permanently remove its registry entry");
  return `About to ${actions.join(", ")} for ${summary.agentSessionId}.\n`;
}

function deletionRetry(
  maintenance: SessionMaintenance,
  intent: { deleteTranscript: boolean; deleteAuditLog: boolean; removeRegistryEntry: boolean },
): DeletionMaintenance {
  if (maintenance.kind !== "deletion") {
    throw new ManagedCliUsageError(
      `session has pending ${maintenance.kind} maintenance; complete that operation first`,
    );
  }
  if (maintenance.details.deleteTranscript !== intent.deleteTranscript
    || maintenance.details.deleteAuditLog !== intent.deleteAuditLog
    || maintenance.details.removeRegistryEntry !== intent.removeRegistryEntry) {
    throw new ManagedCliUsageError(
      "session has a different pending deletion; repeat the original deletion flags",
    );
  }
  return maintenance;
}

async function promptForConfirmation(prompt: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value?.trim()) throw new ManagedCliUsageError(`${option} requires a value`);
  return value;
}
