import type { ToolDefinition } from "../../../contracts/loop.ts";
import type { ToolAvailability, ToolCatalogInput, ToolRegistration } from "../../../contracts/tools.ts";

/** A catalog the open must refuse, or a runtime operation on the wrong entry. */
export class CatalogError extends Error {
  constructor(readonly code: "invalid_params" | "not_found" | "invalid_state", message: string) { super(message); }
}
const invalid = (message: string): never => { throw new CatalogError("invalid_params", message); };
const word = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const duration = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

/** The scoped reader for results held by their producer. Offered whenever a
 * catalog exists; its name is reserved. */
export const READ_TOOL_RESULT = "read_tool_result";
export const readToolResultDefinition: ToolDefinition = {
  name: READ_TOOL_RESULT,
  description: "Read part of a tool result that was too large to show in full. Use the result_id from that result. Only results produced in this conversation can be read.",
  parameters: { type: "object", properties: { result_id: { type: "string" }, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1 } },
    required: ["result_id"], additionalProperties: false },
};

/** Validate the whole catalog before anything is opened (decision 0021).
 * `reserved` are the names of tools the session already has. */
export function parseCatalog(raw: unknown, reserved: readonly string[]): ToolCatalogInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("tools must be an object");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!["catalog", "enabled", "defaultDeadlineMs"].includes(key)) invalid(`tools: unsupported field ${key}`);
  if (!Array.isArray(input.catalog)) return invalid("tools.catalog must be an array");
  const names = new Set<string>([...reserved, READ_TOOL_RESULT, "notify_channel"]);
  const catalog = input.catalog.map((value, index): ToolRegistration => {
    const at = `tools.catalog[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${at} must be an object`);
    const entry = value as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (!["name", "description", "parameters", "handler", "group", "deadlineMs"].includes(key)) invalid(`${at}: unsupported field ${key}`);
    if (!word(entry.name)) return invalid(`${at}.name must be a nonempty string`);
    if (names.has(entry.name)) invalid(`${at}: tool name ${entry.name} is already used`);
    names.add(entry.name);
    if (typeof entry.description !== "string") invalid(`${at}.description must be a string`);
    if (!entry.parameters || typeof entry.parameters !== "object" || Array.isArray(entry.parameters)) invalid(`${at}.parameters must be a JSON schema object`);
    if (!word(entry.handler)) invalid(`${at}.handler must be a nonempty string`);
    if (entry.group !== "fixed" && entry.group !== "revocable" && entry.group !== "runtime") invalid(`${at}.group must be fixed, revocable or runtime`);
    if (entry.deadlineMs !== undefined && !duration(entry.deadlineMs)) invalid(`${at}.deadlineMs must be a positive integer`);
    return { name: entry.name, description: entry.description as string, parameters: structuredClone(entry.parameters) as Record<string, unknown>,
      handler: entry.handler as string, group: entry.group as ToolRegistration["group"], ...(entry.deadlineMs === undefined ? {} : { deadlineMs: entry.deadlineMs as number }) };
  });
  const runtime = new Set(catalog.filter(entry => entry.group === "runtime").map(entry => entry.name));
  if (input.enabled !== undefined && (!Array.isArray(input.enabled) || input.enabled.some(name => !word(name) || !runtime.has(name)) || new Set(input.enabled).size !== input.enabled.length))
    invalid("tools.enabled must list distinct runtime tool names");
  if (input.defaultDeadlineMs !== undefined && !duration(input.defaultDeadlineMs)) invalid("tools.defaultDeadlineMs must be a positive integer");
  return { catalog, ...(input.enabled === undefined ? {} : { enabled: [...input.enabled as string[]] }),
    ...(input.defaultDeadlineMs === undefined ? {} : { defaultDeadlineMs: input.defaultDeadlineMs as number }) };
}

/** Two catalog inputs ask for the same thing (a repeated load must). */
export const sameCatalog = (left: ToolCatalogInput, right: ToolCatalogInput) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const canonical = (input: ToolCatalogInput) => [input.catalog.map(entry => [entry.name, entry.description, JSON.stringify(entry.parameters), entry.handler, entry.group, entry.deadlineMs ?? null]),
  [...input.enabled ?? []].sort(), input.defaultDeadlineMs ?? null];

export interface ToolCatalog {
  readonly entries: readonly ToolRegistration[];
  readonly defaultDeadlineMs?: number;
  get(name: string): ToolRegistration | undefined;
  /** Why the entry cannot run now, or undefined if it can. Policy is not consulted. */
  unavailable(name: string): ToolAvailability["reason"] | "unknown" | undefined;
  availability(entry: ToolRegistration): ToolAvailability;
  /** The handler names the current connection serves. */
  serve(handlers: readonly string[]): void;
  setRevoked(names: readonly string[]): void;
  setEnabled(name: string, enabled: boolean): void;
  /** Available entries, fixed group first, then by name: a stable order for the model. */
  offered(): { fixed: ToolRegistration[]; changeable: ToolRegistration[] };
}

/** The catalog's state. Definitions come from the open; the revoked set mirrors
 * storage; the enabled set and the served handlers are process state. */
export function createToolCatalog(input: ToolCatalogInput, revoked: readonly string[]): ToolCatalog {
  const entries = input.catalog.map(entry => structuredClone(entry));
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  let revokedNames = new Set(revoked), served = new Set<string>();
  const enabled = new Set(input.enabled ?? []);
  const reason = (entry: ToolRegistration): ToolAvailability["reason"] | undefined =>
    entry.group === "revocable" && revokedNames.has(entry.name) ? "revoked"
      : entry.group === "runtime" && !enabled.has(entry.name) ? "not_enabled"
        : !served.has(entry.handler) ? "handler_missing" : undefined;
  const byNameOrder = (left: ToolRegistration, right: ToolRegistration) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  return {
    entries, ...(input.defaultDeadlineMs === undefined ? {} : { defaultDeadlineMs: input.defaultDeadlineMs }),
    get: name => byName.get(name),
    unavailable(name) { const entry = byName.get(name); return entry ? reason(entry) : "unknown"; },
    availability(entry) {
      const why = reason(entry);
      return { name: entry.name, group: entry.group, handler: entry.handler, available: why === undefined, ...(why === undefined ? {} : { reason: why }) };
    },
    serve(handlers) { served = new Set(handlers); },
    setRevoked(names) { revokedNames = new Set(names); },
    setEnabled(name, on) { if (on) enabled.add(name); else enabled.delete(name); },
    offered() {
      const available = entries.filter(entry => reason(entry) === undefined);
      return { fixed: available.filter(entry => entry.group === "fixed").sort(byNameOrder), changeable: available.filter(entry => entry.group !== "fixed").sort(byNameOrder) };
    },
  };
}
