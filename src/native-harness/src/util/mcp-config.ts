import type { McpHeader, McpServer } from "../contracts/mcp.ts";

const envName = /^[a-z_][a-z_0-9]*$/i;
const unsafeHeader = /[\x00-\x1f\x7f]/;
const reserved = /^(?:proxy-|sec-|mcp-|(?:host|cookie|set-cookie|content-length|accept|content-type|last-event-id|origin|upgrade|expect|te|trailer|transfer-encoding|connection)$)/i;

function invalid(): never { throw new Error("Invalid MCP server configuration"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  return value as Record<string, unknown>;
}
function only(fields: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(fields).some(field => !allowed.includes(field))) invalid();
}
function string(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.includes("\0")) return invalid();
  return value;
}
function reference(value: unknown): { env: string } {
  const fields = object(value);
  only(fields, ["env"]);
  const env = string(fields.env);
  if (!envName.test(env)) invalid();
  return { env };
}
function headers(value: unknown): Record<string, McpHeader> {
  const result: Record<string, McpHeader> = Object.create(null);
  for (const [raw, input] of Object.entries(object(value))) {
    const name = raw.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || reserved.test(name) || Object.hasOwn(result, name)) invalid();
    const field = object(input);
    if (Object.keys(field).length !== 1) invalid();
    if (Object.hasOwn(field, "env")) result[name] = reference(field);
    else if (field.runtime === true) result[name] = { runtime: true };
    else if (typeof field.literal === "string" && name !== "authorization" && !unsafeHeader.test(field.literal)) result[name] = { literal: field.literal };
    else invalid();
  }
  return result;
}

export function validateMcpServers(value: unknown): Record<string, McpServer> {
  const entries = Object.entries(object(value));
  if (entries.length > 8) invalid();
  const result: Record<string, McpServer> = Object.create(null);
  for (const [name, entry] of entries) {
    const raw = object(entry);
    if (!/^[a-z][a-z0-9]{0,11}$/.test(name) || (raw.enabled !== undefined && typeof raw.enabled !== "boolean")) invalid();
    const common = raw.enabled === undefined ? {} : { enabled: raw.enabled as boolean };
    if (raw.transport === "stdio") {
      only(raw, ["transport", "enabled", "command", "args", "cwd", "env"]);
      if (!Array.isArray(raw.args)) invalid();
      const env = raw.env === undefined ? undefined : Object.fromEntries(Object.entries(object(raw.env)).map(([key, v]) => {
        if (!envName.test(key)) invalid();
        return [key, reference(v)];
      }));
      result[name] = { ...common, transport: "stdio", command: string(raw.command), args: raw.args.map(value => string(value, true)),
        ...(raw.cwd === undefined ? {} : { cwd: string(raw.cwd) }), ...(env === undefined ? {} : { env }) };
    } else if (raw.transport === "http") {
      only(raw, ["transport", "enabled", "endpoint", "headers"]);
      const text = string(raw.endpoint);
      if (!/^https:\/\/[^/]+/i.test(text) || /[\s\\?#]/.test(text) || /^https:\/\/[^/]*@/i.test(text)) invalid();
      const endpoint = URL.parse(text);
      if (!endpoint || endpoint.protocol !== "https:" || endpoint.username || endpoint.password) invalid();
      result[name] = { ...common, transport: "http", endpoint: endpoint.href,
        ...(raw.headers === undefined ? {} : { headers: headers(raw.headers) }) };
    } else invalid();
  }
  return result;
}

/** Executable request material only. Never include values in validation errors. */
export function validateMcpRuntimeHeaders(value: unknown, servers: Record<string, McpServer> = {}) {
  const resolved = Object.create(null) as Record<string, Record<string, string>>;
  for (const [server, material] of Object.entries(object(value))) {
    const entry = Object.hasOwn(servers, server) ? servers[server] : undefined;
    if (entry?.transport !== "http") invalid();
    const values = Object.create(null) as Record<string, string>;
    for (const [raw, value] of Object.entries(object(material))) {
      const header = raw.toLowerCase();
      const declared = entry.headers?.[header];
      if (!declared || !("runtime" in declared) || reserved.test(header) || Object.hasOwn(values, header) ||
        typeof value !== "string" || unsafeHeader.test(value)) invalid();
      values[header] = value;
    }
    resolved[server] = values;
  }
  return resolved;
}

export function resolveMcpHttpsHeaders(entry: Extract<McpServer, { transport: "http" }>,
  environment: Record<string, string | undefined>, runtime?: Record<string, string>) {
  const headers: Record<string, string> = Object.create(null);
  const secrets: string[] = [];
  for (const [name, declaration] of Object.entries(entry.headers ?? {})) {
    if ("literal" in declaration) { headers[name] = declaration.literal; continue; }
    const value = "env" in declaration ? environment[declaration.env] : runtime?.[name];
    if (!value?.trim() || unsafeHeader.test(value)) return;
    headers[name] = value.trim();
    secrets.push(value, headers[name]);
  }
  return { headers, secrets };
}
