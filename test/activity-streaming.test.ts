// End-to-end: a real ACP conversation with a fake agent that runs a command through the
// CLIENT's terminal. Covers the whole activity path — terminal/* handlers, tool_call_update
// passthrough, terminal output enrichment, and unknown session updates.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { AcpClient } from "../src/client.ts";
import type { ActivityEvent, ToolActivity, ToolUpdateActivity } from "../src/types.ts";

const AGENT = resolve(import.meta.dir, "fixtures/terminal-agent.ts");

async function runTurn(): Promise<{ events: ActivityEvent[]; text: string; raw: unknown[] }> {
  const client = new AcpClient({
    adapter: { command: ["bun", AGENT] },
    cwd: import.meta.dir,
  });
  await client.connect();
  await client.startSession();

  const events: ActivityEvent[] = [];
  const raw: unknown[] = [];
  try {
    const result = await client.prompt("run it", {
      onActivity: (e) => events.push(e),
      onUpdate: (n) => raw.push(n),
    });
    return { events, text: result.text, raw };
  } finally {
    await client.stop();
  }
}

describe("activity streaming", () => {
  test("streams a terminal tool call end to end", async () => {
    const { events, text } = await runTurn();

    expect(text).toBe("done");

    const started = events.find((e): e is ToolActivity => e.kind === "tool")!;
    expect(started).toMatchObject({
      toolCallId: "call-1",
      title: "Terminal",
      toolKind: "execute",
      status: "pending",
    });

    const updates = events.filter((e): e is ToolUpdateActivity => e.kind === "tool_update");
    expect(updates.length).toBe(2);

    // The in-progress update carries the command AND a live terminal whose output we
    // resolved for the caller — the agent only ever sent us a terminalId.
    const [inProgress, completed] = updates as [ToolUpdateActivity, ToolUpdateActivity];
    expect(inProgress.status).toBe("in_progress");
    expect(inProgress.rawInput).toEqual({ command: "printf 'hello from terminal'" });
    const terminal = inProgress.content?.[0];
    expect(terminal?.type).toBe("terminal");
    if (terminal?.type === "terminal") {
      expect(terminal.terminalId).toBeTruthy();
      expect(terminal.output).toBeString();
    }

    // The final update carries the tool's actual output.
    expect(completed.status).toBe("completed");
    const block = completed.content?.[0];
    expect(block?.type).toBe("content");
    if (block?.type === "content") expect(block.text).toBe("hello from terminal");
    expect(completed.locations).toEqual([{ path: "/tmp/example.txt", line: 3 }]);

    // Absent fields stay absent: the agent never re-sent the title, so we must not
    // invent one (the caller merges onto the tool call it already has).
    expect("title" in completed).toBe(false);
  });

  test("forwards unmodelled updates instead of dropping them", async () => {
    const { events } = await runTurn();

    const unknown = events.find((e) => e.kind === "unknown");
    expect(unknown).toMatchObject({ kind: "unknown", sessionUpdate: "some_future_update" });

    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toMatchObject({ kind: "usage", used: 120, size: 200000 });
  });

  test("onUpdate sees every raw notification of the turn", async () => {
    const { raw } = await runTurn();
    const kinds = raw.map((n) => (n as any).update?.sessionUpdate);
    expect(kinds).toEqual([
      "tool_call",
      "tool_call_update",
      "tool_call_update",
      "some_future_update",
      "usage_update",
      "agent_message_chunk",
    ]);
  });
});
