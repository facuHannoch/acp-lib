import { matchPermissionLevel } from "../permissions/matcher.ts";
import type { PermissionRequest } from "../types.ts";
import type { OrchestratorConfig } from "./config.ts";

/** Paths included in a notice are explicitly designated shareable by the host. */
export function describeModelApproval(config: OrchestratorConfig, policies: readonly string[], request: PermissionRequest): string | undefined {
  if (!policies.length || request.tool?.kind !== "read") return;
  const input = request.tool.rawInput;
  if (!input || typeof input !== "object" || Array.isArray(input) || !("path" in input)) return;
  const { path } = input;
  if (Object.keys(input).length !== 1 || typeof path !== "string" || path.length > 200 ||
    !/^[a-zA-Z0-9_.\/-]+$/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) return;
  if (policies.every(name => {
    const grant = Object.hasOwn(config.policies ?? {}, name) ? config.policies?.[name]?.modelApproval : undefined;
    return Array.isArray(grant?.shareReadPaths) && grant.shareReadPaths.includes(path) && matchPermissionLevel(request, { default: "deny", rules: grant.rules }) === "allow";
  })) return `Read workspace file ${path}`;
}
