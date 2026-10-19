import { basename } from "node:path";
import type { Adapter } from "../../adapters.ts";
import type { AcpLauncher } from "../../launcher.ts";

/**
 * A disposable session is one prompt and one answer, then its process is stopped. A harness may start work
 * of its own in that session that the prompt's answer does not wait for: OpenCode names a session by
 * running a second request on a small model at the first prompt, in parallel with the answer, and ACP
 * never says when it ends. Stopping the process right after the answer can cancel it mid-stream, so a
 * request nobody reads is left cut off (and, behind a gateway, half-accounted).
 *
 * Nothing in ACP lets the client wait for such work, so the only safe thing is to not start it. This
 * returns the environment variable that does that for a harness known to need it, for internal inference
 * only; conversations are not touched.
 */
const OPENCODE_CONFIG = "OPENCODE_CONFIG_CONTENT";

export function isOpenCode(adapterId: string, adapter: Pick<Adapter, "command">): boolean {
  return adapterId === "opencode" || adapter.command.some((part) => basename(part) === "opencode");
}

/**
 * `existing` with the title agent disabled. OpenCode reads inline config as JSON; whatever else the consumer
 * put there is kept. Unparseable config is left alone: the harness will refuse it either way, and replacing
 * it would hide the consumer's mistake.
 */
export function openCodeConfigWithoutTitle(existing: string | undefined): string | undefined {
  let config: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
      config = parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  const agent = isObject(config.agent) ? config.agent : {};
  const title = isObject(agent.title) ? agent.title : {};
  return JSON.stringify({ ...config, agent: { ...agent, title: { ...title, disable: true } } });
}

export interface DisposableSessionLaunch {
  readonly env?: Record<string, string>;
  readonly launcher?: AcpLauncher;
}

/**
 * The launch settings for a disposable session of `adapterId`: the consumer's `env` and `launcher` with the
 * harness's background work switched off where the harness is known to start some.
 *
 * Without a launcher the variable goes into `env`, which is laid over this process's environment. With
 * one, the launcher's `spawnEnv` is the whole environment of the process it spawns, so the variable is
 * added there; a launcher that starts the harness somewhere else (a container, a remote host) has to
 * forward `OPENCODE_CONFIG_CONTENT` itself, as it does for any other variable.
 */
export function withoutHarnessBackgroundWork(
  adapterId: string,
  adapter: Pick<Adapter, "command">,
  launch: DisposableSessionLaunch,
): DisposableSessionLaunch {
  if (!isOpenCode(adapterId, adapter)) return launch;
  const { launcher } = launch;
  if (launcher) {
    return {
      ...launch,
      launcher: {
        async prepare(request) {
          const prepared = await launcher.prepare(request);
          const value = openCodeConfigWithoutTitle(prepared.spawnEnv?.[OPENCODE_CONFIG]);
          return value === undefined
            ? prepared
            : { ...prepared, spawnEnv: { ...prepared.spawnEnv, [OPENCODE_CONFIG]: value } };
        },
      },
    };
  }
  const value = openCodeConfigWithoutTitle(launch.env?.[OPENCODE_CONFIG] ?? process.env[OPENCODE_CONFIG]);
  return value === undefined ? launch : { ...launch, env: { ...launch.env, [OPENCODE_CONFIG]: value } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
