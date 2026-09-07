// Certified OpenCode metering: one call that wires the plugin, the channel, and the
// managed profile together.
//
// Why this exists, in one measurement: on `opencode-go/kimi-k2.6`, a turn with tool calls
// billed 0.00708081 while ACP's `PromptResponse.usage` reported 0.00281687 — the last of
// two inferences. The plugin observed both, and their costs summed to the provider's own
// figure exactly. ACP alone undercounts any tool-using turn, which is every real turn for
// a coding agent.

import { OpencodeMeteringChannel, type ProviderInference } from "./channel.ts";
import { meteringPluginPath, writeManagedProfile, type ManagedProfile } from "./profile.ts";
import { OPENCODE_PLUGIN_CERTIFICATION } from "../certification.ts";
import type { InferenceSource } from "../engine.ts";

export interface OpencodeMeteringOptions {
  /** Diagnostics sink for rejected posts and version mismatches. */
  readonly onWarning?: (message: string) => void;
  /**
   * Skip the harness version check.
   *
   * The certification names the versions actually exercised; running outside them means
   * the plugin API may differ. Only set this to explore a new version deliberately.
   */
  readonly allowUnverifiedVersion?: boolean;
}

export interface OpencodeMetering {
  /** Merge into `AgentSessionConfig.env` so the harness loads the plugin and can report. */
  readonly env: Readonly<Record<string, string>>;
  /** Pass as `MeteringConfig.inferenceSource`. */
  readonly inferenceSource: InferenceSource;
  /** True once the plugin has announced itself. */
  isReady(): boolean;
  /**
   * Wait for the plugin handshake.
   *
   * Resolves false on timeout, which is the signal that the plugin did not load — a
   * different fact from "no inferences happened", and the one billing depends on.
   */
  waitForPlugin(timeoutMs?: number): Promise<boolean>;
  readonly profile: ManagedProfile;
  /** Inferences observed but never attributed to an operation. */
  drainUnattributed(): readonly ProviderInference[];
  stop(): Promise<void>;
}

/** Best-effort harness version, or null when it cannot be determined. */
async function opencodeVersion(): Promise<string | null> {
  try {
    const process_ = Bun.spawn(["opencode", "--version"], { stdout: "pipe", stderr: "ignore" });
    const text = (await new Response(process_.stdout).text()).trim();
    return /^\d+\.\d+/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * Start a certified metering channel for OpenCode.
 *
 * Call before `AgentSession.create`, merge `env` into the session config, and pass
 * `inferenceSource` to `MeteringConfig`. Await `waitForPlugin()` before relying on it in a
 * strict mode: a channel that never handshook reports every operation unavailable rather
 * than falling back to a backend known to undercount.
 */
export async function createOpencodeMetering(
  options: OpencodeMeteringOptions = {},
): Promise<OpencodeMetering> {
  const version = await opencodeVersion();
  const supported = OPENCODE_PLUGIN_CERTIFICATION.supportedHarnessVersions;
  const verified = version !== null && supported.some((prefix) => version.startsWith(prefix));
  if (!verified && !options.allowUnverifiedVersion) {
    throw new Error(
      `opencode ${version ?? "(version unknown)"} is outside the versions this metering ` +
        `integration was verified against (${supported.join(", ")}). The plugin API differs ` +
        `across majors. Pass allowUnverifiedVersion to proceed anyway.`,
    );
  }
  if (!verified) options.onWarning?.(`running against unverified opencode ${version ?? "?"}`);

  const channel = new OpencodeMeteringChannel({ onWarning: options.onWarning });
  channel.start();
  const profile = await writeManagedProfile(meteringPluginPath(), {
    onUnreadableConfig: (path) =>
      options.onWarning?.(
        `could not parse ${path}; proceeding WITHOUT your OpenCode config, so the model ` +
          `and providers it selects will not apply`,
      ),
  });

  const inferenceSource: InferenceSource = {
    certificationId: OPENCODE_PLUGIN_CERTIFICATION.certificationId,
    isHealthy: () => channel.handshake !== null,
    drain: (internalSessionId) => channel.drain(internalSessionId),
  };

  return {
    env: Object.freeze({
      OPENCODE_CONFIG: profile.configPath,
      ACP_METER_URL: channel.url,
      ACP_METER_TOKEN: channel.token,
    }),
    inferenceSource,
    profile,
    isReady: () => channel.handshake !== null,
    async waitForPlugin(timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (channel.handshake) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    },
    drainUnattributed: () => channel.drainAll(),
    stop: async () => {
      await channel.stop();
      await profile.cleanup();
    },
  };
}

export { OpencodeMeteringChannel } from "./channel.ts";
export type { ProviderInference, ChannelHandshake } from "./channel.ts";
export { meteringPluginPath, writeManagedProfile } from "./profile.ts";
export type { ManagedProfile } from "./profile.ts";
