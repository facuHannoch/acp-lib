import { appendFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { noopLogger, type Logger } from "../../src/index.ts";
import { toPermissionRequest } from "../../src/permissions/acp.ts";
import { matchPermissionLevel } from "../../src/permissions/matcher.ts";

export const workerMode = "read-only";

// Verify the installed bridge as data. Importing its CLI entry would start it.
export async function checkWorkerMode(binary: string) {
  const bridge = await readFile(await realpath(binary), "utf8");
  const mode = /static ReadOnly = new \w+\(([^]*?)\n  \);/.exec(bridge)?.[1];
  if (!mode?.includes('"read-only"') || !mode.includes('"on-request"') ||
    !mode.includes('"user"') || !/type:\s*"readOnly",\s*networkAccess:\s*false/.test(mode) ||
    !bridge.includes('process.env["INITIAL_AGENT_MODE"]') ||
    !bridge.includes("approvalPolicy: agentMode.approvalPolicy") ||
    !bridge.includes("agentMode.sandboxPolicy, additionalDirectories") ||
    !bridge.includes("methods.client.session.requestPermission") ||
    !bridge.includes("command: stripShellPrefix(params.command)") ||
    !bridge.includes("{ rawInput: facts4.input }") ||
    !bridge.includes('kind: "execute"') ||
    !bridge.includes("this.renderer.renderPermissionToolCall(CommandReporter.permission(")) {
    const approvalPolicy = mode?.match(/"(on-request|never|untrusted|on-failure)"/)?.[1] ?? "unrecognized";
    const sandbox = mode?.match(/type:\s*"(readOnly|workspaceWrite|dangerFullAccess)"/)?.[1] ?? "unrecognized";
    const observedMode = mode ? `ReadOnly entry with approval ${approvalPolicy} and sandbox ${sandbox}` : "no recognized ReadOnly entry";
    const override = bridge.includes('process.env["INITIAL_AGENT_MODE"]') ? "present" : "absent";
    throw new Error(`Installed bridge differs from the reviewed permission path (found ${observedMode}; INITIAL_AGENT_MODE lookup ${override})`);
  }
  const command = "echo 'orch live ok' > /tmp/run-owned/result.txt";
  const projected = toPermissionRequest({
    sessionId: "offline", toolCall: { toolCallId: "offline-tool", kind: "execute", rawInput: { command } },
    options: [{ optionId: "once", kind: "allow_once", name: "One time" }],
  });
  if (matchPermissionLevel(projected, { default: "deny", rules: { [`command:${command}`]: "ask" } }) !== "ask") {
    throw new Error("The ACP matcher did not recognize the bridge's projected command");
  }
  return { mode: workerMode, approvalPolicy: "on-request", reviewer: "user", sandbox: "readOnly",
    networkAccess: false, permissionMethod: "session/request_permission", toolKind: "execute",
    commandField: "toolCall.rawInput.command" };
}

export function commandInput(input: unknown) {
  if (typeof input !== "object" || input === null) return {};
  const { command, url, additionalPermissions } = input as Record<string, unknown>;
  return { command, url, additionalPermissions };
}

const optionKinds = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
const toolKinds = new Set(["execute", "edit", "read", "search", "fetch", "delete", "move", "think", "switch_mode", "other"]);

export function permissionTrace(path: string, expectedCommand: string, mismatch: (reason: string) => void) {
  type HistoryEntry = { kind: string; command: string; options: string[] };
  const requests: HistoryEntry[] = [];
  const responses: string[] = [];
  let pendingOptions: Map<string, string> | undefined;
  const write = (entry: object) => appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
  const safeKind = (value: unknown, allowed: Set<string>) =>
    typeof value === "string" && allowed.has(value) ? value : "unknown";
  const logger: Logger = {
    ...noopLogger,
    debug(event, meta) {
      if (event === "permission_request") {
        const request = meta?.request as Parameters<typeof toPermissionRequest>[0];
        const projected = toPermissionRequest(request);
        const kind = safeKind(projected.tool?.kind, toolKinds);
        const raw = commandInput(projected.tool?.rawInput);
        const permitted = kind === "execute" && raw.command === expectedCommand && !raw.url && !raw.additionalPermissions;
        const options = new Map(projected.options.map(option => [option.optionId, safeKind(option.kind, optionKinds)]));
        const entry = { kind, command: permitted ? "echo 'orch live ok' > [run output]" :
          raw.command === undefined ? "[absent]" : "[redacted]", options: [...options.values()] };
        requests.push(entry);
        write({ event: "request", ...entry });
        if (requests.length !== 1 || !permitted || !entry.options.includes("allow_once")) {
          mismatch("Unexpected ACP permission packet");
          return;
        }
        pendingOptions = options;
      } else if (event === "permission_response") {
        const outcome = meta?.outcome as { outcome?: unknown; optionId?: string } | undefined;
        const selection = outcome?.outcome === "selected" ? pendingOptions?.get(outcome.optionId ?? "") ?? "unknown" :
          outcome?.outcome === "cancelled" ? "cancelled" : "unknown";
        responses.push(selection);
        write({ event: "response", outcome: selection });
        pendingOptions = undefined;
        if (responses.length !== 1 || selection !== "allow_once") mismatch("Unexpected ACP permission response");
      }
    },
  };
  return { logger, requests, responses };
}
