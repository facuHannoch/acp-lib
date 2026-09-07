// Building the managed OpenCode profile that loads the metering plugin.
//
// `OPENCODE_CONFIG` points the harness at a single config file, and a config's `plugin`
// array accepts absolute paths — verified against opencode 1.18.29. That is what lets the
// plugin load without writing into the consumer's repository, which a library has no
// business doing.
//
// The managed config MERGES the user's existing config rather than replacing it.
// `OPENCODE_CONFIG` is a replacement, so a naive temp file would silently drop their model
// choice, custom providers, and everything else — metering must not change which model
// answers. Credentials are unaffected either way: OpenCode keeps them in its data
// directory, not its config.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where OpenCode looks for a user config, in the order it resolves them. */
function userConfigCandidates(): string[] {
  const home = process.env.HOME ?? "";
  const configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [
    process.env.OPENCODE_CONFIG ?? "",
    join(configHome, "opencode", "opencode.jsonc"),
    join(configHome, "opencode", "opencode.json"),
  ].filter((path) => path.length > 0);
}

/**
 * Parse a possibly-JSONC config.
 *
 * Plain JSON is tried first, because that is what most configs are and it needs no
 * rewriting at all. Only if that fails are comments and trailing commas stripped, and the
 * stripping is string-aware: a naive regex mangles `"path": "a//b"` and anything
 * containing a comment marker inside a string value.
 */
function parseJsonc(text: string): Record<string, unknown> | null {
  const accept = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;

  try {
    return accept(JSON.parse(text));
  } catch {
    // Fall through to comment stripping.
  }

  let cleaned = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      cleaned += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      cleaned += char;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      cleaned += "\n";
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    cleaned += char;
  }

  try {
    return accept(JSON.parse(cleaned.replace(/,(\s*[}\]])/g, "$1")));
  } catch {
    return null;
  }
}

export interface ManagedProfile {
  /** Absolute path to pass as OPENCODE_CONFIG. */
  readonly configPath: string;
  /** True when an existing user config was found and carried forward. */
  readonly mergedUserConfig: boolean;
  /** Remove the temporary profile directory. */
  cleanup(): Promise<void>;
}

export interface ManagedProfileOptions {
  /**
   * Called when a user config exists but could not be parsed.
   *
   * OPENCODE_CONFIG replaces the user's config, so proceeding without theirs silently
   * changes which model answers. The caller decides whether that is acceptable.
   */
  readonly onUnreadableConfig?: (path: string) => void;
}

/**
 * Write a managed config that adds the metering plugin to the user's own settings.
 *
 * The plugin is appended to any existing `plugin` entries rather than replacing them: a
 * consumer's plugins are theirs, and silently disabling them to meter would be a worse
 * bug than not metering.
 */
export async function writeManagedProfile(
  pluginPath: string,
  options: ManagedProfileOptions = {},
): Promise<ManagedProfile> {
  let base: Record<string, unknown> = {};
  let mergedUserConfig = false;

  for (const candidate of userConfigCandidates()) {
    let text: string;
    try {
      text = await readFile(candidate, "utf8");
    } catch {
      continue; // Missing: a user with no config is normal.
    }
    const parsed = parseJsonc(text);
    if (parsed) {
      base = parsed;
      mergedUserConfig = true;
      break;
    }
    // Present but unparseable. Dropping it silently would change which model answers,
    // so the caller is told rather than left to wonder.
    options.onUnreadableConfig?.(candidate);
    break;
  }

  const existing = Array.isArray(base.plugin) ? (base.plugin as unknown[]) : [];
  const config = {
    ...base,
    $schema: base.$schema ?? "https://opencode.ai/config.json",
    plugin: [...existing.filter((entry) => entry !== pluginPath), pluginPath],
  };

  const directory = await mkdtemp(join(tmpdir(), "acp-opencode-profile-"));
  const configPath = join(directory, "opencode.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return {
    configPath,
    mergedUserConfig,
    // The profile lives in the OS temp dir; leaving one behind per session is a slow leak.
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Absolute path of the plugin file shipped with the library. */
export function meteringPluginPath(): string {
  return join(import.meta.dir, "plugin.js");
}
