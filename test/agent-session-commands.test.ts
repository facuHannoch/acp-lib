import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { AgentSession, type AgentSessionNotification } from "../src/agent-session.ts";

const AGENT = resolve(import.meta.dir, "../smoke-tests/test5-operations/operations-agent.ts");
const live = new Set<AgentSession>();

afterEach(async () => {
  await Promise.allSettled([...live].map((session) => session.stop()));
  live.clear();
});

async function createSession(): Promise<AgentSession> {
  const session = await AgentSession.create({
    adapter: { command: ["bun", AGENT, "commands-test"] },
    adapterId: "fake",
  });
  live.add(session);
  return session;
}

describe("AgentSession harness commands", () => {
  test("exposes immutable metadata and notifies only semantic active-session changes", async () => {
    const session = await createSession();
    expect(session.internalSessionCommands).toEqual([
      { name: "status", description: "Return deterministic fake status." },
    ]);
    expect(Object.isFrozen(session.internalSessionCommands)).toBe(true);

    const notifications: AgentSessionNotification[] = [];
    session.subscribe((notification) => notifications.push(notification));
    await session.prompt("advertise more commands");

    expect(session.internalSessionCommands).toEqual([
      { name: "status", description: "Return deterministic fake status." },
      {
        name: "usage",
        description: "Return deterministic fake usage.",
        input: { kind: "unstructured", hint: "optional scope" },
      },
    ]);
    expect(session.internalSessionCommands.some((command) => command.name === "stale")).toBe(false);
    expect(Object.isFrozen(session.internalSessionCommands[1]!.input!)).toBe(true);

    const changes = notifications.filter((notification) =>
      notification.event.kind === "internal_session_commands_changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.event).toMatchObject({
      kind: "internal_session_commands_changed",
      commands: session.internalSessionCommands,
    });
  });

  test("executes commands as queued prompt turns, including raw input", async () => {
    const session = await createSession();
    const kinds: string[] = [];
    session.subscribe((notification) => kinds.push(notification.event.kind));

    await expect(session.executeInternalSessionCommand("status")).resolves.toMatchObject({
      text: expect.stringContaining("FAKE_STATUS"),
    });
    await expect(session.executeInternalSessionCommand("usage", "workspace")).resolves.toMatchObject({
      text: expect.stringContaining("FAKE_USAGE"),
    });

    expect(kinds.filter((kind) => kind === "turn_started")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "turn_completed")).toHaveLength(2);
  });

  test("rejects ambiguous command names without contacting the harness", async () => {
    const session = await createSession();
    await expect(session.executeInternalSessionCommand("")).rejects.toThrow("internal session command name");
    await expect(session.executeInternalSessionCommand("/status")).rejects.toThrow("leading slash");
    await expect(session.executeInternalSessionCommand("bad name")).rejects.toThrow("whitespace");
    expect(session.state.phase).toBe("idle");
  });
});
