import type { Stats } from "node:fs";
import { lstat as lstatAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  PersistenceConfigurationError,
  type PersistenceRootEnvironment,
  type ResolvedAgentSessionPersistence,
} from "./config.ts";

export interface ResolvedSessionLogPaths {
  readonly transcriptPath: string | null;
  readonly auditLogPath: string | null;
}

interface ResolvedFile {
  readonly path: string;
  readonly identity: string | null;
}

/** Resolve filesystem-dependent transcript/audit destinations without creating them. */
export async function resolveSessionLogPaths(
  persistence: ResolvedAgentSessionPersistence,
  agentSessionId: string,
  environment: PersistenceRootEnvironment = {},
): Promise<ResolvedSessionLogPaths> {
  if (!agentSessionId.trim()) {
    throw new PersistenceConfigurationError("agentSessionId cannot be blank for persistence");
  }

  const encodedId = encodeURIComponent(agentSessionId);
  const transcript = persistence.transcript === false
    ? null
    : await resolveLogPath(
        persistence.transcript.path,
        join(persistence.root, "transcripts", `${encodedId}.jsonl`),
        encodedId,
        environment,
        "transcript",
      );
  const auditLog = persistence.auditLog === false
    ? null
    : await resolveLogPath(
        persistence.auditLog.path,
        join(persistence.root, "audit-logs", `${encodedId}.jsonl`),
        encodedId,
        environment,
        "audit log",
      );

  if (
    transcript &&
    auditLog &&
    (transcript.path === auditLog.path ||
      (transcript.identity !== null && transcript.identity === auditLog.identity))
  ) {
    throw new PersistenceConfigurationError(
      "transcript and audit log must resolve to different files",
    );
  }

  return Object.freeze({
    transcriptPath: transcript?.path ?? null,
    auditLogPath: auditLog?.path ?? null,
  });
}

async function resolveLogPath(
  configuredPath: string | undefined,
  defaultFile: string,
  encodedAgentSessionId: string,
  environment: PersistenceRootEnvironment,
  label: string,
): Promise<ResolvedFile> {
  if (configuredPath === undefined) {
    return inspectDesiredFile(defaultFile, label);
  }

  const normalized = normalizePath(configuredPath, environment);
  const configured = await inspectPath(normalized, label);
  if (configured.kind === "directory") {
    return inspectDesiredFile(join(normalized, `${encodedAgentSessionId}.jsonl`), label);
  }
  if (configured.kind === "file") {
    return { path: normalized, identity: fileIdentity(configured.stats) };
  }
  if (configured.kind === "missing") {
    return { path: normalized, identity: null };
  }
  throw new PersistenceConfigurationError(`${label} path is not a regular file or directory`);
}

async function inspectDesiredFile(path: string, label: string): Promise<ResolvedFile> {
  const inspected = await inspectPath(path, label);
  if (inspected.kind === "directory" || inspected.kind === "other") {
    throw new PersistenceConfigurationError(`${label} destination is not a regular file`);
  }
  return {
    path,
    identity: inspected.kind === "file" ? fileIdentity(inspected.stats) : null,
  };
}

type InspectedPath =
  | { kind: "missing" }
  | { kind: "file"; stats: Stats }
  | { kind: "directory"; stats: Stats }
  | { kind: "other"; stats: Stats };

async function inspectPath(path: string, label: string): Promise<InspectedPath> {
  await rejectExistingSymlinkComponents(path, label);
  let stats: Stats;
  try {
    stats = await lstatAsync(path);
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    throw new PersistenceConfigurationError(`${label} path cannot be inspected: ${errorMessage(error)}`);
  }
  if (stats.isSymbolicLink()) {
    throw new PersistenceConfigurationError(`${label} path cannot be a symbolic link`);
  }
  if (stats.isFile()) return { kind: "file", stats };
  if (stats.isDirectory()) return { kind: "directory", stats };
  return { kind: "other", stats };
}

async function rejectExistingSymlinkComponents(path: string, label: string): Promise<void> {
  const { root } = parse(path);
  const rest = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const component of rest) {
    current = join(current, component);
    try {
      const stats = await lstatAsync(current);
      if (stats.isSymbolicLink()) {
        throw new PersistenceConfigurationError(`${label} path crosses a symbolic link: ${current}`);
      }
    } catch (error) {
      if (error instanceof PersistenceConfigurationError) throw error;
      if (isMissing(error)) return;
      throw new PersistenceConfigurationError(
        `${label} path component cannot be inspected: ${errorMessage(error)}`,
      );
    }
  }
}

function normalizePath(value: string, environment: PersistenceRootEnvironment): string {
  const home = environment.home ?? homedir();
  const cwd = environment.cwd ?? process.cwd();
  const expanded = value === "~"
    ? home
    : value.startsWith("~/")
      ? join(home, value.slice(2))
      : value;
  if (expanded.startsWith("~")) {
    throw new PersistenceConfigurationError("session-log paths support only ~ or ~/ expansion");
  }
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function fileIdentity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
