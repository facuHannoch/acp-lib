import type { WorkerApprovalView } from "../native-harness/src/client.ts";
import { matchPermissionLevel } from "../permissions/matcher.ts";
import type { PermissionRequest } from "../types.ts";
import type { OrchestratorConfig } from "./config.ts";

type Action = WorkerApprovalView["action"];
const MAX_ACTION_BYTES = 2048;

export function canAnswerModelApproval(config: OrchestratorConfig, policies: readonly string[], request: PermissionRequest): boolean {
  return policies.length > 0 && policies.every(name => {
    const grant = Object.hasOwn(config.policies ?? {}, name) ? config.policies?.[name]?.modelApproval : undefined;
    return !!grant && matchPermissionLevel(request, { default: "deny", rules: grant.rules }) === "allow";
  });
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > MAX_ACTION_BYTES ||
    /[\x00-\x08\x0b-\x1f\x7f\p{Cf}]/u.test(value)) return;
  return value
    .replace(/(\b(?:Bearer|Basic)[ \t]+)[^\s"'\x60,;]+/gi, "$1[redacted]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]")
    .replace(/(\b(?:https?|ssh):\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(^|[ \t])(-u[ \t]+)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/g, "$1$2[redacted]")
    .replace(/((?:\b|--)(?:[\w-]*(?:api[-_]?key|token|password|passwd|secret|authorization|cookie)[\w-]*)["']?[ \t]*[:=][ \t]*|--(?:[\w-]*(?:api[-_]?key|token|password|passwd|secret|authorization|cookie)[\w-]*)[ \t]+)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1[redacted]");
}

function safeArgv(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 32 || !value.every(arg => typeof arg === "string")) return;
  const args: string[] = [];
  for (const [index, arg] of value.entries()) {
    const safe = safeText(arg);
    if (safe === undefined) return;
    const previous = value[index - 1];
    args.push(typeof previous === "string" &&
      (previous === "-u" || /^--?[\w-]*(?:api[-_]?key|token|password|passwd|secret|authorization|cookie)[\w-]*$/i.test(previous))
      ? "[redacted]" : safe);
  }
  return args;
}

function commandDetails(fields: Record<string, unknown>): Action["details"] | undefined {
  const { command, args, argv, cwd, timeout } = fields;
  if (Object.keys(fields).some(key => !["command", "args", "argv", "cwd", "description", "timeout"].includes(key))) return;
  if (argv !== undefined && (command !== undefined || args !== undefined)) return;
  if (args !== undefined && (typeof command !== "string" || !Array.isArray(args) || args.length > 31)) return;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0)) return;
  const directory = cwd === undefined ? undefined : safeText(cwd);
  if (cwd !== undefined && directory === undefined) return;
  const invocation = args !== undefined && Array.isArray(args) ? safeArgv([command, ...args])
    : Array.isArray(argv ?? command) ? safeArgv(argv ?? command) : argv === undefined ? safeText(command) : undefined;
  if (invocation === undefined) return;
  return { ...(Array.isArray(invocation) ? { argv: invocation } : { command: invocation }), ...(directory === undefined ? {} : { cwd: directory }),
    ...(timeout === undefined ? {} : { timeout }) };
}

/** Project only details whose shape we understand. Other requests keep their consumer route. */
export function describeModelApproval(request: PermissionRequest): Action | undefined {
  const kind = request.tool?.kind;
  const input = request.tool?.rawInput;
  const fields = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  let details: Action["details"] | undefined;
  if (kind === "execute") {
    details = commandDetails(fields ?? (typeof input === "string" || Array.isArray(input) ? { command: input } : {}));
  } else if (fields && (kind === "read" || kind === "edit" || kind === "delete" || kind === "move" || kind === "fetch")) {
    const pathKeys = ["path", "filePath", "file_path"].filter(key => Object.hasOwn(fields, key));
    const extraKeys = kind === "edit" ? ["oldText", "newText", "old_string", "new_string", "patch", "content"] : kind === "move" ? ["destination"] : [];
    const target = kind === "fetch" ? "url" : pathKeys.length === 1 ? pathKeys[0] : undefined;
    if (!target || Object.keys(fields).some(key => key !== target && !extraKeys.includes(key))) return;
    const text = safeText(fields[target]);
    if (text === undefined) return;
    const projected: Record<string, string> = { [kind === "fetch" ? "url" : "path"]: text };
    if (kind === "fetch") {
      try {
        const url = new URL(text);
        if (!["https:", "http:"].includes(url.protocol) || url.search || url.hash) return;
      } catch { return; }
    }
    for (const key of extraKeys) {
      if (!Object.hasOwn(fields, key)) continue;
      const value = safeText(fields[key]);
      if (value === undefined) return;
      projected[key] = value;
    }
    if (kind === "move" && !projected.destination) return;
    details = projected;
  }
  if (!kind || details === undefined) return;
  const action = { kind, details };
  if (Buffer.byteLength(JSON.stringify(action)) <= MAX_ACTION_BYTES) return action;
}
