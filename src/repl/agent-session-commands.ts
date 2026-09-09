// Opinionated local commands for a REPL bound to one stable AgentSession. This layer
// never selects a different logical AgentSession; a managed consumer/CLI owns that.

import type { AgentClient, Bridgeable } from "../agent-client.ts";
import type {
  AgentSessionPhase,
  AgentSessionState,
  HandoffOptions,
  HandoffResult,
} from "../agent-session.ts";
import type { AgentMode } from "../controller.ts";
import type { CommandDescriptor } from "../command-descriptors.ts";
import type { InternalSessionCommand, PromptHandlers, PromptResult } from "../types.ts";
import { runRepl, type ReplOptions } from "./repl.ts";

/** Structural surface used by the command set, allowing focused consumer test doubles. */
export interface InteractiveAgentSession extends AgentClient, Bridgeable {
  readonly agentSessionId: string;
  readonly internalSessionId: string | null;
  readonly adapterId: string;
  readonly mode: AgentMode;
  readonly state: AgentSessionState;
  readonly isBusy: boolean;
  readonly queuedOperationCount: number;
  readonly transcriptPath?: string;
  readonly internalSessionCommands: readonly InternalSessionCommand[];
  handoff(options?: HandoffOptions): Promise<HandoffResult>;
  executeInternalSessionCommand(
    name: string,
    input?: string,
    handlers?: PromptHandlers,
  ): Promise<PromptResult>;
}

export interface AgentSessionCommandHandlerDeps {
  session: InteractiveAgentSession;
  note: (message: string) => void;
}

export interface AgentSessionCommandHandlers {
  onSlashCommand(command: string, args: string[]): Promise<boolean>;
}

export type AgentSessionCommandId =
  | "help"
  | "session"
  | "state"
  | "commands"
  | "handoff"
  | "bridge";

export interface AgentSessionCommand extends CommandDescriptor<AgentSessionCommandId> {}

/**
 * Describe the first-class commands that operate on one stable logical AgentSession.
 * The result is recomputed so availability reflects the current session state.
 * REPL-only lifecycle commands such as `/exit` are intentionally not included.
 */
export function getAgentSessionCommands(
  session: Pick<InteractiveAgentSession, "state">,
): AgentSessionCommand[] {
  const promptability = session.state.promptability;
  const always = (descriptor: Omit<AgentSessionCommand, "available">): AgentSessionCommand => ({
    ...descriptor,
    available: true,
  });
  return [
    always({
      id: "help",
      usage: "/help",
      description: "Show commands that operate on this logical agent session.",
      arguments: [],
    }),
    always({
      id: "session",
      usage: "/session",
      description: "Show the stable agent-session identity and current provider-thread identity.",
      arguments: [],
    }),
    always({
      id: "state",
      usage: "/state",
      description: "Show lifecycle, queue, transport, and provider-thread state.",
      arguments: [],
    }),
    always({
      id: "commands",
      usage: "/commands",
      description: "List slash commands advertised by the active ACP harness.",
      arguments: [],
    }),
    {
      id: "handoff",
      usage: "/handoff [SUMMARY]",
      description: "Continue in a new provider thread while preserving the agent-session identity.",
      arguments: [{
        name: "summary",
        description: "Optional continuation summary; the current thread generates one when omitted.",
        required: false,
        variadic: true,
      }],
      available: promptability.promptable,
      ...(promptability.promptable
        ? {}
        : { unavailableReason: `session is not promptable: ${promptability.blockers.join(", ")}` }),
    },
    always({
      id: "bridge",
      usage: "/bridge",
      description: "Open the harness's interactive terminal interface.",
      arguments: [],
    }),
  ];
}

/** Commands that control exactly one stable logical AgentSession. */
export function createAgentSessionCommands(
  deps: AgentSessionCommandHandlerDeps,
): AgentSessionCommandHandlers {
  const { session, note } = deps;

  const onSlashCommand = async (command: string, args: string[]): Promise<boolean> => {
    switch (command) {
      case "help":
        note(`local commands: ${getAgentSessionCommands(session).map((entry) => entry.usage).join(" ")} /exit`);
        note("internal session commands: //name [input]");
        return true;

      case "session":
        note(`agentSessionId=${session.agentSessionId}`);
        note(`internalSessionId=${session.internalSessionId ?? "(none)"}`);
        note(`adapter=${session.adapterId} mode=${session.mode}`);
        if (session.transcriptPath) note(`transcript=${session.transcriptPath}`);
        return true;

      case "state":
        note(formatState(session.state));
        return true;

      case "commands":
        if (session.internalSessionCommands.length === 0) {
          note("(no internal session commands advertised; //name is still explicit)");
          return true;
        }
        note("internal session commands:");
        for (const available of session.internalSessionCommands) {
          const input = available.input?.hint ? ` ${available.input.hint}` : "";
          const description = available.description ? ` — ${available.description}` : "";
          note(`  //${available.name}${input}${description}`);
        }
        return true;

      case "handoff": {
        const summary = args.join(" ").trim();
        try {
          const result = await session.handoff(summary ? { summary } : undefined);
          note(
            `handoff ${result.handoffId}: ${result.fromInternalSessionId ?? "(none)"} -> ` +
              result.toInternalSessionId,
          );
        } catch (error) {
          note(`handoff failed: ${String(error)}`);
        }
        return true;
      }

      case "bridge":
        try {
          await session.bridge();
        } catch (error) {
          note(`bridge failed: ${String(error)}`);
        }
        return true;

      default:
        return false;
    }
  };

  return { onSlashCommand };
}

export interface AgentSessionReplOptions
  extends Omit<ReplOptions, "onSlashCommand" | "onInternalSessionCommand"> {
  /** Output for local command results. Default stderr. */
  note?: (message: string) => void;
  /** Optional consumer-local extension, tried after the built-in single-session set. */
  onSlashCommand?: ReplOptions["onSlashCommand"];
}

/**
 * Run the opinionated REPL for one stable AgentSession. The caller retains lifecycle
 * ownership and must stop the session when appropriate.
 */
export function runAgentSessionRepl(
  session: InteractiveAgentSession,
  options: AgentSessionReplOptions = {},
): Promise<void> {
  const note = options.note ?? ((message: string) => process.stderr.write(`${message}\n`));
  const builtIn = createAgentSessionCommands({ session, note });
  const extension = options.onSlashCommand;
  const { note: _note, onSlashCommand: _extension, ...replOptions } = options;

  return runRepl(session, {
    ...replOptions,
    intro: options.intro ??
      `AgentSession ${session.agentSessionId} (${session.adapterId}) · /help · //name for internal commands`,
    onSlashCommand: async (command, args) => {
      if (await builtIn.onSlashCommand(command, args)) return true;
      return await extension?.(command, args) === true;
    },
    onInternalSessionCommand: (command, input, handlers) =>
      session.executeInternalSessionCommand(command, input, handlers),
  });
}

function formatState(state: AgentSessionState): string {
  const phase: AgentSessionPhase = state.phase;
  return [
    `phase=${phase}`,
    `busy=${state.isBusy}`,
    `queued=${state.queuedOperationCount}`,
    `internalSessionId=${state.internalSessionId ?? "(none)"}`,
    `mode=${state.mode}`,
  ].join(" ");
}
