import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, validateManagedConfig } from "./managed.ts";
import { parseUniqueJson } from "../../util/json.ts";
import type { ManagedConfig } from "../../contracts/config-permissions.ts";

/** Session IDs name exactly one child; paths supplied by consumers never
 * become path traversal components. The development --db path is separate. */
export function managedSessionPaths(sessionId: string, home = join(homedir(), ".harness")) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) throw new ConfigError("sessionId", "expected a plain session ID");
  const directory = join(home, sessionId);
  return { directory, config: join(directory, "config.json"), database: join(directory, "session.sqlite") };
}
/** Read once for this open. A present sidecar wins over inline on reopen and
 * an invalid sidecar is never silently replaced by a saved config. */
export function chooseManagedConfig(options: { mode: "create" | "open"; sidecar: string; inline?: unknown; saved?: unknown }): ManagedConfig {
  const sidecar = () => {
    try { return parseUniqueJson(readFileSync(options.sidecar, "utf8")); }
    catch (error) { throw new ConfigError("config.json", String(error)); }
  };
  const present = existsSync(options.sidecar);
  const raw = options.mode === "create" ? options.inline ?? (present ? sidecar() : undefined)
    : present ? sidecar() : options.inline ?? options.saved;
  if (raw === undefined) throw new ConfigError("config", "supply an inline configuration or config.json; no saved configuration exists");
  const selected = validateManagedConfig(raw, options.mode === "open" && raw === options.saved);
  if (options.mode !== "open" || options.inline === undefined || raw === options.inline) return selected;
  const requested = validateManagedConfig(options.inline).limits;
  if (!requested) return selected;
  if (selected.limits && selected.limits.unattendedTurns !== requested.unattendedTurns)
    throw new ConfigError("config.limits.unattendedTurns", "inline and selected limits differ");
  return { ...selected, limits: requested };
}
