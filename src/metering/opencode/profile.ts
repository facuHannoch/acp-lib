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

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

/** Strip comments and trailing commas so a `.jsonc` config can be merged. */
function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    const withoutComments = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
    const parsed = JSON.parse(withoutTrailingCommas);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export interface ManagedProfile {
  /** Absolute path to pass as OPENCODE_CONFIG. */
  readonly configPath: string;
  /** True when an existing user config was found and carried forward. */
  readonly mergedUserConfig: boolean;
}

/**
 * Write a managed config that adds the metering plugin to the user's own settings.
 *
 * The plugin is appended to any existing `plugin` entries rather than replacing them: a
 * consumer's plugins are theirs, and silently disabling them to meter would be a worse
 * bug than not metering.
 */
export async function writeManagedProfile(pluginPath: string): Promise<ManagedProfile> {
  let base: Record<string, unknown> = {};
  let mergedUserConfig = false;

  for (const candidate of userConfigCandidates()) {
    try {
      const parsed = parseJsonc(await readFile(candidate, "utf8"));
      if (parsed) {
        base = parsed;
        mergedUserConfig = true;
        break;
      }
    } catch {
      // Missing or unreadable: try the next candidate. A user with no config is normal.
    }
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
  return { configPath, mergedUserConfig };
}

/** Absolute path of the plugin file shipped with the library. */
export function meteringPluginPath(): string {
  return join(import.meta.dir, "plugin.js");
}
