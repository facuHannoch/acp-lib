/**
 * Shared rig for the native tests: an Agent with one native adapter over a real `serve --stdio` harness
 * child process (scripted model, SQLite session in a temporary home). No provider credentials.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agent.ts";
import type { AgentConfig } from "../../src/agent/config.ts";
import type { AgentSession } from "../../src/agent-session.ts";
import type { ProtocolConfig } from "../../src/native-harness/src/client.ts";

export type Seen = { kind: string; [key: string]: any };
export type Step = { content: string | null; calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };

export const reply = (content: string): Step => ({ content, calls: [] });
/** A step that runs the `hold` tool: the turn stays in its tool until `release(key)`. */
export const hold = (key: string, content: string | null = "Working."): Step => ({ content, calls: [{ id: `hold-${key}`, name: "hold", arguments: { key } }] });
/** A step that runs the `record` tool, which appends `text` to the effect log (one line per real execution). */
export const record = (text: string, id = `rec-${text}`): Step => ({ content: "Recording.", calls: [{ id, name: "record", arguments: { text } }] });

export const until = async (predicate: () => boolean | Promise<boolean>, what = "condition", ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

export interface NativeRig {
  readonly directory: string;
  readonly home: string;
  readonly effectsPath: string;
  /** Mutable: read when the harness process is launched, so a test can set fault points before a (re)start. */
  readonly env: Record<string, string>;
  /** Mutable: extra harness settings (for example `functions`) merged into the Agent's `harness` config at `open`. */
  readonly harness: Record<string, unknown>;
  /** Launch requests the host launcher received, and a switch that makes the next launches fail. */
  readonly launches: Array<{ kind: string; target: readonly string[] }>;
  breakLaunch(error: Error | null): void;
  readonly logs: Array<[string, string, unknown]>;
  /** Replaces the script every channel runs. Each channel consumes it from the top, one step per model call. */
  script(steps: Step[]): void;
  /** Lines the `hold` and `record` tools appended. */
  effects(): string[];
  release(key: string): void;
  open(overrides?: Partial<AgentConfig>): Promise<Agent>;
  watch(session: AgentSession): Seen[];
  clean(): Promise<void>;
}

export async function nativeRig(options: { policies?: ProtocolConfig["policies"]; defaultPolicy?: string } = {}): Promise<NativeRig> {
  const directory = await mkdtemp(join(tmpdir(), "acp-native-"));
  const home = join(directory, "harness-home"), scriptPath = join(directory, "script.json"), effectsPath = join(directory, "effects.log");
  const env: Record<string, string> = { HARNESS_TEST_EFFECTS: effectsPath };
  const logs: NativeRig["logs"] = [];
  const harness: Record<string, unknown> = {};
  const logger = Object.fromEntries((["debug", "info", "warn", "error"] as const).map((level) =>
    [level, (event: string, meta?: unknown) => { logs.push([level, event, meta]); }])) as any;
  const agents: Agent[] = [];
  const launches: NativeRig["launches"] = [];
  let broken: Error | null = null;
  // The host launcher, as a consumer would provide it: the environment it returns is exact.
  const launcher = {
    async prepare(request: { kind: "acp" | "pty" | "native-harness"; targetCommand: readonly string[] }) {
      launches.push({ kind: request.kind, target: request.targetCommand });
      if (broken) throw broken;
      return { command: [...request.targetCommand], spawnCwd: directory, spawnEnv: { ...(process.env as Record<string, string>), ...env } };
    },
  };
  const script = (steps: Step[]) => writeFileSync(scriptPath, JSON.stringify({ version: 1, responses: steps }));
  script(Array.from({ length: 12 }, (_, index) => reply(`reply ${index + 1}`)));
  const config: ProtocolConfig = {
    version: 1, system: "Native integration test", model: { protocol: "scripted", script: scriptPath },
    defaultPolicy: options.defaultPolicy ?? "open",
    policies: options.policies ?? { open: { fallback: "allow", tools: {} } },
  };
  return {
    directory, home, effectsPath, env, harness, logs, script, launches,
    breakLaunch: (error) => { broken = error; },
    effects: () => existsSync(effectsPath) ? readFileSync(effectsPath, "utf8").split("\n").filter(Boolean) : [],
    release: (key) => writeFileSync(`${effectsPath}.release-${key}`, ""),
    async open(overrides = {}) {
      const agent = await Agent.open({
        persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
        adapters: { main: { kind: "native" } },
        defaultAdapterId: "main",
        capture: { message: "content", error: "raw" },
        checkpointing: { enabled: false },
        harness: { home, config, launcher, requestTimeoutMs: 5000, ...harness } as AgentConfig["harness"],
        conversationDefaults: { metering: { pricing: false }, cwd: directory, logger },
        ...overrides,
      });
      agents.push(agent);
      return agent;
    },
    watch(session) {
      const events: Seen[] = [];
      session.subscribe(({ event }) => { events.push(event as Seen); });
      return events;
    },
    async clean() {
      for (const agent of agents.splice(0).reverse()) await agent.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
