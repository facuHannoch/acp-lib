import { describe, expect, test } from "bun:test";
import {
  createAgentSessionCommands,
  type InteractiveAgentSession,
} from "../src/repl/agent-session-commands.ts";
import { dispatchReplInput, parseReplInput } from "../src/repl/repl.ts";
import type { HandoffOptions } from "../src/agent-session.ts";

function makeSession(overrides: Partial<InteractiveAgentSession> = {}): InteractiveAgentSession {
  const base: InteractiveAgentSession = {
    agentSessionId: "logical-1",
    internalSessionId: "provider-1",
    adapterId: "codex",
    mode: "normal",
    state: {
      phase: "idle",
      isBusy: false,
      queuedOperationCount: 0,
      agentSessionId: "logical-1",
      internalSessionId: "provider-1",
      adapterId: "codex",
      mode: "normal",
    },
    isBusy: false,
    queuedOperationCount: 0,
    transcriptPath: "/chats/logical-1.jsonl",
    internalSessionCommands: [],
    prompt: async () => ({ text: "", stopReason: "end_turn", status: "completed", usage: null }),
    executeInternalSessionCommand: async () => ({
      text: "",
      stopReason: "end_turn",
      status: "completed",
      usage: null,
    }),
    handoff: async () => ({
      handoffId: "handoff-1",
      agentSessionId: "logical-1",
      fromInternalSessionId: "provider-1",
      toInternalSessionId: "provider-2",
      summary: "summary",
    }),
    bridge: async () => {},
    interrupt: () => {},
    stop: async () => {},
  };
  return { ...base, ...overrides };
}

async function runLocal(
  session: InteractiveAgentSession,
  command: string,
  args: string[] = [],
): Promise<{ handled: boolean; output: string }> {
  const lines: string[] = [];
  const handlers = createAgentSessionCommands({ session, note: (line) => lines.push(line) });
  return {
    handled: await handlers.onSlashCommand(command, args),
    output: lines.join("\n"),
  };
}

describe("REPL input namespaces", () => {
  test("ordinary text, local commands, and internal commands are distinct syntax", () => {
    expect(parseReplInput("explain this code")).toEqual({
      kind: "prompt",
      text: "explain this code",
    });
    expect(parseReplInput("/handoff keep this context")).toEqual({
      kind: "local_command",
      command: "handoff",
      args: ["keep", "this", "context"],
    });
    expect(parseReplInput("//usage workspace totals")).toEqual({
      kind: "internal_session_command",
      command: "usage",
      input: "workspace totals",
    });
    expect(parseReplInput("/exit")).toEqual({ kind: "exit" });
  });

  test("an unknown /command remains local and cannot become a prompt", () => {
    const parsed = parseReplInput("/usage");
    expect(parsed).toEqual({ kind: "local_command", command: "usage", args: [] });
    expect(parsed.kind).not.toBe("prompt");
  });

  test("// requires an explicit internal-session command name", () => {
    expect(parseReplInput("//")).toEqual({
      kind: "internal_session_command",
      command: "",
    });
  });

  test("dispatch never falls through from an unknown local command to prompt", async () => {
    const calls: string[] = [];
    await dispatchReplInput(parseReplInput("/usage"), {
      prompt: async (text) => calls.push(`prompt:${text}`),
      localCommand: async (command) => {
        calls.push(`local:${command}`);
        return false;
      },
      internalSessionCommand: async (command) => calls.push(`internal:${command}`),
      unknownLocalCommand: (command) => calls.push(`unknown:${command}`),
      missingInternalSessionCommand: () => calls.push("missing-internal"),
    });
    expect(calls).toEqual(["local:usage", "unknown:usage"]);
  });

  test("dispatch sends // only through the internal-session action", async () => {
    const calls: string[] = [];
    await dispatchReplInput(parseReplInput("//usage workspace"), {
      prompt: async (text) => calls.push(`prompt:${text}`),
      localCommand: async (command) => {
        calls.push(`local:${command}`);
        return false;
      },
      internalSessionCommand: async (command, input) =>
        calls.push(`internal:${command}:${input}`),
      unknownLocalCommand: (command) => calls.push(`unknown:${command}`),
      missingInternalSessionCommand: () => calls.push("missing-internal"),
    });
    expect(calls).toEqual(["internal:usage:workspace"]);
  });
});

describe("single-AgentSession local commands", () => {
  test("help contains only one-session operations and explains // routing", async () => {
    const { handled, output } = await runLocal(makeSession(), "help");
    expect(handled).toBe(true);
    expect(output).toContain("/session");
    expect(output).toContain("/handoff");
    expect(output).toContain("//name");
    expect(output).not.toContain("/new");
    expect(output).not.toContain("/load");
    expect(output).not.toContain("/sessions");
  });

  test("session and state expose both identity layers without changing either", async () => {
    const session = makeSession();
    const identity = await runLocal(session, "session");
    const state = await runLocal(session, "state");
    expect(identity.output).toContain("agentSessionId=logical-1");
    expect(identity.output).toContain("internalSessionId=provider-1");
    expect(identity.output).toContain("transcript=/chats/logical-1.jsonl");
    expect(state.output).toContain("phase=idle");
    expect(state.output).toContain("queued=0");
  });

  test("commands renders ACP metadata as explicit // invocations", async () => {
    const session = makeSession({
      internalSessionCommands: [
        { name: "status", description: "Show status" },
        {
          name: "usage",
          description: "Show usage",
          input: { kind: "unstructured", hint: "optional scope" },
        },
      ],
    });
    const { output } = await runLocal(session, "commands");
    expect(output).toContain("//status — Show status");
    expect(output).toContain("//usage optional scope — Show usage");
  });

  test("handoff forwards an optional summary to the same AgentSession", async () => {
    let received: HandoffOptions | undefined;
    const session = makeSession({
      handoff: async (options) => {
        received = options;
        return {
          handoffId: "handoff-1",
          agentSessionId: "logical-1",
          fromInternalSessionId: "provider-1",
          toInternalSessionId: "provider-2",
          summary: options?.summary ?? "generated",
        };
      },
    });
    const { output } = await runLocal(session, "handoff", ["portable", "context"]);
    expect(received).toEqual({ summary: "portable context" });
    expect(output).toContain("provider-1 -> provider-2");
    expect(session.agentSessionId).toBe("logical-1");
  });

  test("unknown commands remain unhandled for the REPL to reject locally", async () => {
    const { handled } = await runLocal(makeSession(), "usage");
    expect(handled).toBe(false);
  });
});
